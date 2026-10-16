/* ============================================================================
   netlify/functions/chat.mjs — POST /api/chat

   Thin adapter: Netlify's Request → server/app.js → Response. All secrets are
   read from the function's environment (Netlify → Site configuration →
   Environment variables, or .env under `netlify dev`); none reach the page.
   ============================================================================ */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { handleRequest } = require("../../server/app.js");

export default async (req, context) => {
  const headers = Object.fromEntries(req.headers);
  const bodyText = req.method === "POST" ? await req.text() : "";
  const out = await handleRequest({
    method: req.method,
    headers,
    bodyText,
    clientIp: (context && context.ip) || headers["x-nf-client-connection-ip"] || "unknown"
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(out.headers || {})
    }
  });
};

export const config = { path: "/api/chat" };
