"use strict";

/* Live database: guest accounts (005_guest_accounts.sql).  npm run test:db
   Everything runs inside transactions that are rolled back — including the
   auth.users rows the bookings point at — so nothing is left behind. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { HOTEL, withPg } = require("./_db");

const ME = "00000000-0000-4000-8000-0000000a11ce";
const OTHER = "00000000-0000-4000-8000-00000000b0b0";
const IN = "2027-06-20", OUT = "2027-06-22";

/* One transaction: fixtures as the owner, then `fn` as a signed-in guest
   (no admin role), then roll everything back. */
async function scenario(fn, { as = ME } = {}){
  return withPg(async c => {
    await c.query("begin");
    try {
      for (const [id, email] of [[ME, "alice@test.invalid"], [OTHER, "bob@test.invalid"]]){
        await c.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, email]);
      }
      const g = await c.query(`insert into public.guests (hotel_id, full_name, email, phone)
                               values ($1, 'Test Guest', 'guest-acct@test.invalid', '+919847012345') returning id`, [HOTEL]);
      const rooms = Object.fromEntries((await c.query("select room_number, id, price_per_night from public.rooms where hotel_id = $1", [HOTEL]))
        .rows.map(r => [r.room_number, r]));
      const book = async (ref, n, user, status = "confirmed", from = IN, to = OUT) => {
        const r = rooms[n];
        const nights = (Date.parse(to) - Date.parse(from)) / 86400000;
        await c.query(`insert into public.reservations (booking_ref, hotel_id, room_id, guest_id, guest_name, guest_email, guest_phone,
                         check_in, check_out, num_guests, room_type, price_per_night, total_price, status, user_id, confirmed_at)
                       select $1, $2, $3, $4, 'Test Guest', 'guest-acct@test.invalid', '+919847012345', $5::date, $6::date, 2, room_type, $7::numeric, $7::numeric * $8::int, $9, $10::uuid, now()
                         from public.rooms where id = $3`,
          [ref, HOTEL, r.id, g.rows[0].id, from, to, r.price_per_night, nights, status, user]);
      };
      await book("MM-AAAAA1", 1, ME);
      await book("MM-AAAAA7", 7, OTHER);
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: as, role: "authenticated", app_metadata: {} })]);
      return await fn(c, { book });
    } finally { await c.query("rollback"); }
  });
}

test("room_board: every room with its status — booked rooms are never shown as available", () => scenario(async c => {
  const { rows } = await c.query("select room_number, room_type, status, mine from public.room_board($1, $2, $3)", [HOTEL, IN, OUT]);
  assert.equal(rows.length, 10);
  const by = Object.fromEntries(rows.map(r => [r.room_number, r]));
  assert.equal(by[1].status, "booked");
  assert.equal(by[1].mine, true, "the caller's own booking is marked as theirs");
  assert.equal(by[7].status, "booked");
  assert.equal(by[7].mine, false);
  assert.equal(by[7].room_type, "Luxury");
  assert.deepEqual(rows.filter(r => r.status === "available").map(r => r.room_number), [2, 3, 4, 5, 6, 8, 9, 10]);
  const after = await c.query("select status from public.room_board($1, $2, $3) where room_number = 1", [HOTEL, OUT, "2027-06-24"]);
  assert.equal(after.rows[0].status, "available", "free again from the check-out day");
}));

test("room_board returns no guest details and needs a signed-in user", () => scenario(async c => {
  const cols = (await c.query("select * from public.room_board($1, $2, $3) limit 1", [HOTEL, IN, OUT])).fields.map(f => f.name);
  assert.deepEqual(cols.sort(), ["is_active", "max_guests", "mine", "name", "price_per_night", "room_id", "room_number", "room_type", "status"].sort());
  await c.query("select set_config('request.jwt.claims', '{}', true)");
  await assert.rejects(c.query("select * from public.room_board($1, $2, $3)", [HOTEL, IN, OUT]), /forbidden/);
}));

test("my_bookings: only the caller's own bookings", () => scenario(async c => {
  const { rows } = await c.query("select public.my_bookings() as b");
  assert.deepEqual(rows[0].b.map(b => b.booking_ref), ["MM-AAAAA1"]);
  assert.equal(rows[0].b[0].rooms[0].room_number, 1);
}));

test("cancel_my_booking: own confirmed booking only, and the room frees up at once", () => scenario(async c => {
  const other = await c.query("select public.cancel_my_booking('MM-AAAAA7') as r");
  assert.deepEqual(other.rows[0].r, { ok: false, reason: "not_found" }, "someone else's booking can't be cancelled");
  const mine = await c.query("select public.cancel_my_booking('MM-AAAAA1') as r");
  assert.equal(mine.rows[0].r.ok, true);
  assert.equal(mine.rows[0].r.booking.status, "cancelled");
  const st = await c.query("select status from public.room_board($1, $2, $3) where room_number = 1", [HOTEL, IN, OUT]);
  assert.equal(st.rows[0].status, "available");
  const again = await c.query("select public.cancel_my_booking('MM-AAAAA1') as r");
  assert.equal(again.rows[0].r.reason, "invalid_transition");
}));

test("cancel_my_booking refuses on or after the check-in day", () => scenario(async (c, { book }) => {
  await c.query("reset role");
  const today = (await c.query("select (now() at time zone 'Asia/Kolkata')::date::text as d")).rows[0].d;
  const tomorrow = (await c.query("select ((now() at time zone 'Asia/Kolkata')::date + 1)::text as d")).rows[0].d;
  await book("MM-AAAAA3", 3, ME, "confirmed", today, tomorrow);
  await c.query("set local role authenticated");
  const r = await c.query("select public.cancel_my_booking('MM-AAAAA3') as r");
  assert.deepEqual(r.rows[0].r, { ok: false, reason: "too_late" });
}));

test("a guest cannot read reservations directly or use admin functions", () => scenario(async c => {
  assert.equal((await c.query("select count(*)::int n from public.reservations")).rows[0].n, 0);
  assert.equal((await c.query("select count(*)::int n from public.guests")).rows[0].n, 0);
  await assert.rejects(c.query("select public.admin_update_booking_status('MM-AAAAA7', 'cancelled')"), /forbidden/);
}));

test("inventory_pulse moves whenever a reservation changes, and signed-in users can read it", () => scenario(async c => {
  const before = (await c.query("select changed_at from public.inventory_pulse where hotel_id = $1", [HOTEL])).rows[0].changed_at;
  assert.ok(before, "readable by a signed-in guest");
  await c.query("select public.cancel_my_booking('MM-AAAAA1')");
  const after = (await c.query("select changed_at from public.inventory_pulse where hotel_id = $1", [HOTEL])).rows[0].changed_at;
  assert.ok(after >= before);
  await assert.rejects(c.query("update public.inventory_pulse set changed_at = now()"), /permission denied/);
}));

test("the database still refuses two bookings of one room for overlapping nights", () => scenario(async (c, { book }) => {
  await c.query("reset role");
  await assert.rejects(book("MM-AAAAA9", 1, OTHER, "confirmed", "2027-06-21", "2027-06-23"), /reservations_no_double_booking/);
}));
