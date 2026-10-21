/* ============================================================================
   scripts/dev_server.js — local preview: the static page plus POST /api/chat.

       npm run serve            (http://localhost:8792)

   Serves POST /api/chat, GET /api/config and GET /api/hotels through the same server/app.js the
   Netlify Functions run, so what works here
   works deployed. Static files are served from the repository root with
   anything private (.env, server/, supabase/, scripts/, tests/, node_modules/,
   models/, vendor/) refused, mirroring the deploy rules in netlify.toml.

   It also serves /api/transcribe — English speech to text with whisper.cpp
   and models/ggml-small.en-q5_0.bin — which only a long-lived server can:
   the model is loaded once at start-up and kept in memory. Without the model
   (npm run whisper:setup) or with WHISPER=off, the page falls back to the
   browser's own speech recognition, as it does on Netlify.
   ============================================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleRequest, handleConfig, handleHotels, handleTranscribe, warmTranscriber } = require("../server/app");
const { MAX_WAV_BYTES } = require("../server/stt/wav");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 8792;
const PRIVATE = /^\/(?:\.|server\/|supabase\/|scripts\/|tests\/|netlify\/|node_modules\/|models\/|vendor\/|package(?:-lock)?\.json)/;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                ".jpg": "image/jpeg", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/chat"){
    const chunks = [];
    let size = 0;
    for await (const c of req){ size += c.length; if (size > 65536) break; chunks.push(c); }
    const out = await handleRequest({
      method: req.method, headers: req.headers,
      bodyText: Buffer.concat(chunks).toString("utf8"), clientIp: req.socket.remoteAddress
    });
    res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(out.headers || {}) });
    return res.end(JSON.stringify(out.body));
  }

  if (url.pathname === "/api/config"){
    const out = handleConfig({ method: req.method });
    res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(out.headers || {}) });
    return res.end(JSON.stringify(out.body));
  }

  if (url.pathname === "/api/transcribe"){
    const chunks = [];
    let size = 0;
    for await (const c of req){
      size += c.length;
      if (size > MAX_WAV_BYTES){
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
        return res.end(JSON.stringify({ error: "too_large" }));
      }
      chunks.push(c);
    }
    const out = await handleTranscribe({
      method: req.method, headers: req.headers, body: Buffer.concat(chunks), clientIp: req.socket.remoteAddress
    });
    res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(out.headers || {}) });
    return res.end(JSON.stringify(out.body));
  }

  if (url.pathname === "/api/hotels"){
    const out = await handleHotels({ method: req.method });
    res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(out.headers || {}) });
    return res.end(JSON.stringify(out.body));
  }

  let p = decodeURIComponent(url.pathname);
  if (PRIVATE.test(p)){ res.writeHead(404); return res.end("Not found"); }
  if (p.endsWith("/")) p += "index.html";
  const file = path.resolve(ROOT, "." + p);
  if (!file.startsWith(ROOT + path.sep)){ res.writeHead(404); return res.end("Not found"); }
  fs.readFile(file, (err, data) => {
    if (err){ res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Misty Mountain dev server on http://localhost:${PORT}`);
  if (process.env.WHISPER === "off") console.log("Voice transcription off (WHISPER=off); the page uses the browser's recognition.");
  else if (warmTranscriber()) console.log("Loading the Whisper model for /api/transcribe…");
  else console.log("No Whisper model or runtime in this folder (npm run whisper:setup); the page uses the browser's recognition.");
});

// Ctrl+C: exit through process.exit so the whisper-server child is stopped too.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
