/* ============================================================================
   server/logger.js — one JSON line per event, safe to ship to any log sink.

   Guest messages are never logged verbatim: only their length. Values whose
   key looks like a secret are replaced, and long strings are cut, so an
   upstream error body cannot smuggle a key or a transcript into the logs.
   ============================================================================ */

"use strict";

const SECRET_KEY = /key|token|secret|password|authorization|apikey/i;

function scrub(value, depth = 0){
  if (value == null || depth > 4) return value;
  if (typeof value === "string") return value.length > 300 ? value.slice(0, 300) + "…" : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => scrub(v, depth + 1));
  if (typeof value === "object"){
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
    return out;
  }
  return value;
}

function createLogger(base = {}, sink = console){
  function emit(level, event, fields){
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...scrub(base), ...scrub(fields || {}) });
    (level === "error" ? sink.error : level === "warn" ? sink.warn : sink.log).call(sink, line);
  }
  return {
    info:  (event, fields) => emit("info", event, fields),
    warn:  (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (more) => createLogger({ ...base, ...more }, sink)
  };
}

/* For tests: swallows everything but remembers it. */
function memoryLogger(){
  const lines = [];
  const sink = { log: l => lines.push(JSON.parse(l)), warn: l => lines.push(JSON.parse(l)), error: l => lines.push(JSON.parse(l)) };
  const log = createLogger({}, sink);
  log.lines = lines;
  return log;
}

module.exports = { createLogger, memoryLogger, scrub };
