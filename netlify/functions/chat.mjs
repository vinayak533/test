/* ============================================================================
   netlify/functions/chat.mjs — POST /api/chat

   Thin adapter: Netlify's Request → server/app.js → Response. All secrets are
   read from the function's environment (Netlify → Site configuration →
   Environment variables, or .env under `netlify dev`); none reach the page.

   With "Accept: application/x-ndjson" the turn's steps stream as they happen
   (server/app.js, wantsProgress), as they do from scripts/dev_server.js.
   Where the platform buffers the stream the page receives it all at once
   and reads it the same way.
   ============================================================================ */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { handleRequest, wantsProgress } = require("../../server/app.js");

const json = out => new Response(JSON.stringify(out.body), {
  status: out.status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(out.headers || {})
  }
});

export default async (req, context) => {
  const headers = Object.fromEntries(req.headers);
  const bodyText = req.method === "POST" ? await req.text() : "";
  const args = {
    method: req.method,
    headers,
    bodyText,
    clientIp: (context && context.ip) || headers["x-nf-client-connection-ip"] || "unknown"
  };
  if (!wantsProgress(headers)) return json(await handleRequest(args));

  // Stream once the turn reports its first step; anything settled before
  // that (a refusal, an early error) is answered as plain JSON.
  const enc = new TextEncoder();
  let controller;
  const stream = new ReadableStream({ start(c){ controller = c; } });
  let begun;
  const firstStep = new Promise(resolve => { begun = resolve; });
  const work = handleRequest({ ...args, onProgress: stage => {
    begun(true);
    controller.enqueue(enc.encode(JSON.stringify({ stage }) + "\n"));
  } });
  if (!(await Promise.race([firstStep, work.then(() => false)]))) return json(await work);

  work.then(
    out => controller.enqueue(enc.encode(JSON.stringify({ status: out.status, body: out.body }) + "\n")),
    () => controller.enqueue(enc.encode(JSON.stringify({ status: 500, body: { error: "internal_error" } }) + "\n"))
  ).finally(() => controller.close());
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
};

export const config = { path: "/api/chat" };
