/* ============================================================================
   server/booking/state.js — the conversation's memory, kept by the browser.

   A booking takes a dozen turns, and Netlify Functions keep nothing between
   requests. So the state travels with the conversation: the server signs it
   (HMAC-SHA256), the page holds it in memory only — never in storage — and
   sends it back with the next message. A token that was altered, is too old,
   or is too large is treated as no state at all.

   Signing is integrity, not secrecy: the guest's own answers are in it, and
   they are already on the guest's own screen. Nothing in it is trusted for
   money or inventory — prices and availability are always re-read from the
   database, and a hold can only be confirmed with its token, whose hash is
   all the database keeps.
   ============================================================================ */

"use strict";

const crypto = require("crypto");

const MAX_TOKEN_CHARS = 6000;

function createStateCodec(secret, { ttlMs = 2 * 60 * 60 * 1000, now = () => Date.now() } = {}){
  if (!secret || String(secret).length < 16) throw new Error("chat state secret is missing or too short");
  const key = crypto.createHash("sha256").update(String(secret)).digest();
  const sign = body => crypto.createHmac("sha256", key).update(body).digest("base64url");

  return {
    encode(state){
      if (!state) return null;
      const body = Buffer.from(JSON.stringify({ ...state, iat: now() })).toString("base64url");
      return body + "." + sign(body);
    },
    decode(token){
      if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARS) return null;
      const dot = token.indexOf(".");
      if (dot < 1) return null;
      const body = token.slice(0, dot);
      const mac = Buffer.from(token.slice(dot + 1));
      const want = Buffer.from(sign(body));
      if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
      let state;
      try { state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
      if (!state || typeof state !== "object" || state.v !== 1) return null;
      if (typeof state.iat !== "number" || now() - state.iat > ttlMs || state.iat - now() > 60000) return null;
      delete state.iat;
      return state;
    }
  };
}

/* Hold tokens: the guest's browser keeps the token, the database keeps only
   its SHA-256, so a database read never yields something that can confirm. */
function newHoldToken(){ return crypto.randomBytes(24).toString("base64url"); }
function hashToken(token){ return crypto.createHash("sha256").update(String(token)).digest("hex"); }

module.exports = { createStateCodec, newHoldToken, hashToken };
