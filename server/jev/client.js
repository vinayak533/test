/* ============================================================================
   server/jev/client.js — HTTP client for Jev, TypeSafe's hosted classifier.

   Verified against Pipecat's reference client (pipecat-ai/pipecat,
   src/pipecat/classifiers/typesafe/jev/client.py), October 2026:

     POST {base}/v1/systemone
     Authorization: Bearer <key>
     { "model": "jev-1.13.0",
       "state": <string | object>,
       "questions": { "<name>": { "type": "choice" | "noul" | "score",
                                  "instructions": "...",
                                  "criteria": { "<option>": "<when it applies>" } } } }
     → { "answers": { "<name>": { "choice": "...", "confidence": 0.93,
                                  "probabilities": { "<option>": 0.93, ... } } },
         "usage": { "input_tokens": n, "output_tokens": n } }

     Errors: { "detail": { "error_type": "...", "message": "..." } }
     429 (rate limited) and 529 (overloaded) are retryable.

   Jev returns calibrated probabilities over the options you give it; it never
   writes free text, so it cannot invent an availability figure.
   Latency is NOT assumed: every call is timed and logged, and bounded by
   JEV_TIMEOUT_MS.
   ============================================================================ */

"use strict";

class JevError extends Error {
  constructor(kind, message, status){
    super(message);
    this.kind = kind;          // auth | rejected | busy | timeout | network | bad_response
    this.status = status;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createJevClient({ apiKey, baseUrl, model, timeoutMs = 4000, maxRetries = 2, fetchImpl = fetch, log }){
  if (!apiKey) throw new JevError("auth", "JEV_API_KEY is not set");

  async function ask(state, questions){
    const body = JSON.stringify({ model, state, questions });
    let attempt = 0;
    for (;;){
      const started = Date.now();
      let res;
      try {
        res = await fetchImpl(baseUrl + "/v1/systemone", {
          method: "POST",
          headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (e){
        const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
        log && log.warn("jev.request_failed", { attempt, ms: Date.now() - started, kind: timedOut ? "timeout" : "network" });
        if (attempt < maxRetries && !timedOut){ attempt++; await sleep(backoff(attempt)); continue; }
        throw new JevError(timedOut ? "timeout" : "network", timedOut ? `Jev did not answer within ${timeoutMs} ms` : "Jev could not be reached");
      }

      const ms = Date.now() - started;
      let payload = null;
      try { payload = await res.json(); } catch { /* handled below */ }

      if (res.ok){
        if (!payload || typeof payload.answers !== "object" || payload.answers === null){
          throw new JevError("bad_response", "Jev response has no answers object", res.status);
        }
        log && log.info("jev.ok", { ms, attempt, usage: payload.usage || null });
        return payload.answers;
      }

      const detail = payload && payload.detail;
      const message = (detail && typeof detail === "object" ? detail.message : detail) || res.statusText;
      log && log.warn("jev.http_error", { status: res.status, ms, attempt, error_type: detail && detail.error_type });

      if (RETRYABLE.has(res.status) && attempt < maxRetries){ attempt++; await sleep(backoff(attempt)); continue; }
      if (res.status === 401 || res.status === 403) throw new JevError("auth", "Jev rejected the API key: " + message, res.status);
      if (RETRYABLE.has(res.status)) throw new JevError("busy", "Jev is busy: " + message, res.status);
      throw new JevError("rejected", "Jev rejected the request: " + message, res.status);
    }
  }

  return { ask };
}

/* 250 ms, 500 ms, 1 s … capped at 2 s, with jitter. Mirrors Pipecat's client. */
function backoff(attempt){
  return Math.min(2000, 250 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
}

module.exports = { createJevClient, JevError };
