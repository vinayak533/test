/* ============================================================================
   server/config.js — environment, read once and validated.

   Every secret is read here and nowhere else, so a grep for process.env
   shows the whole surface. Nothing in this folder is ever sent to a browser.
   ============================================================================ */

"use strict";

function int(name, fallback, min, max){
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}–${max}`);
  return n;
}

function num(name, fallback){
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} must be a number 0–1`);
  return n;
}

/* Jev is reachable two ways: TypeSafe's own choice API (a TypeSafe key) or
   OpenRouter's "typesafe/jev-router" (an OpenRouter key, sk-or-…). The key
   decides unless JEV_PROVIDER says otherwise, and a base URL or model name
   that belongs to the other provider is replaced by this one's default, so
   swapping the key is all it takes. */
function jevEndpoint(){
  const key = process.env.JEV_API_KEY || "";
  const provider = (process.env.JEV_PROVIDER || (key.startsWith("sk-or-") ? "openrouter" : "typesafe")).toLowerCase();
  const base = (process.env.JEV_BASE_URL || "").replace(/\/+$/, "");
  const model = process.env.JEV_MODEL || "";
  if (provider === "openrouter"){
    return {
      jevProvider: "openrouter",
      jevBaseUrl: base.includes("openrouter.ai") ? base : "https://openrouter.ai/api/v1",
      jevModel: model.includes("/") ? model : "typesafe/jev-router"
    };
  }
  if (provider !== "typesafe") throw new Error("JEV_PROVIDER must be typesafe or openrouter");
  return {
    jevProvider: "typesafe",
    jevBaseUrl: base && !base.includes("openrouter.ai") ? base : "https://api.typesafe.ai",
    jevModel: model && !model.includes("/") ? model : "jev-1.13.0"
  };
}

function loadConfig(){
  return Object.freeze({
    supabaseUrl:        process.env.SUPABASE_URL || "",
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    // Public by design (RLS does the protecting); served to the admin
    // dashboard by GET /api/config so it can sign staff in.
    supabaseAnonKey:    process.env.SUPABASE_ANON_KEY || "",
    // Signs the booking conversation's state. Falls back to a value derived
    // from the service-role key, so it is never empty where the server works.
    chatStateSecret:    process.env.CHAT_STATE_SECRET || "",
    dbTimeoutMs:        int("SUPABASE_TIMEOUT_MS", 5000, 500, 30000),

    jevApiKey:   process.env.JEV_API_KEY || "",
    ...jevEndpoint(),
    jevTimeoutMs: int("JEV_TIMEOUT_MS", 4000, 200, 15000),
    jevRetries:   int("JEV_MAX_RETRIES", 2, 0, 5),
    // When Jev is unreachable or rejects the key, fall back to the
    // deterministic keyword classifier instead of failing the turn.
    // "rules" (default) or "off".
    nluFallback: (process.env.NLU_FALLBACK || "rules").toLowerCase(),

    // Calibrated-probability thresholds for accepting Jev's answers.
    intentThreshold: num("JEV_INTENT_THRESHOLD", 0.6),
    hotelThreshold:  num("JEV_HOTEL_THRESHOLD", 0.6),

    hotelTimezone:  process.env.HOTEL_TIMEZONE || "Asia/Kolkata",
    // The hotel this site belongs to. Used when the guest names no hotel.
    defaultHotelId: process.env.DEFAULT_HOTEL_ID || "misty_mountain",

    // Holding and confirming rooms needs a signed-in guest account, so every
    // booking belongs to someone. Asking questions and checking availability
    // stay open. "false" turns the requirement off (local testing only).
    bookingRequiresSignIn: (process.env.BOOKING_REQUIRES_SIGN_IN || "true").toLowerCase() !== "false",

    maxMessageChars: int("MAX_MESSAGE_CHARS", 500, 50, 4000),
    maxStayNights:   int("MAX_STAY_NIGHTS", 30, 1, 365),
    maxDaysAhead:    int("MAX_DAYS_AHEAD", 540, 1, 1095)
  });
}

module.exports = { loadConfig };
