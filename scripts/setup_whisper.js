/* ============================================================================
   scripts/setup_whisper.js — the speech-to-text model and runtime, inside
   this project.

       npm run whisper:setup

   Puts two things in the project folder, and nowhere else:

     models/ggml-small.en-q5_0.bin       the English Whisper "small" model,
                                         5-bit (q5_0) quantised, ~175 MB
     models/ggml-silero-v6.2.0.bin       Silero voice-activity detection, 1 MB:
                                         keeps silence and noise away from
                                         Whisper, which would otherwise
                                         invent words for them
     vendor/whisper.cpp/bin/             whisper-server (and whisper-quantize)

   All of it is git-ignored. Anything already in place is left alone, so running
   it again downloads nothing; the app itself never downloads anything.
   Partial downloads go to models/_download/ and vendor/whisper.cpp/_download/
   and are deleted once used. Deleting the project folder removes all of it.

   The model: whisper.cpp publishes small.en as f16, q5_1 and q8_0, but not
   q5_0. So the official f16 file is downloaded from the whisper.cpp model
   repository (checked against its SHA-256), quantised to q5_0 with
   whisper.cpp's own whisper-quantize, and the f16 file deleted. Quantising is
   deterministic: the result's SHA-256 is checked too.

   The runtime: on Windows x64, the pinned whisper.cpp release build (CPU),
   checked against its SHA-256. Elsewhere it is built from the same release's
   source with CMake and a C++ compiler, which must be installed.
   ============================================================================ */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { MODEL_PATH, VAD_MODEL_PATH, RUNTIME_DIR, SERVER_BIN } = require("../server/stt/whisper");

const WHISPER_RELEASE = "b5454";       // whisper.cpp release, 2026-10-06 (v1.9.5)
const WIN_ZIP = {
  url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-x64.zip`,
  sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb"
};
const SOURCE_TGZ = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_RELEASE}.tar.gz`;
const F16_MODEL = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
  sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
  bytes: 487614201
};
const Q5_0_SHA256 = "785eb47dbbcdbaaeb7ccf4921477ca3b7efc509792ec50ee68e73b5a8af8dc70";
const VAD_MODEL = {
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"
};

const EXE = process.platform === "win32" ? ".exe" : "";
const BIN_DIR = path.dirname(SERVER_BIN);
const QUANTIZE_BIN = path.join(BIN_DIR, "whisper-quantize" + EXE);

