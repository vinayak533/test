"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createJevClient, JevError } = require("../server/jev/client");
const { classify, classifyWithRules, buildQuestions } = require("../server/nlu/classify");
const { memoryLogger } = require("../server/logger");

const HOTELS = [{ id: "misty_mountain", name: "Misty Mountain Plantation Resort", aliases: ["misty mountain"] }];

function fakeFetch(...responses){
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r.status < 300, status: r.status, statusText: "", json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const client = (fetchImpl, extra = {}) =>
  createJevClient({ apiKey: "k", baseUrl: "https://jev.test", model: "jev-1.13.0", timeoutMs: 200, maxRetries: 2, fetchImpl, ...extra });

/* ---- client ---------------------------------------------------------------- */

test("sends the documented request shape", async () => {
  const f = fakeFetch({ status: 200, body: { answers: { a: { choice: "x", confidence: 0.9 } } } });
  await client(f).ask({ guest_message: "hi" }, { a: { type: "choice", instructions: "?", criteria: { x: null } } });
  const { url, init } = f.calls[0];
  assert.equal(url, "https://jev.test/v1/systemone");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer k");
  assert.deepEqual(Object.keys(JSON.parse(init.body)), ["model", "state", "questions"]);
});

test("401 is an auth error and is not retried", async () => {
  const f = fakeFetch({ status: 401, body: { detail: { error_type: "authentication_error", message: "bad key" } } });
  await assert.rejects(client(f).ask("s", {}), e => e instanceof JevError && e.kind === "auth" && e.status === 401);
  assert.equal(f.calls.length, 1);
});

test("429 and 529 are retried, then succeed", async () => {
  const f = fakeFetch({ status: 429, body: {} }, { status: 529, body: {} }, { status: 200, body: { answers: {} } });
  assert.deepEqual(await client(f).ask("s", {}), {});
  assert.equal(f.calls.length, 3);
});

test("still busy after retries is a busy error", async () => {
  const f = fakeFetch({ status: 529, body: { detail: "overloaded" } });
  await assert.rejects(client(f).ask("s", {}), e => e.kind === "busy");
  assert.equal(f.calls.length, 3);
});

test("a timeout is reported as a timeout and not retried", async () => {
  const err = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const f = fakeFetch(err);
  await assert.rejects(client(f).ask("s", {}), e => e.kind === "timeout");
  assert.equal(f.calls.length, 1);
});

test("a real slow server is cut off at the timeout", async () => {
  const slow = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  const t = Date.now();
  await assert.rejects(client(slow, { timeoutMs: 100 }).ask("s", {}), e => e.kind === "timeout");
  assert.ok(Date.now() - t < 1000);
});

test("a 200 without answers is a bad response", async () => {
  await assert.rejects(client(fakeFetch({ status: 200, body: { nope: 1 } })).ask("s", {}), e => e.kind === "bad_response");
});

test("no API key fails at construction", () => {
  assert.throws(() => createJevClient({ apiKey: "", baseUrl: "x", model: "m" }), JevError);
});

/* ---- questions and validation ---------------------------------------------- */

test("hotel options come from the database rows plus none/other", () => {
  const q = buildQuestions(HOTELS);
  assert.deepEqual(Object.keys(q.hotel.criteria), ["misty_mountain", "none", "other_hotel"]);
  assert.equal(q.intent.type, "choice");
  assert.ok("check_room_availability" in q.intent.criteria);
});

const jevAnswering = (answers) => ({ ask: async () => answers });

test("a valid Jev answer is used as-is", async () => {
  const out = await classify("x", HOTELS, { jev: jevAnswering({
    intent: { choice: "check_room_availability", confidence: 0.93 },
    hotel: { choice: "misty_mountain", confidence: 0.88 }
  }) });
  assert.equal(out.source, "jev");
  assert.deepEqual(out.intent, { name: "check_room_availability", confidence: 0.93 });
  assert.deepEqual(out.hotel, { kind: "known", id: "misty_mountain", confidence: 0.88 });
});

test("confidence may come from probabilities", async () => {
  const out = await classify("x", HOTELS, { jev: jevAnswering({
    intent: { choice: "general_question", probabilities: { general_question: 0.7 } },
    hotel: { choice: "none", confidence: 0.9 }
  }) });
  assert.equal(out.intent.confidence, 0.7);
  assert.equal(out.hotel.kind, "none");
});

for (const [label, answers] of [
  ["an invented hotel id", { intent: { choice: "check_room_availability", confidence: 0.9 }, hotel: { choice: "hotel_blue", confidence: 0.9 } }],
  ["an invented intent", { intent: { choice: "drop_tables", confidence: 0.9 }, hotel: { choice: "none", confidence: 0.9 } }],
  ["a confidence above 1", { intent: { choice: "check_room_availability", confidence: 7 }, hotel: { choice: "none", confidence: 0.9 } }],
  ["a missing answer", { intent: { choice: "check_room_availability", confidence: 0.9 } }]
]){
  test(`Jev output with ${label} is rejected and the rules take over`, async () => {
    const log = memoryLogger();
    const out = await classify("rooms available at hotel blue tonight", HOTELS, { jev: jevAnswering(answers), log });
    assert.equal(out.source, "rules");
    assert.ok(log.lines.some(l => l.event === "nlu.jev_failed" && l.kind === "bad_response"));
  });
}

test("with the fallback off, a Jev failure propagates", async () => {
  const jev = { ask: async () => { throw new JevError("auth", "bad key", 401); } };
  await assert.rejects(classify("x", HOTELS, { jev, fallback: "off" }), JevError);
});

test("a non-Jev bug is not swallowed by the fallback", async () => {
  const jev = { ask: async () => { throw new TypeError("bug"); } };
  await assert.rejects(classify("x", HOTELS, { jev }), TypeError);
});

/* ---- rules ------------------------------------------------------------------- */

test("rules: intents", () => {
  const i = m => classifyWithRules(m, HOTELS).intent.name;
  assert.equal(i("Do you have any rooms available tonight?"), "check_room_availability");
  assert.equal(i("is the resort fully booked this weekend"), "check_room_availability");
  assert.equal(i("I'd like to book a chalet"), "make_reservation");
  assert.equal(i("how do I cancel my booking"), "cancel_reservation");
  assert.equal(i("what time is breakfast"), "general_question");
});

test("rules: hotels", () => {
  const h = m => classifyWithRules(m, HOTELS).hotel;
  assert.deepEqual(h("rooms at Misty Mountain tonight?"), { kind: "known", id: "misty_mountain", confidence: 0.95 });
  assert.equal(h("Do you have any rooms available at Hotel Blue tonight?").kind, "other");
  assert.equal(h("any rooms at the Taj resort?").kind, "other");
  assert.equal(h("is your hotel full tonight").kind, "none");
  assert.equal(h("is the resort fully booked").kind, "none");
  assert.equal(h("any rooms tonight").kind, "none");
});
