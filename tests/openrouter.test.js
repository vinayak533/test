"use strict";

/* Jev through OpenRouter: the request it sends, how it reads answers and
   errors, which provider a key selects, and that booking steps skip it. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createOpenRouterJevClient } = require("../server/jev/openrouter");
const { JevError } = require("../server/jev/client");
const { classify, buildQuestions } = require("../server/nlu/classify");
const { memoryLogger } = require("../server/logger");
const { conversation } = require("./helpers");

const HOTELS = [{ id: "misty_mountain", name: "Misty Mountain", aliases: ["misty"] }];

function fakeFetch(...responses){
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r.status < 300, status: r.status, statusText: "", json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const reply = content => ({ status: 200, body: { model: "z-ai/glm-5.3-flash", choices: [{ message: { content } }], usage: { prompt_tokens: 400, completion_tokens: 30, cost: 0.00002 } } });
const client = (fetchImpl, extra = {}) => createOpenRouterJevClient({ apiKey: "sk-or-v1-test", fetchImpl, timeoutMs: 500, maxRetries: 2, log: memoryLogger(), ...extra });
const good = JSON.stringify({ intent: { choice: "check_room_availability", confidence: 0.96 }, hotel: { choice: "none", confidence: 0.9 } });

test("sends a strict JSON-schema request to typesafe/jev-router, options as enums", async () => {
  const f = fakeFetch(reply(good));
  await client(f).ask({ guest_message: "free rooms?" }, buildQuestions(HOTELS));
  const { url, init, body } = f.calls[0];
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(init.headers.Authorization, "Bearer sk-or-v1-test");
  assert.equal(body.model, "typesafe/jev-router");
  assert.equal(body.temperature, 0);
  const schema = body.response_format.json_schema;
  assert.equal(schema.strict, true);
  assert.deepEqual(schema.schema.required, ["intent", "hotel"]);
  assert.ok(schema.schema.properties.intent.properties.choice.enum.includes("list_hotels"));
  assert.deepEqual(schema.schema.properties.hotel.properties.choice.enum, ["misty_mountain", "none", "other_hotel"]);
  assert.match(body.messages[1].content, /the guest names Misty Mountain/, "option descriptions are sent");
});

test("a valid answer goes through classify() unchanged", async () => {
  const out = await classify("free rooms?", HOTELS, { jev: client(fakeFetch(reply(good))) });
  assert.equal(out.source, "jev");
  assert.deepEqual(out.intent, { name: "check_room_availability", confidence: 0.96 });
  assert.equal(out.hotel.kind, "none");
});

test("JSON wrapped in prose or a code fence is still read", async () => {
  const out = await classify("free rooms?", HOTELS, { jev: client(fakeFetch(reply("Sure!\n```json\n" + good + "\n```"))) });
  assert.equal(out.source, "jev");
});

test("an invented option, garbage, or a missing confidence falls back to the rules", async () => {
  for (const content of [
    JSON.stringify({ intent: { choice: "book_spa", confidence: 0.9 }, hotel: { choice: "none", confidence: 0.9 } }),
    JSON.stringify({ intent: { choice: "list_hotels", confidence: 0.9 }, hotel: { choice: "taj", confidence: 0.9 } }),
    JSON.stringify({ intent: { choice: "list_hotels" }, hotel: { choice: "none", confidence: 0.9 } }),
    "I think the guest wants a room."
  ]){
    const out = await classify("which hotels are available?", HOTELS, { jev: client(fakeFetch(reply(content))) });
    assert.equal(out.source, "rules", content);
    assert.equal(out.intent.name, "list_hotels");
  }
});

test("401 / 402 are auth errors and are not retried; 429 and 5xx are", async () => {
  for (const status of [401, 402]){
    const f = fakeFetch({ status, body: { error: { message: "no" } } });
    await assert.rejects(client(f).ask("s", buildQuestions(HOTELS)), e => e instanceof JevError && e.kind === "auth");
    assert.equal(f.calls.length, 1);
  }
  const f = fakeFetch({ status: 429, body: {} }, { status: 502, body: {} }, reply(good));
  const answers = await client(f).ask("s", buildQuestions(HOTELS));
  assert.equal(f.calls.length, 3);
  assert.equal(answers.intent.choice, "check_room_availability");
});

test("a timeout is a timeout, not retried", async () => {
  const slow = async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
  await assert.rejects(client(slow).ask("s", buildQuestions(HOTELS)), e => e.kind === "timeout");
});

test("the key picks the provider; a stale base URL or model is replaced", () => {
  const saved = { ...process.env };
  const { loadConfig } = require("../server/config");
  Object.assign(process.env, { JEV_API_KEY: "sk-or-v1-abc", JEV_BASE_URL: "https://api.typesafe.ai", JEV_MODEL: "jev-1.13.0" });
  delete process.env.JEV_PROVIDER;
  let c = loadConfig();
  assert.deepEqual([c.jevProvider, c.jevBaseUrl, c.jevModel], ["openrouter", "https://openrouter.ai/api/v1", "typesafe/jev-router"]);
  Object.assign(process.env, { JEV_API_KEY: "ts_live_abc", JEV_BASE_URL: "https://openrouter.ai/api/v1", JEV_MODEL: "typesafe/jev-router" });
  c = loadConfig();
  assert.deepEqual([c.jevProvider, c.jevBaseUrl, c.jevModel], ["typesafe", "https://api.typesafe.ai", "jev-1.13.0"]);
  Object.assign(process.env, { JEV_API_KEY: "sk-or-v1-abc", JEV_PROVIDER: "openrouter", JEV_MODEL: "openai/gpt-4o-mini" });
  assert.equal(loadConfig().jevModel, "openai/gpt-4o-mini");
  process.env = saved;
});

test("mid-booking answers are read by the flow without a Jev round trip", async () => {
  let calls = 0;
  const jev = { ask: async () => { calls++; return { intent: { choice: "check_room_availability", confidence: 0.95 }, hotel: { choice: "none", confidence: 0.9 } }; } };
  const c = conversation({ jev });
  await c.say("got anything free?");
  assert.equal(calls, 1, "the opening message is classified");
  await c.say("20 oct");
  await c.say("2 PM");
  await c.say("22 oct");
  await c.say("2 guests 1 room");
  assert.equal(calls, 1, "booking answers are not");
  const side = await c.say("is breakfast included?");
  assert.equal(side.handled, false);
  assert.equal(calls, 2, "a side question still is");
  const hotels = await c.say("which other hotels do you have?");
  assert.match(hotels.reply, /only hotel available on this platform/, "hotel questions still interrupt a booking");
});
