"use strict";

/* Live database: the schema, the seed and the security model.  npm run test:db */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { HOTEL, withPg, asUser } = require("./_db");

test("three hotels: Misty Mountain, Royal Hotel and Taj Hotel, INR, check-in 2 PM / check-out noon", () => withPg(async c => {
  const r = await c.query("select id, name, currency, to_char(check_in_time,'HH24:MI') cin, to_char(check_out_time,'HH24:MI') cout from public.hotels order by id");
  assert.deepEqual(r.rows, [
    { id: HOTEL, name: "Misty Mountain", currency: "INR", cin: "14:00", cout: "12:00" },
    { id: "royal_kuttikkanam", name: "Royal Hotel", currency: "INR", cin: "14:00", cout: "12:00" },
    { id: "taj_kuttikkanam", name: "Taj Hotel", currency: "INR", cin: "14:00", cout: "12:00" }
  ]);
}));

test("ten rooms per hotel, 30 in all", () => withPg(async c => {
  const r = await c.query("select hotel_id, count(*)::int n, count(distinct room_number)::int d, min(room_number) lo, max(room_number) hi from public.rooms group by 1 order by 1");
  assert.deepEqual(r.rows.map(x => [x.hotel_id, x.n, x.d, x.lo, x.hi]), [
    [HOTEL, 10, 10, 1, 10], ["royal_kuttikkanam", 10, 10, 1, 10], ["taj_kuttikkanam", 10, 10, 1, 10]
  ]);
}));

