"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStateCodec, newHoldToken, hashToken } = require("../server/booking/state");
const { isPublicKey, handleConfig } = require("../server/app");

test("state round-trips", () => {
  const c = createStateCodec("0123456789abcdef");
  const s = { v: 1, flow: "booking", checkIn: "2026-10-20" };
  assert.deepEqual(c.decode(c.encode(s)), s);
});

test("tampered, foreign-key, garbage and oversized tokens decode to nothing", () => {
  const c = createStateCodec("0123456789abcdef");
  const t = c.encode({ v: 1, flow: "booking", rooms: 1 });
  const [body, mac] = t.split(".");
  const evil = Buffer.from(JSON.stringify({ v: 1, flow: "booking", rooms: 9 })).toString("base64url");
  assert.equal(c.decode(evil + "." + mac), null);
  assert.equal(createStateCodec("another-secret-xx").decode(t), null);
  assert.equal(c.decode("nope"), null);
  assert.equal(c.decode(body + "." + mac + "x"), null);
  assert.equal(c.decode("a".repeat(7000)), null);
  assert.equal(c.decode(42), null);
});

test("tokens expire", () => {
  let now = 1_000_000;
  const c = createStateCodec("0123456789abcdef", { ttlMs: 1000, now: () => now });
  const t = c.encode({ v: 1 });
  now += 1001;
  assert.equal(c.decode(t), null);
});

test("a short secret is refused", () => {
  assert.throws(() => createStateCodec("short"));
});

test("hold tokens are random and only their hash is stored", () => {
  const a = newHoldToken(), b = newHoldToken();
  assert.notEqual(a, b);
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(a), a);
});

/* ---- GET /api/config never serves a secret key ------------------------- */

const jwt = role => "x." + Buffer.from(JSON.stringify({ role })).toString("base64url") + ".y";

test("only an anon / publishable key counts as public", () => {
  assert.equal(isPublicKey(jwt("anon")), true);
  assert.equal(isPublicKey(jwt("service_role")), false);
  assert.equal(isPublicKey("sb_publishable_abc"), true);
  assert.equal(isPublicKey("sb_secret_abc"), false);
  assert.equal(isPublicKey(""), false);
});

test("config endpoint refuses to serve a service-role key", () => {
  const before = { ...process.env };
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = jwt("service_role");
  assert.equal(handleConfig({ method: "GET" }).status, 503);
  process.env.SUPABASE_ANON_KEY = jwt("anon");
  const ok = handleConfig({ method: "GET" });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ["hotelId", "supabaseAnonKey", "supabaseUrl"]);
  assert.equal(handleConfig({ method: "POST" }).status, 405);
  process.env = before;
});
