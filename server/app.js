/* ============================================================================
   server/app.js — HTTP-agnostic request handling.

     POST /api/chat     one guest turn (handleRequest)
     GET  /api/config   the public Supabase URL and anon key, for the admin
                        dashboard's sign-in (handleConfig)

   Used by the Netlify Functions and by scripts/dev_server.js, so local runs
   and production go through exactly the same checks.
   ============================================================================ */

"use strict";

const crypto = require("crypto");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { InputError, sanitizeLang } = require("./sanitize");
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

/**
 * handleRequest({ method, headers, bodyText, clientIp }) → { status, body, headers? }
 */
async function handleRequest({ method, headers = {}, bodyText = "", clientIp = "unknown" }){
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

  const started = Date.now();
  try {
    const { user, authError } = await resolveUser(headers, svc.repo, log);
    const out = await handleChat(
      { message: input.message, action: input.action, state: input.state, lang: sanitizeLang(input.lang) },
      { ...svc, log, user, authError,
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

module.exports = { handleRequest, handleConfig, isPublicKey };
