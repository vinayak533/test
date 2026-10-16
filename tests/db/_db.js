"use strict";

/* Shared plumbing for the live-database tests (npm run test:db).
   Every booking these tests make uses June 2027 dates and a
   @test.invalid email, and cleanup() removes exactly those rows. */

const { Client } = require("pg");
const { loadConfig } = require("../../server/config");
const { createSupabase, createRepository } = require("../../server/db/repository");

const HOTEL = "misty_mountain";
const TEST_FROM = "2027-06-01", TEST_TO = "2027-07-01";
const EMAIL_DOMAIN = "@test.invalid";

function pg(){
  const url = process.env.SUPABASE_DB_POOLER_URL || process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_POOLER_URL / SUPABASE_DB_URL not set — run with npm run test:db");
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

async function withPg(fn){
  const c = pg();
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/* Runs `fn` as an authenticated user with the given app_metadata, inside a
   transaction that is always rolled back. No account is created. */
async function asUser(appMetadata, fn){
  return withPg(async c => {
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: "00000000-0000-4000-8000-00000000beef", role: "authenticated", app_metadata: appMetadata })]);
      return await fn(c);
    } finally { await c.query("rollback"); }
  });
}

function repo(){ return createRepository(createSupabase(loadConfig())); }

async function roomIds(){
  return withPg(async c => {
    const r = await c.query("select room_number, id from public.rooms where hotel_id = $1 order by room_number", [HOTEL]);
    return Object.fromEntries(r.rows.map(x => [x.room_number, x.id]));
  });
}

async function cleanup(){
  return withPg(async c => {
    await c.query("begin");
    const r = await c.query(`delete from public.reservations where hotel_id = $1 and check_in >= $2 and check_in < $3`, [HOTEL, TEST_FROM, TEST_TO]);
    const g = await c.query(`delete from public.guests g where email like $1
                               and not exists (select 1 from public.reservations x where x.guest_id = g.id)`, ["%" + EMAIL_DOMAIN]);
    await c.query("commit");
    return { reservations: r.rowCount, guests: g.rowCount };
  });
}

module.exports = { HOTEL, TEST_FROM, TEST_TO, EMAIL_DOMAIN, withPg, asUser, repo, roomIds, cleanup };
