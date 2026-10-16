/* ============================================================================
   server/sanitize.js — incoming text and extracted identifiers.
   ============================================================================ */

"use strict";

class InputError extends Error {
  constructor(code, message){ super(message); this.code = code; }
}

/* Normalises a guest message to plain text the classifier and the date
   parser can rely on. Throws InputError for anything that is not a usable
   message, so the HTTP layer can answer 400 without guessing. */
function sanitizeMessage(raw, maxChars){
  if (typeof raw !== "string") throw new InputError("invalid_type", "message must be a string");
  let s = raw.normalize("NFKC");
  // Control and zero-width characters, bidi overrides.
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) throw new InputError("empty", "message is empty");
  if (s.length > maxChars) throw new InputError("too_long", `message is longer than ${maxChars} characters`);
  return s;
}

const HOTEL_ID = /^[a-z0-9_]{2,40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isHotelId(v){ return typeof v === "string" && HOTEL_ID.test(v); }

function isIsoDate(v){
  if (typeof v !== "string" || !ISO_DATE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/* The page's language code, one of the four the panel offers. */
function sanitizeLang(v){
  return ["en", "ml", "hi", "ta"].includes(v) ? v : "en";
}

module.exports = { InputError, sanitizeMessage, isHotelId, isIsoDate, sanitizeLang };
