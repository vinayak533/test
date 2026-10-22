/* ============================================================================
   server/stt/whisper.js — English speech-to-text with whisper.cpp.

   The model is models/ggml-small.en-q5_0.bin (with models/ggml-silero-
   v6.2.0.bin for voice-activity detection) and the runtime is whisper.cpp's
   own HTTP server, vendor/whisper.cpp/bin/whisper-server — both inside this
   project, both fetched by `npm run whisper:setup`, both git-ignored. Paths
   are resolved from this file, never from the home folder or a global cache,
   so deleting the project folder deletes all of it.

   One whisper-server process is started per Node process, listening on
   127.0.0.1 only, on a free port. It loads the model once and keeps it in
   memory, so a transcription costs inference time only, not a model load.
   Requests are passed to it one at a time; a short queue absorbs bursts and
   anything beyond it is turned away as busy rather than piling up CPU work.
   If the process dies it is started again on the next request.

   whisper.cpp keeps no cache of its own: it reads the model from the path it
   is given and writes nothing to disk unless --convert is used, which is not.
   ============================================================================ */

"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { cleanTranscript } = require("./wav");

const ROOT = path.resolve(__dirname, "..", "..");
const MODEL_NAME = "ggml-small.en-q5_0.bin";
const MODEL_PATH = path.join(ROOT, "models", MODEL_NAME);
/* Silero voice-activity detection, run by whisper.cpp before decoding. Fed
   silence, room noise or a hum, Whisper invents words — "you", "I'll be
   waiting for you", or the prompt itself ("I'd like to check-out dates" from
   a 440 Hz tone) — and its own no-speech score did not catch any of them.
   With VAD those clips never reach the decoder and come back empty. */
const VAD_MODEL_PATH = path.join(ROOT, "models", "ggml-silero-v6.2.0.bin");
const RUNTIME_DIR = path.join(ROOT, "vendor", "whisper.cpp");
const SERVER_BIN = path.join(RUNTIME_DIR, "bin", process.platform === "win32" ? "whisper-server.exe" : "whisper-server");

/* Biases the decoder towards the words guests actually say to this desk:
   the hotel names, the town, and the booking vocabulary. It is a hint about
   spelling, not text that is ever added to the result. Written as a guest
   would say it, in sentence case: Whisper copies the prompt's style, and a
   capitalised word list came back as "Book a Luxury Room". */
const DEFAULT_PROMPT = "Misty Mountain in Kuttikkanam. "
  + "I'd like to check availability and book a normal or luxury room, with check-in and check-out dates.";

const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_PENDING = 4;
const RESTART_BACKOFF_MS = 5_000;

class SttError extends Error {
  constructor(code, message){ super(message); this.code = code; }
}

function freePort(){
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* Whisper's encoder always works on a 30 s window (1500 frames, 50 a
   second), padding a short clip with silence — and that encoder pass is
   nearly all of the time on a CPU. Encoding only the frames the clip fills,
   plus a second of margin, gives the same words several times faster
   (measured: a 4 s question 6.3 s → 1.8 s on 8 threads). Rounded up to a
   multiple of 64 and never below 256, where accuracy holds. */
function audioContextFor(seconds){
  const frames = Math.ceil((seconds + 1) * 50);
  return Math.min(1500, Math.max(256, Math.ceil(frames / 64) * 64));
}

function defaultThreads(){
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, cores - 2));         // leave two for Node and the OS
}

/**
 * createWhisper({ log, modelPath?, vadModelPath?, serverBin?, threads?, prompt?, enabled? })
 *   WHISPER=off in the environment turns it off; WHISPER_THREADS and
 *   WHISPER_PROMPT override the defaults below.
 *   → { available(), status(), start(), transcribe(wavBuffer), stop() }
 */
