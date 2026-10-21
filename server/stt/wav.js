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
  let fmt = null, dataBytes = -1;
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
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, seconds };
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

module.exports = { parseWav, cleanTranscript, SAMPLE_RATE, MIN_SECONDS, MAX_SECONDS, MAX_WAV_BYTES };
