/* ============================================================================
   server/app.js — HTTP-agnostic request handling.

     POST /api/chat     one guest turn (handleRequest); with Accept:
                        application/x-ndjson its steps stream first.
                        mode: "desk" is the staff front-desk assistant
     GET  /api/config   the public Supabase URL and anon key, for the admin
                        dashboard's sign-in (handleConfig)
     GET  /api/hotels   the active hotels' ids and names, for the page's
                        hotel picker (handleHotels)

   Used by the Netlify Functions and by scripts/dev_server.js, so local runs
   and production go through exactly the same checks.
   ============================================================================ */

"use strict";

const crypto = require("crypto");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { InputError, sanitizeLang, isHotelId } = require("./sanitize");
const { createJevClient } = require("./jev/client");
const { createOpenRouterJevClient } = require("./jev/openrouter");
const { createSupabase, createRepository } = require("./db/repository");
const { createStateCodec } = require("./booking/state");
const { handleChat } = require("./chat");

const MAX_BODY_BYTES = 8192;
const RATE = { windowMs: 60_000, max: 30 };          // per client address, per instance
const LOOKUP_FAILS = { windowMs: 15 * 60_000, max: 8 };

let shared = null;
/* Built once per warm instance: the Supabase client, Jev client, state
   codec and the hotel cache are reused across invocations. */
function services(){
  if (shared) return shared;
  const config = loadConfig();
  const log = createLogger({ svc: "chat" });
  const repo = createRepository(createSupabase(config));
  const secret = config.chatStateSecret
    || crypto.createHmac("sha256", config.supabaseServiceKey).update("misty-chat-state-v1").digest("hex");
  const codec = createStateCodec(secret);
  let jev = null;
  try {
    const make = config.jevProvider === "openrouter" ? createOpenRouterJevClient : createJevClient;
    jev = make({
      apiKey: config.jevApiKey, baseUrl: config.jevBaseUrl, model: config.jevModel,
      timeoutMs: config.jevTimeoutMs, maxRetries: config.jevRetries, log
    });
    log.info("jev.configured", { provider: config.jevProvider, model: config.jevModel });
  } catch (e){
    log.warn("jev.not_configured", { error: e.message });
  }
  shared = { config, log, repo, jev, codec };
  return shared;
}

function windowCounter({ windowMs, max }){
  const hits = new Map();
  return {
    add(key){
      const now = Date.now();
      const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) hits.clear();             // bound memory on a long-lived instance
      return recent.length;
    },
    over(key){
      const now = Date.now();
      return (hits.get(key) || []).filter(t => now - t < windowMs).length >= max;
    }
  };
}
const requests = windowCounter(RATE);
const lookupFails = windowCounter(LOOKUP_FAILS);

/* The signed-in guest, from "Authorization: Bearer <access token>". Supabase
   Auth checks every token; the answer is remembered for a minute per token
   (by its hash) so a booking conversation is not one Auth round trip per
   message. Returns { user } — null when signed out or the token is not
   valid — or { authError: true } when Auth could not be asked. */
const USER_CACHE_MS = 60_000;
const userCache = new Map();
async function resolveUser(headers, repo, log){
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(String(headers.authorization || headers.Authorization || ""));
  if (!m) return { user: null };
  const key = crypto.createHash("sha256").update(m[1]).digest("hex");
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return { user: hit.user };
  try {
    const user = await repo.getUser(m[1]);
    if (userCache.size > 2000) userCache.clear();
    userCache.set(key, { at: Date.now(), user });
    return { user };
  } catch (e){
    log.warn("auth.check_failed", { error: e.message });
    return { user: null, authError: true };
  }
}

/* The steps a turn can report while it runs (see booking/flow.js report()).
   The page shows each as it arrives — "Checking room availability…" — so
   only steps that really run are ever named. */
const STAGES = new Set(["understand", "rooms", "availability", "matching", "options", "hold", "confirm", "lookup"]);

/**
 * handleRequest({ method, headers, bodyText, clientIp, onProgress? }) → { status, body, headers? }
 *   onProgress(stage) is called as the turn reaches each of STAGES, before
 *   the result; a caller that cannot stream simply leaves it out.
 */
