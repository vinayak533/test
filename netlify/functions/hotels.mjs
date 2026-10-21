/* ============================================================================
   netlify/functions/hotels.mjs — GET /api/hotels

   The active hotels' ids, names and towns, read from Supabase, for the
   ChatBot's and the guest area's hotel picker. Nothing private: no contact
   details, rooms or bookings.
   ============================================================================ */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { handleHotels } = require("../../server/app.js");

export default async (req) => {
  const out = await handleHotels({ method: req.method });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...(out.headers || {})
    }
  });
};

export const config = { path: "/api/hotels" };