function createWhisper({
  log,
  modelPath = MODEL_PATH,
  vadModelPath = VAD_MODEL_PATH,
  serverBin = SERVER_BIN,
  threads = Number(process.env.WHISPER_THREADS) || defaultThreads(),
  prompt = process.env.WHISPER_PROMPT || DEFAULT_PROMPT,
  enabled = process.env.WHISPER !== "off"
} = {}){
  let child = null;
  let base = null;                 // "http://127.0.0.1:<port>" once ready
  let starting = null;             // the start() promise while loading
  let lastFailure = 0;
  let lastError = null;
  let queue = Promise.resolve();
  let pending = 0;
  let exitHooked = false;

  const available = () => enabled && [modelPath, vadModelPath, serverBin].every(f => fs.existsSync(f));

  function status(){
    return {
      available: available(),
      state: base ? "ready" : starting ? "loading" : lastError ? "failed" : "stopped",
      model: path.basename(modelPath),
      language: "en"
    };
  }

  async function waitUntilListening(url, proc){
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline){
      if (proc.exitCode !== null || proc.signalCode) throw new SttError("stt_failed", "whisper-server exited while loading");
      try {
        await fetch(url + "/", { signal: AbortSignal.timeout(1000) });
        return;                                    // any HTTP answer means the model is loaded
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new SttError("stt_failed", "whisper-server did not start in time");
  }

  function start(){
    if (base) return Promise.resolve();
    if (starting) return starting;
    if (!available()) return Promise.reject(new SttError("stt_unavailable", "model, VAD model or whisper-server missing; run npm run whisper:setup"));
    if (Date.now() - lastFailure < RESTART_BACKOFF_MS) return Promise.reject(new SttError("stt_failed", "whisper-server failed recently"));

    starting = (async () => {
      const port = await freePort();
      const args = ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port),
                    "-l", "en", "-t", String(threads), "-nt", "-sns", "--prompt", prompt,
                    "--vad", "-vm", vadModelPath];
      const began = Date.now();
      const proc = spawn(serverBin, args, { cwd: path.dirname(path.dirname(serverBin)), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let tail = "";
      const keep = d => { tail = (tail + d.toString("utf8")).slice(-2000); };
      proc.stdout.on("data", keep);
      proc.stderr.on("data", keep);
      proc.on("error", e => { lastError = e.message; });
      proc.on("exit", (code, signal) => {
        if (child === proc){ child = null; base = null; }
        if (code !== 0 && signal !== "SIGTERM"){
          lastFailure = Date.now();
          lastError = `exit ${code ?? signal}`;
          log && log.warn("stt.exited", { code, signal, tail: tail.slice(-300) });
        }
      });
      child = proc;
      if (!exitHooked){ exitHooked = true; process.once("exit", stop); }   // never leave it running behind us
      const url = "http://127.0.0.1:" + port;
      try {
        await waitUntilListening(url, proc);
      } catch (e){
        lastFailure = Date.now();
        lastError = e.message;
        try { proc.kill(); } catch {}
        log && log.error("stt.start_failed", { error: e.message, tail: tail.slice(-300) });
        throw e;
      }
      base = url;
      lastError = null;
      log && log.info("stt.ready", { model: path.basename(modelPath), threads, ms: Date.now() - began });
    })().finally(() => { starting = null; });
    return starting;
  }

  async function infer(wav, seconds){
    await start();
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    if (seconds > 0) form.append("audio_ctx", String(audioContextFor(seconds)));
    let res;
    try {
      res = await fetch(base + "/inference", { method: "POST", body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e){
      throw new SttError("stt_failed", e.name === "TimeoutError" ? "transcription timed out" : e.message);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.text !== "string"){
      throw new SttError("stt_failed", "whisper-server answered " + res.status + (body && body.error ? ": " + body.error : ""));
    }
    return cleanTranscript(body.text);
  }

  /* transcribe(wav, seconds) → the words heard, "" when nothing was. One at
     a time. `seconds` is the clip's length, from parseWav(). */
  function transcribe(wav, seconds = 0){
    if (pending >= MAX_PENDING) return Promise.reject(new SttError("stt_busy", "too many transcriptions waiting"));
    pending += 1;
    const run = queue.then(() => infer(wav, seconds));
    queue = run.catch(() => {});
    return run.finally(() => { pending -= 1; });
  }

  function stop(){
    const proc = child;
    child = null;
    base = null;
    if (proc && proc.exitCode === null){
      try { proc.kill(); } catch {}
    }
  }

  return { available, status, start, transcribe, stop };
}

module.exports = { createWhisper, audioContextFor, SttError, MODEL_NAME, MODEL_PATH, VAD_MODEL_PATH, RUNTIME_DIR, SERVER_BIN, DEFAULT_PROMPT };