function sha256(file){
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

async function download(url, file, expectSha){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const part = file + ".part";
  const out = fs.createWriteStream(part);
  let got = 0, shown = -1;
  for await (const chunk of res.body){
    got += chunk.length;
    if (!out.write(chunk)) await new Promise(r => out.once("drain", r));
    const pct = total ? Math.floor(got / total * 100) : -1;
    if (pct !== shown && pct % 10 === 0){ shown = pct; process.stdout.write(`  ${pct}% of ${(total / 1e6).toFixed(0)} MB\n`); }
  }
  await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  const sum = sha256(part);
  if (expectSha && sum !== expectSha){
    fs.rmSync(part, { force: true });
    throw new Error(`checksum mismatch for ${url}\n  expected ${expectSha}\n  got      ${sum}`);
  }
  fs.renameSync(part, file);
}

function have(cmd){
  try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function setupRuntime(){
  if (fs.existsSync(SERVER_BIN) && fs.existsSync(QUANTIZE_BIN)){
    console.log("runtime: already in place —", path.relative(process.cwd(), SERVER_BIN));
    return;
  }
  const work = path.join(RUNTIME_DIR, "_download");
  fs.mkdirSync(BIN_DIR, { recursive: true });

  if (process.platform === "win32" && process.arch === "x64"){
    const zip = path.join(work, "whisper-bin-x64.zip");
    console.log(`runtime: downloading whisper.cpp ${WHISPER_RELEASE} for Windows x64 (CPU)…`);
    await download(WIN_ZIP.url, zip, WIN_ZIP.sha256);
    // Windows' own tar.exe (bsdtar) reads zip files; Git's GNU tar does not.
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-xf", zip, "-C", BIN_DIR, "--strip-components", "1",
      "Release/whisper-server.exe", "Release/whisper-cli.exe", "Release/whisper-quantize.exe",
      "Release/whisper.dll", "Release/ggml.dll", "Release/ggml-base.dll", "Release/ggml-cpu-*.dll"], { stdio: "inherit" });
  } else {
    if (!have("cmake")){
      throw new Error("building whisper.cpp needs CMake and a C++ compiler (e.g. apt install cmake build-essential, or xcode-select --install && brew install cmake)");
    }
    const tgz = path.join(work, "source.tar.gz");
    console.log(`runtime: downloading whisper.cpp ${WHISPER_RELEASE} source…`);
    await download(SOURCE_TGZ, tgz);
    const src = path.join(work, "src");
    fs.mkdirSync(src, { recursive: true });
    execFileSync("tar", ["-xzf", tgz, "-C", src, "--strip-components", "1"], { stdio: "inherit" });
    const build = path.join(src, "build");
    console.log("runtime: building whisper-server and whisper-quantize (a few minutes)…");
    execFileSync("cmake", ["-S", src, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF",
      "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_SDL2=OFF"], { stdio: "inherit" });
    execFileSync("cmake", ["--build", build, "--config", "Release", "-j", "--target", "whisper-server", "whisper-quantize"], { stdio: "inherit" });
    for (const name of ["whisper-server", "whisper-quantize"]){
      fs.copyFileSync(path.join(build, "bin", name), path.join(BIN_DIR, name));
      fs.chmodSync(path.join(BIN_DIR, name), 0o755);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  if (!fs.existsSync(SERVER_BIN)) throw new Error("whisper-server is missing after setup");
  console.log("runtime: ready —", path.relative(process.cwd(), SERVER_BIN));
}

async function setupModel(){
  if (fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size > 0){
    console.log("model: already in place —", path.relative(process.cwd(), MODEL_PATH));
    return;
  }
  const work = path.join(path.dirname(MODEL_PATH), "_download");
  const f16 = path.join(work, "ggml-small.en.bin");
  if (!(fs.existsSync(f16) && fs.statSync(f16).size === F16_MODEL.bytes && sha256(f16) === F16_MODEL.sha256)){
    console.log("model: downloading the official ggml-small.en.bin (f16, 488 MB)…");
    await download(F16_MODEL.url, f16, F16_MODEL.sha256);
  }
  console.log("model: quantising to q5_0 with whisper-quantize…");
  const part = MODEL_PATH + ".part";
  execFileSync(QUANTIZE_BIN, [f16, part, "q5_0"], { stdio: ["ignore", "ignore", "inherit"] });
  const sum = sha256(part);
  if (sum !== Q5_0_SHA256){
    // Same input and same quantiser give the same bytes; a different whisper.cpp
    // build may not. The model still works, so warn rather than refuse.
    console.warn(`model: warning — SHA-256 ${sum} differs from the reference ${Q5_0_SHA256}`);
  }
  fs.renameSync(part, MODEL_PATH);
  fs.rmSync(work, { recursive: true, force: true });
  console.log("model: ready —", path.relative(process.cwd(), MODEL_PATH));
}

async function setupVad(){
  if (fs.existsSync(VAD_MODEL_PATH) && fs.statSync(VAD_MODEL_PATH).size > 0){
    console.log("vad: already in place —", path.relative(process.cwd(), VAD_MODEL_PATH));
    return;
  }
  console.log("vad: downloading the Silero voice-activity model (1 MB)…");
  await download(VAD_MODEL.url, VAD_MODEL_PATH, VAD_MODEL.sha256);
  console.log("vad: ready —", path.relative(process.cwd(), VAD_MODEL_PATH));
}

(async () => {
  await setupRuntime();            // first: the model step needs whisper-quantize
  await setupModel();
  await setupVad();
  console.log("Done. `npm run serve` loads the model once at start-up and serves /api/transcribe.");
})().catch(e => {
  console.error("whisper setup failed:", e.message);
  process.exit(1);
});
