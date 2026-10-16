/* ============================================================================
   netlify/functions/config.mjs — GET /api/config

   The Supabase project URL and its public anon key, for the admin dashboard
   to sign staff in. Both are public by design; Row Level Security is what
   keeps guest data private. server/app.js refuses to serve a key that is not
   the anon key.
   ============================================================================ */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { handleConfig } = require("../../server/app.js");

export default async (req) => {
  const out = handleConfig({ method: req.method });
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

export const config = { path: "/api/config" };
