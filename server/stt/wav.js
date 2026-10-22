/* ============================================================================
   server/stt/wav.js — the audio /api/transcribe accepts, and the text it
   hands back.

   The page records, resamples and encodes in the browser, so the server only
   ever receives one shape: a RIFF/WAVE file of 16 kHz, mono, 16-bit PCM —
   exactly what whisper.cpp reads natively. Anything else is refused here,
   before it reaches the model, so no transcoder (ffmpeg) is needed.
   ============================================================================ */

"use strict";

const { InputError } = require("../sanitize");

const SAMPLE_RATE = 16000;
const MIN_SECONDS = 0.3;
const MAX_SECONDS = 30;
/* 30 s of 16 kHz 16-bit mono plus a header, with room for extra chunks. */
const MAX_WAV_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS + 4096;

/* parseWav(buffer) → { sampleRate, channels, bits, seconds }
   Throws InputError("invalid_audio" | "audio_too_short" | "audio_too_long"). */
function parseWav(buf){
  if (!Buffer.isBuffer(buf) || buf.length < 44
      || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE"){
    throw new InputError("invalid_audio", "not a WAV file");
  }
  let fmt = null, dataBytes = -1, dataOffset = -1;
  for (let at = 12; at + 8 <= buf.length;){
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= buf.length){
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      };
    } else if (id === "data"){
      dataBytes = Math.min(size, buf.length - body);
      dataOffset = body;
      break;
    }
    at = body + size + (size & 1);                 // chunks are word-aligned
  }
  if (!fmt || dataBytes < 0) throw new InputError("invalid_audio", "WAV has no fmt or data chunk");
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== SAMPLE_RATE || fmt.bits !== 16){
    throw new InputError("invalid_audio", "WAV must be 16 kHz mono 16-bit PCM");
  }
  const seconds = dataBytes / (SAMPLE_RATE * 2);
  if (seconds < MIN_SECONDS) throw new InputError("audio_too_short", "recording is too short");
  if (seconds > MAX_SECONDS + 0.5) throw new InputError("audio_too_long", `recording is longer than ${MAX_SECONDS} s`);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, seconds, dataOffset, dataBytes };
}

/* A laptop microphone often records the voice quietly and the tap on the
   microphone button — the trackpad click — loudly. Whisper's voice-activity
   detection (Silero) then hears no speech at all, and the clip comes back
   empty: recordings peaking at -2 dBFS from the click returned "" in 50 ms.

   So the speech level is measured, not the peak: the loudness (RMS) of the
   20 ms frames at the 90th percentile, which a few frames of click cannot
   move. The clip is brought to TARGET_RMS, and anything that would then go
   past LIMIT — the click — is soft-limited rather than clipped. The gain is
   capped, so silence and faint room noise stay faint and are still dropped
   as non-speech. Returns { wav, peak, level, gain }: a new buffer, the
   original untouched. */
const FRAME = 320;                 // 20 ms at 16 kHz
const TARGET_RMS = 0.1;            // -20 dBFS: ordinary close-talk speech
const MAX_GAIN = 40;               // +32 dB at most
const LIMIT = 0.7;

function normalizeWav(buf, info = parseWav(buf)){
  const { dataOffset, dataBytes } = info;
  const n = Math.floor(dataBytes / 2);
  const x = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++){
    x[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  const rms = [];
  for (let s = 0; s + FRAME <= n; s += FRAME){
    let sum = 0;
    for (let i = s; i < s + FRAME; i++) sum += x[i] * x[i];
    rms.push(Math.sqrt(sum / FRAME));
  }
  rms.sort((a, b) => a - b);
  const level = rms.length ? rms[Math.min(rms.length - 1, Math.floor(rms.length * 0.9))] : peak;
  const gain = level > 0 ? Math.min(MAX_GAIN, TARGET_RMS / level) : 1;
  if (gain <= 1.05 && peak <= LIMIT) return { wav: buf, peak, level, gain: 1 };

  // Soft knee above LIMIT: the click is flattened, speech passes untouched.
  const g = Math.max(1, gain);
  const out = Buffer.from(buf);
  for (let i = 0; i < n; i++){
    let v = x[i] * g;
    const a = Math.abs(v);
    if (a > LIMIT) v = Math.sign(v) * (LIMIT + (1 - LIMIT) * Math.tanh((a - LIMIT) / (1 - LIMIT)));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), dataOffset + i * 2);
  }
  return { wav: out, peak, level, gain: g };
}

/* Whisper marks what is not speech — silence, music, coughs — with tags such
   as "[BLANK_AUDIO]", "(wind blowing)" or "*laughs*". Those are not words the
   guest said, so they never reach the chat field. */
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g;

function cleanTranscript(raw){
  return String(raw || "")
    .replace(NON_SPEECH, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:-]+$/, "")                 // only punctuation left
    .trim();
}

module.exports = { parseWav, normalizeWav, cleanTranscript, SAMPLE_RATE, MIN_SECONDS, MAX_SECONDS, MAX_WAV_BYTES };
