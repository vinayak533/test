/* ============================================================================
   scripts/dev_server.js — local preview: the static page plus POST /api/chat.

       npm run serve            (http://localhost:8792)

   Serves POST /api/chat and GET /api/config through the same server/app.js the
   Netlify Functions run, so what works here
   works deployed. Static files are served from the repository root with
   anything private (.env, server/, supabase/, scripts/, tests/, node_modules/)
   refused, mirroring the deploy rules in netlify.toml.
   ============================================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleRequest, handleConfig } = require("../server/app");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 8792;
const PRIVATE = /^\/(?:\.|server\/|supabase\/|scripts\/|tests\/|netlify\/|node_modules\/|package(?:-lock)?\.json)/;
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
}).listen(PORT, () => console.log(`Misty Mountain dev server on http://localhost:${PORT}`));