async function handleRequest({ method, headers = {}, bodyText = "", clientIp = "unknown", onProgress }){
  const requestId = crypto.randomUUID();
  let svc;
  try { svc = services(); }
  catch (e){
    console.error(JSON.stringify({ level: "error", event: "config.invalid", error: e.message, requestId }));
    return { status: 500, body: { error: "server_misconfigured", requestId } };
  }
  const log = svc.log.child({ requestId });

  if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: "POST" } };
  const type = String(headers["content-type"] || "");
  if (!type.toLowerCase().startsWith("application/json")) return { status: 415, body: { error: "json_required" } };
  if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) return { status: 413, body: { error: "too_large" } };
  if (requests.add(clientIp) > RATE.max){
    log.warn("rate_limited");
    return { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "60" } };
  }

  let input;
  try { input = JSON.parse(bodyText); }
  catch { return { status: 400, body: { error: "invalid_json" } }; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return { status: 400, body: { error: "invalid_body" } };
  if (input.state != null && typeof input.state !== "string") return { status: 400, body: { error: "invalid_state" } };
  if (input.hotelId != null && !isHotelId(input.hotelId)) return { status: 400, body: { error: "invalid_hotel" } };
  // "desk": the staff front-desk assistant (server/chat.js handleDesk).
  if (input.mode != null && input.mode !== "desk") return { status: 400, body: { error: "invalid_mode" } };

  const started = Date.now();
  try {
    const { user, authError } = await resolveUser(headers, svc.repo, log);
    const out = await handleChat(
      { message: input.message, action: input.action, state: input.state, hotelId: input.hotelId, lang: sanitizeLang(input.lang), mode: input.mode },
      { ...svc, log, user, authError,
        progress: typeof onProgress === "function" ? stage => { if (STAGES.has(stage)) onProgress(stage); } : undefined,
        lookupLimited: () => lookupFails.over(clientIp),
        lookupFailed:  () => lookupFails.add(clientIp) }
    );
    log.info("chat.done", {
      ms: Date.now() - started, chars: typeof input.message === "string" ? input.message.length : 0,
      action: input.action && typeof input.action === "object" ? String(input.action.type).slice(0, 20) : undefined,
      handled: out.handled, kind: out.kind, intent: out.intent, source: out.source, error: out.error, signedIn: !!user
    });
    return { status: 200, body: { ...out, requestId } };
  } catch (e){
    if (e instanceof InputError){
      log.info("chat.bad_input", { code: e.code });
      return { status: 400, body: { error: e.code, requestId } };
    }
    log.error("chat.unhandled_error", { error: e.message, stack: String(e.stack || "").split("\n").slice(0, 4).join(" | ") });
    return { status: 500, body: { error: "internal_error", requestId } };
  }
}

/* The anon key is meant to be public — RLS is what protects the data — but
   a service-role key pasted into the wrong variable must never be served.
   Both key formats are checked: legacy JWTs carry a role claim, the newer
   keys a sb_publishable_ / sb_secret_ prefix. */
function isPublicKey(key){
  if (!key) return false;
  if (key.startsWith("sb_publishable_")) return true;
  if (key.startsWith("sb_")) return false;
  try {
    const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
    return claims.role === "anon";
  } catch { return false; }
}

function handleConfig({ method }){
  if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: "GET" } };
  let config;
  try { config = loadConfig(); }
  catch { return { status: 500, body: { error: "server_misconfigured" } }; }
  if (!config.supabaseUrl || !isPublicKey(config.supabaseAnonKey)){
    console.error(JSON.stringify({ level: "error", event: "config.public_key_invalid" }));
    return { status: 503, body: { error: "admin_not_configured" } };
  }
  return {
    status: 200,
    body: { supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey, hotelId: config.defaultHotelId },
    headers: { "Cache-Control": "public, max-age=300" }
  };
}

/* The hotels a guest can choose between — public facts only (no contact
   details, nothing about rooms or bookings), read from the hotels table
   through the same short cache /api/chat uses. `site` is the hotel this site
   belongs to: the one the page's own knowledge base describes. */
async function handleHotels({ method }){
  if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: "GET" } };
  let svc;
  try { svc = services(); }
  catch { return { status: 500, body: { error: "server_misconfigured" } }; }
  try {
    const hotels = await svc.repo.listHotels();
    return {
      status: 200,
      body: { site: svc.config.defaultHotelId, hotels: hotels.map(h => ({ id: h.id, name: h.name, address: h.address || null })) },
      headers: { "Cache-Control": "public, max-age=60" }
    };
  } catch (e){
    svc.log.error("hotels.lookup_failed", { error: e.message });
    return { status: 503, body: { error: "hotels_unavailable" } };
  }
}

