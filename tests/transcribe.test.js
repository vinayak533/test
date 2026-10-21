"use strict";

/* POST /api/transcribe: the WAV checks, the transcript clean-up and the HTTP
   guards in server/app.js. The transcriber is a stand-in, so no model is
   needed; the real model is exercised by tests/stt/whisper.test.js. */

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseWav, cleanTranscript, MAX_WAV_BYTES } = require("../server/stt/wav");
const { audioContextFor } = require("../server/stt/whisper");
const { handleTranscribe, setTranscriber } = require("../server/app");

function wav(seconds, { rate = 16000, channels = 1, bits = 16, format = 1 } = {}){
  const bytes = Math.round(seconds * rate) * channels * (bits / 8);
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF", 0); b.writeUInt32LE(36 + bytes, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(format, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * bits / 8, 28); b.writeUInt16LE(channels * bits / 8, 32); b.writeUInt16LE(bits, 34);
  b.write("data", 36); b.writeUInt32LE(bytes, 40);
  return b;
}

function fakeStt(over = {}){
  const calls = [];
  return {
    calls,
    available: () => true,
    status: () => ({ available: true, state: "ready", model: "ggml-small.en-q5_0.bin", language: "en" }),
    start: async () => {},
    transcribe: async (buf, seconds) => { calls.push({ bytes: buf.length, seconds }); return "Book a room at Taj Hotel."; },
    stop: () => {},
    ...over
  };
}
const WAV_H = { "content-type": "audio/wav" };
let ip = 0;
const post = (body, headers = WAV_H) => handleTranscribe({ method: "POST", headers, body, clientIp: "t" + (ip++) });

/* ---- parseWav ---- */

test("parseWav reads 16 kHz mono 16-bit PCM and its length", () => {
  const info = parseWav(wav(2.5));
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bits, 16);
  assert.ok(Math.abs(info.seconds - 2.5) < 1e-6);
});

test("parseWav skips chunks it does not know before the data", () => {
  const plain = wav(1);
  const list = Buffer.alloc(8 + 4); list.write("LIST", 0); list.writeUInt32LE(4, 4); list.write("INFO", 8);
  const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  assert.ok(Math.abs(parseWav(withList).seconds - 1) < 1e-6);
});

test("parseWav refuses anything Whisper would not read as-is", () => {
  const code = b => { try { parseWav(b); return "ok"; } catch (e){ return e.code; } };
  assert.equal(code(Buffer.from("not audio at all, just some text bytes to fill 44")), "invalid_audio");
  assert.equal(code(wav(1, { rate: 44100 })), "invalid_audio");
  assert.equal(code(wav(1, { channels: 2 })), "invalid_audio");
  assert.equal(code(wav(1, { bits: 8 })), "invalid_audio");
  assert.equal(code(wav(1, { format: 3 })), "invalid_audio");          // float
  assert.equal(code(wav(0.1)), "audio_too_short");
  assert.equal(code(wav(31)), "audio_too_long");
});

/* ---- cleanTranscript ---- */

test("non-speech tags never reach the chat field", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO]\n"), "");
  assert.equal(cleanTranscript("(wind blowing) Show me the rooms. [Music]"), "Show me the rooms.");
  assert.equal(cleanTranscript("*coughs* Book a room ♪"), "Book a room");
  assert.equal(cleanTranscript(" ... "), "");
  assert.equal(cleanTranscript("  Do you have rooms\n at Royal Hotel?  "), "Do you have rooms at Royal Hotel?");
});

/* ---- audioContextFor ---- */

test("the encoder window covers the clip plus a second, within Whisper's limits", () => {
  assert.equal(audioContextFor(0.5), 256);                 // floor
  assert.equal(audioContextFor(4.2), 320);                 // 5.2 s → 260 frames → 320
  assert.ok(audioContextFor(10) >= 11 * 50);
  assert.equal(audioContextFor(30), 1500);                 // never past the full window
  assert.equal(audioContextFor(29.9) % 64 === 0 || audioContextFor(29.9) === 1500, true);
});

/* ---- handleTranscribe ---- */

test("GET reports whether transcription is available, and which model", async () => {
  setTranscriber(fakeStt());
  const r = await handleTranscribe({ method: "GET" });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, true);
  assert.equal(r.body.model, "ggml-small.en-q5_0.bin");
  assert.equal(r.body.language, "en");
  assert.equal(r.body.maxSeconds, 30);
});

test("POST returns the transcript, with the clip's length passed on", async () => {
  const stt = fakeStt();
  setTranscriber(stt);
  const r = await post(wav(3));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { text: "Book a room at Taj Hotel." });
  assert.equal(stt.calls.length, 1);
  assert.ok(Math.abs(stt.calls[0].seconds - 3) < 1e-6);
});

test("other methods are 405, other types 415, oversized 413", async () => {
  setTranscriber(fakeStt());
  assert.equal((await handleTranscribe({ method: "PUT" })).status, 405);
  assert.equal((await post(wav(1), { "content-type": "audio/webm" })).status, 415);
  assert.equal((await post(wav(1), {})).status, 415);
  assert.equal((await post(Buffer.alloc(MAX_WAV_BYTES + 1))).status, 413);
});

test("audio/x-wav is accepted too", async () => {
  setTranscriber(fakeStt());
  assert.equal((await post(wav(1), { "content-type": "audio/x-wav" })).status, 200);
});

test("bad audio is 400 with a reason, and never reaches the model", async () => {
  const stt = fakeStt();
  setTranscriber(stt);
  const r1 = await post(wav(1, { rate: 48000 }));
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, "invalid_audio");
  const r2 = await post(wav(0.1));
  assert.equal(r2.body.error, "audio_too_short");
  assert.equal(stt.calls.length, 0);
});

test("no model on this server is 503 stt_unavailable", async () => {
  setTranscriber(fakeStt({ available: () => false }));
  const r = await post(wav(1));
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "stt_unavailable");
});

test("a full queue is 503 stt_busy with Retry-After; a crash is 502", async () => {
  const fail = code => async () => { const e = new Error("x"); e.code = code; throw e; };
  setTranscriber(fakeStt({ transcribe: fail("stt_busy") }));
  const busy = await post(wav(1));
  assert.equal(busy.status, 503);
  assert.equal(busy.body.error, "stt_busy");
  assert.ok(busy.headers["Retry-After"]);
  setTranscriber(fakeStt({ transcribe: fail("stt_failed") }));
  const failed = await post(wav(1));
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, "stt_failed");
});

test("rate limit: the 13th transcription in a minute from one address is 429", async () => {
  setTranscriber(fakeStt());
  let last;
  for (let i = 0; i < 13; i++) last = await handleTranscribe({ method: "POST", headers: WAV_H, body: wav(1), clientIp: "flood" });
  assert.equal(last.status, 429);
});

test("an empty transcript is a 200 with empty text, for the page to say so", async () => {
  setTranscriber(fakeStt({ transcribe: async () => "" }));
  const r = await post(wav(2));
  assert.equal(r.status, 200);
  assert.equal(r.body.text, "");
});
