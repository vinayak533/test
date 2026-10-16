"use strict";

/* HTTP-level guards in server/app.js. Fake credentials: every case here is
   rejected before any network call is made. */

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.JEV_API_KEY = "test-jev-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleRequest } = require("../server/app");

const JSON_H = { "content-type": "application/json" };

test("GET is 405", async () => {
  assert.equal((await handleRequest({ method: "GET" })).status, 405);
});

test("non-JSON is 415", async () => {
  assert.equal((await handleRequest({ method: "POST", headers: { "content-type": "text/plain" }, bodyText: "hi" })).status, 415);
});

test("oversized body is 413", async () => {
  assert.equal((await handleRequest({ method: "POST", headers: JSON_H, bodyText: JSON.stringify({ message: "x".repeat(9000) }) })).status, 413);
});

test("malformed JSON is 400", async () => {
  const r = await handleRequest({ method: "POST", headers: JSON_H, bodyText: "{nope", clientIp: "a" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_json");
});

test("a JSON array is 400", async () => {
  assert.equal((await handleRequest({ method: "POST", headers: JSON_H, bodyText: "[]", clientIp: "b" })).status, 400);
});

test("rate limit: the 31st request in a minute from one address is 429", async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await handleRequest({ method: "POST", headers: JSON_H, bodyText: "{nope", clientIp: "flood" });
  assert.equal(last.status, 429);
});

test("errors never echo secrets", async () => {
  const r = await handleRequest({ method: "POST", headers: JSON_H, bodyText: "{nope", clientIp: "c" });
  assert.ok(!JSON.stringify(r).includes("test-service-key"));
});