/* ---- speech to text ---------------------------------------------
   The page records the guest, encodes 16 kHz mono WAV and posts it here;
   the answer is text for the chat field, which the guest reviews and sends
   through POST /api/chat like anything typed. Nothing here books, looks up
   or answers anything, so no check in the chat path is skipped.

   whisper.cpp runs beside this process (server/stt/whisper.js), so this
   works where Node is long-lived — scripts/dev_server.js — and not on
   Netlify Functions, which cannot hold a 175 MB model. There the route does
   not exist and the page keeps the browser's own recognition. Neither the
   audio nor the words are stored or logged: only lengths and timings. */
let whisper = null;
function transcriber(){
  if (!whisper){
    const { createWhisper } = require("./stt/whisper");
    whisper = createWhisper({ log: createLogger({ svc: "stt" }) });
  }
  return whisper;
}
/* For tests: replace the transcriber with a stand-in. */
function setTranscriber(t){ whisper = t; }

const TRANSCRIBE_RATE = { windowMs: 60_000, max: 12 };
const transcribes = windowCounter(TRANSCRIBE_RATE);

/**
 * handleTranscribe({ method, headers, body: Buffer, clientIp }) → { status, body, headers? }
 *   GET  → { available, state, model, language, maxSeconds }
 *   POST → { text } (audio/wav, 16 kHz mono 16-bit, at most 30 s)
 */
async function handleTranscribe({ method, headers = {}, body = Buffer.alloc(0), clientIp = "unknown" }){
  const { parseWav, normalizeWav, MAX_SECONDS, MAX_WAV_BYTES } = require("./stt/wav");
  const stt = transcriber();

  if (method === "GET"){
    return { status: 200, body: { ...stt.status(), maxSeconds: MAX_SECONDS }, headers: { "Cache-Control": "no-store" } };
  }
  if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: "GET, POST" } };
  const type = String(headers["content-type"] || "").toLowerCase();
  if (!/^audio\/(?:x-)?wav\b/.test(type)) return { status: 415, body: { error: "wav_required" } };
  if (body.length > MAX_WAV_BYTES) return { status: 413, body: { error: "too_large" } };
  if (transcribes.add(clientIp) > TRANSCRIBE_RATE.max){
    return { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "60" } };
  }

  let info;
  try { info = parseWav(body); }
  catch (e){
    if (e instanceof InputError) return { status: 400, body: { error: e.code } };
    throw e;
  }
  if (!stt.available()) return { status: 503, body: { error: "stt_unavailable" } };

  const log = createLogger({ svc: "stt", requestId: crypto.randomUUID() });
  const started = Date.now();
  // A quiet microphone is brought up to a standard level first (wav.js).
  // Only the level is logged, never the audio.
  const { wav, peak, gain } = normalizeWav(body, info);
  try {
    const text = await stt.transcribe(wav, info.seconds);
    log.info("stt.done", { ms: Date.now() - started, seconds: Number(info.seconds.toFixed(2)), chars: text.length,
                           peakDb: peak > 0 ? Math.round(20 * Math.log10(peak)) : null, gain: Number(gain.toFixed(1)) });
    return { status: 200, body: { text } };
  } catch (e){
    const code = e.code === "stt_busy" || e.code === "stt_unavailable" ? e.code : "stt_failed";
    log.warn("stt.failed", { code, error: e.message, ms: Date.now() - started });
    if (code === "stt_busy") return { status: 503, body: { error: code }, headers: { "Retry-After": "5" } };
    return { status: code === "stt_unavailable" ? 503 : 502, body: { error: code } };
  }
}

/* Loads the model ahead of the first request, so the first guest to speak
   does not wait for it. Errors are logged by the transcriber itself. */
function warmTranscriber(){
  const stt = transcriber();
  if (!stt.available()) return false;
  stt.start().catch(() => {});
  return true;
}

/* ---- progress over one response ---------------------------------
   A page that sends "Accept: application/x-ndjson" gets the turn as it
   happens: one {"stage":"…"} line per step, then {"status","body"} with
   exactly what the plain JSON response would have carried. Anything
   refused before the turn starts (415, 429, …) never streams, so its
   status and headers reach the page unchanged. */
const wantsProgress = headers => /application\/x-ndjson/i.test(String(headers.accept || headers.Accept || ""));

module.exports = { handleRequest, handleConfig, handleHotels, handleTranscribe, warmTranscriber, setTranscriber, isPublicKey, wantsProgress, STAGES };