test("Misty Mountain: rooms 1–10, six Normal at ₹2,500 and four Luxury at ₹4,500", () => withPg(async c => {
  const r = await c.query("select room_number, room_type, price_per_night::text price, is_active from public.rooms where hotel_id = $1 order by room_number", [HOTEL]);
  assert.equal(r.rows.length, 10);
  assert.deepEqual(r.rows.map(x => x.room_number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  r.rows.forEach(x => {
    const lux = x.room_number >= 7;
    assert.equal(x.room_type, lux ? "Luxury" : "Normal", "room " + x.room_number);
    assert.equal(x.price, lux ? "4500.00" : "2500.00", "room " + x.room_number);
  });
}));

test("prices and totals are stored as numeric", () => withPg(async c => {
  const r = await c.query(`select table_name, column_name, data_type from information_schema.columns
                            where table_schema='public' and column_name in ('price_per_night','total_price') order by 1,2`);
  assert.ok(r.rows.length >= 3);
  r.rows.forEach(x => assert.equal(x.data_type, "numeric", x.table_name + "." + x.column_name));
}));

test("the seeds are safe to re-run: no duplicate hotels or rooms", () => withPg(async c => {
  const read = f => fs.readFileSync(path.join(__dirname, "..", "..", "supabase", "migrations", f), "utf8");
  const seeds = [read("002_seed_misty_mountain.sql"), read("006_seed_kuttikkanam_hotels.sql")];
  await c.query("begin");
  try {
    for (let i = 0; i < 3; i++) for (const sql of seeds) await c.query(sql);
    const h = await c.query("select count(*)::int n from public.hotels");
    const r = await c.query("select count(*)::int n, count(distinct (hotel_id, room_number))::int d from public.rooms");
    assert.equal(h.rows[0].n, 3);
    assert.deepEqual(r.rows[0], { n: 30, d: 30 });
  } finally { await c.query("rollback"); }
}));

test("relationships: rooms → hotels, reservations → rooms/guests/hotels", () => withPg(async c => {
  const r = await c.query(`select conrelid::regclass::text tbl, confrelid::regclass::text ref from pg_constraint
                            where contype='f' and connamespace='public'::regnamespace order by 1,2`);
  const pairs = r.rows.map(x => x.tbl + "→" + x.ref);
  for (const p of ["rooms→hotels", "guests→hotels", "reservations→hotels", "reservations→rooms", "reservations→guests"]){
    assert.ok(pairs.includes(p), p);
  }
  const ex = await c.query("select 1 from pg_constraint where conname='reservations_no_double_booking' and contype='x'");
  assert.equal(ex.rowCount, 1, "exclusion constraint against double-booking exists");
}));

test("row level security is on for every table, with staff-of-this-hotel policies", () => withPg(async c => {
  const r = await c.query(`select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`);
  for (const t of ["agencies", "guests", "hotel_staff", "hotels", "reservations", "rooms", "inventory_pulse"]){
    assert.equal(r.rows.find(x => x.relname === t).relrowsecurity, true, t);
  }
  const p = await c.query("select tablename, policyname, cmd, roles::text, qual from pg_policies where schemaname='public'");
  assert.ok(p.rows.length >= 5);
  // The one exception: inventory_pulse (a hotel id and a timestamp, no
  // booking data) is readable by any signed-in user, never writable.
  const pulse = p.rows.filter(x => x.tablename === "inventory_pulse");
  assert.deepEqual(pulse.map(x => [x.cmd, x.roles, x.qual]), [["SELECT", "{authenticated}", "true"]]);
  // A staff list: an agency administrator reads it all, anyone else their own rows.
  const staff = p.rows.filter(x => x.tablename === "hotel_staff");
  assert.equal(staff.length, 1);
  assert.match(staff[0].qual, /is_admin\(\).*auth\.uid\(\)/s);
  // Everything else is scoped to the hotels the caller manages.
  p.rows.filter(x => !["inventory_pulse", "hotel_staff"].includes(x.tablename))
    .forEach(x => assert.match(x.qual, /staff_hotel_ids\(\)/, x.policyname));
}));

test("the public anon key can read nothing and call nothing", async () => {
  const H = { apikey: process.env.SUPABASE_ANON_KEY, Authorization: "Bearer " + process.env.SUPABASE_ANON_KEY, "Content-Type": "application/json" };
  for (const t of ["hotels", "rooms", "guests", "reservations", "guest_summaries"]){
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${t}?select=*&limit=1`, { headers: H });
    const body = await r.text();
    assert.ok(r.status === 401 || r.status === 403 || body === "[]", `${t}: HTTP ${r.status} ${body.slice(0, 80)}`);
  }
  for (const fn of ["get_availability", "hold_rooms", "confirm_booking", "find_booking", "admin_report", "admin_update_booking_status"]){
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: "{}" });
    assert.ok([401, 403, 404].includes(r.status), `${fn}: HTTP ${r.status}`);
  }
});

test("a signed-in user without the admin role sees no rows and cannot run admin functions", () =>
  asUser({}, async c => {
    for (const t of ["hotels", "rooms", "guests", "reservations", "guest_summaries"]){
      const r = await c.query(`select count(*)::int n from public.${t}`);
      assert.equal(r.rows[0].n, 0, t);
    }
    const u = await c.query("update public.rooms set price_per_night = 1 where room_number = 1");
    assert.equal(u.rowCount, 0, "update touches nothing");
    await c.query("savepoint s");
    await assert.rejects(c.query("select public.admin_report($1, '2026-10-01', '2026-10-31')", [HOTEL]), /forbidden/);
    await c.query("rollback to savepoint s");
    await assert.rejects(c.query("select public.hold_rooms($1, '{}', '{}', '2027-06-01', '2027-06-02', null, null, $2)", [HOTEL, "0".repeat(64)]), /permission denied/);
  }));

test("an admin reads everything but writes only what the grants allow", () =>
  asUser({ hotel_role: "admin" }, async c => {
    assert.equal((await c.query("select count(*)::int n from public.rooms")).rows[0].n, 30);
    assert.equal((await c.query("select count(*)::int n from public.hotels")).rows[0].n, 3);
    assert.equal((await c.query("update public.rooms set price_per_night = 2600 where hotel_id = 'misty_mountain' and room_number = 1")).rowCount, 1);
    await c.query("savepoint s");
    await assert.rejects(c.query("update public.rooms set price_per_night = -1 where room_number = 1"), /check constraint/);
    await c.query("rollback to savepoint s");
    await assert.rejects(c.query("update public.rooms set hotel_id = 'x' where room_number = 1"), /permission denied/);
    await c.query("rollback to savepoint s");
    await assert.rejects(c.query("update public.reservations set status = 'cancelled'"), /permission denied/);
    await c.query("rollback to savepoint s");
    await assert.rejects(c.query("insert into public.reservations (booking_ref) values ('MM-AAAAAA')"), /permission denied/);
  }));
