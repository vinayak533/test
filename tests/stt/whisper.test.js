"use strict";

/* The real model: whisper.cpp and models/ggml-small.en-q5_0.bin, started the
   way /api/transcribe starts them. Skipped when `npm run whisper:setup` has
   not been run. Run with `npm run test:stt`.

   Speech fixtures are not committed (a recording of someone's voice is not
   ours to ship); what is checked here is what must hold for any audio: the
   model loads once, non-speech comes back empty instead of invented words,
   and the queue turns a burst away instead of piling it up. Spoken-English
   accuracy is checked by hand — see README, "Voice input". */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWhisper } = require("../../server/stt/whisper");

function wav(samples){
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return b;
}
const N = 16000 * 3;
const silence = wav(new Array(N).fill(0));
const noise = wav(Array.from({ length: N }, () => (Math.random() * 2 - 1) * 0.03));
const hum = wav(Array.from({ length: N }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 16000)));

const stt = createWhisper({});
const skip = stt.available() ? false : "model or runtime missing: run npm run whisper:setup";

test.after(() => stt.stop());

test("the model loads, once, and reports ready", { skip, timeout: 90_000 }, async () => {
  await stt.start();
  assert.equal(stt.status().state, "ready");
  assert.equal(stt.status().model, "ggml-small.en-q5_0.bin");
  await stt.start();                                   // no second load
  assert.equal(stt.status().state, "ready");
});

test("silence, room noise and a hum come back empty, not invented", { skip, timeout: 90_000 }, async () => {
  for (const [name, clip] of [["silence", silence], ["noise", noise], ["hum", hum]]){
    assert.equal(await stt.transcribe(clip, 3), "", name);
  }
});

test("a burst beyond the queue is turned away as busy", { skip, timeout: 90_000 }, async () => {
  const all = await Promise.allSettled(Array.from({ length: 6 }, () => stt.transcribe(silence, 3)));
  const busy = all.filter(r => r.status === "rejected" && r.reason.code === "stt_busy").length;
  assert.equal(busy, 2);
  assert.ok(all.filter(r => r.status === "fulfilled").every(r => r.value === ""));
});
