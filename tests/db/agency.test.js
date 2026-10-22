"use strict";

/* Live database: the agency and its three client hotels — the agency
   overview, and hotel managers kept to their own hotel.  npm run test:db

   Everything runs inside transactions that are rolled back, including the
   auth.users and hotel_staff rows, so nothing is left behind. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { withPg } = require("./_db");

const AGENCY = "kuttikkanam_agency";
const HOTELS = ["misty_mountain", "royal_kuttikkanam", "taj_kuttikkanam"];
const MANAGER = "00000000-0000-4000-8000-0000000a7a1a";   // manages Royal Hotel only
const GUEST = "00000000-0000-4000-8000-00000000c0de";

/* One transaction: `fn` gets the client plus `as(who)` to switch between the
   owner (fixtures) and a signed-in user, and `book()` to make a confirmed
   booking directly. Always rolled back. */
async function scenario(fn){
  return withPg(async c => {
    await c.query("begin");
    try {
      await c.query("insert into auth.users (id, email, aud, role) values ($1, 'manager@test.invalid', 'authenticated', 'authenticated')", [MANAGER]);
      await c.query("insert into public.hotel_staff (user_id, hotel_id) values ($1, 'royal_kuttikkanam')", [MANAGER]);
      const as = async who => {
        await c.query("reset role");
        if (who === "owner") return;
        const claims = who === "admin" ? { sub: GUEST, role: "authenticated", app_metadata: { hotel_role: "admin" } }
                     : who === "manager" ? { sub: MANAGER, role: "authenticated", app_metadata: { hotel_role: "manager" } }
                     : { sub: GUEST, role: "authenticated", app_metadata: {} };
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
        await c.query("set local role authenticated");
      };
      const book = async (hotelId, ref, from, to) => {
        const room = (await c.query(`select room_id from public.get_availability($1, $2::date, $3::date)
                                      where is_available order by room_number limit 1`, [hotelId, from, to])).rows[0];
        assert.ok(room, "a free room at " + hotelId);
        const g = await c.query(`insert into public.guests (hotel_id, full_name, email, phone)
                                 values ($1, 'Agency Test', 'agency@test.invalid', '+919847012345')
                                 on conflict (hotel_id, email) do update set full_name = excluded.full_name returning id`, [hotelId]);
        await c.query(`insert into public.reservations (booking_ref, hotel_id, room_id, guest_id, guest_name, guest_email, guest_phone,
                         check_in, check_out, num_guests, room_type, price_per_night, total_price, status, confirmed_at)
                       select $1, $2, r.id, $3, 'Agency Test', 'agency@test.invalid', '+919847012345', $4::date, $5::date, 2,
                              r.room_type, r.price_per_night, r.price_per_night * ($5::date - $4::date), 'confirmed', now()
                         from public.rooms r where r.id = $6`, [ref, hotelId, g.rows[0].id, from, to, room.room_id]);
        return room.room_id;
      };
      return await fn(c, { as, book });
    } finally { await c.query("rollback"); }
  });
}

const overview = async c => (await c.query("select public.agency_overview() as o")).rows[0].o;
const byId = o => Object.fromEntries(o.hotels.map(h => [h.id, h]));
const today = async c => (await c.query("select ((now() at time zone 'Asia/Kolkata')::date)::text as d")).rows[0].d;

test("the agency is the parent of all three hotels", () => withPg(async c => {
  const a = await c.query("select id, name from public.agencies");
  assert.deepEqual(a.rows.map(x => x.id), [AGENCY]);
  const h = await c.query("select id, agency_id from public.hotels order by id");
  assert.deepEqual(h.rows.map(x => x.id), HOTELS);
  h.rows.forEach(x => assert.equal(x.agency_id, AGENCY, x.id));
  const col = await c.query(`select is_nullable from information_schema.columns
                              where table_schema = 'public' and table_name = 'hotels' and column_name = 'agency_id'`);
  assert.equal(col.rows[0].is_nullable, "NO");
  const fk = await c.query(`select conrelid::regclass::text t, confrelid::regclass::text r from pg_constraint
                             where contype = 'f' and connamespace = 'public'::regnamespace`);
  const pairs = fk.rows.map(x => x.t + "→" + x.r);
  for (const p of ["hotels→agencies", "hotel_staff→hotels"]) assert.ok(pairs.includes(p), p);
}));

test("agency overview: three clients, ten rooms each, figures that match the tables", () => scenario(async (c, { as }) => {
  await as("admin");
  const o = await overview(c);
  assert.equal(o.agency.id, AGENCY);
  assert.deepEqual(o.hotels.map(h => h.id).sort(), HOTELS);
  assert.equal(o.hotels.reduce((s, h) => s + h.rooms_total, 0), 30);

  await as("owner");
  const d = await today(c);
  for (const h of o.hotels){
    assert.equal(h.rooms_total, 10, h.id);
    assert.equal(h.normal + h.luxury, h.rooms_active, h.id);
    assert.equal(h.available + h.occupied + h.held, h.rooms_active, h.id);
    assert.equal(h.today, d);
    const q = await c.query(`
      select count(distinct r.id) filter (where x.status in ('confirmed', 'checked_in'))::int as occupied,
             (select count(distinct booking_ref)::int from public.reservations
               where hotel_id = $1 and check_in between $2::date and $2::date + 6 and status in ('confirmed', 'checked_in')) as checkins_7d
        from public.rooms r
        left join public.reservations x on x.room_id = r.id and x.check_in <= $2::date and x.check_out > $2::date
       where r.hotel_id = $1 and r.is_active`, [h.id, d]);
    assert.equal(h.occupied, q.rows[0].occupied, h.id + " occupied");
    assert.equal(h.checkins_7d, q.rows[0].checkins_7d, h.id + " check-ins in the next 7 days");
  }
}));

test("a booking tonight at Royal Hotel moves Royal's figures only; cancelling it moves them back", () => scenario(async (c, { as, book }) => {
  await as("admin");
  const before = byId(await overview(c));
  await as("owner");
  const d = await today(c);
  const next = (await c.query("select ($1::date + 1)::text d", [d])).rows[0].d;
  await book("royal_kuttikkanam", "MM-AGTST1", d, next);

  await as("admin");
  const after = byId(await overview(c));
  const r0 = before.royal_kuttikkanam, r1 = after.royal_kuttikkanam;
  assert.equal(r1.occupied, r0.occupied + 1);
  assert.equal(r1.available, r0.available - 1);
  assert.equal(r1.arrivals, r0.arrivals + 1);
  assert.equal(r1.arrivals_pending, r0.arrivals_pending + 1);
  assert.equal(r1.checkins_7d, r0.checkins_7d + 1);
  assert.equal(r1.bookings, r0.bookings + 1);
  assert.ok(Number(r1.month_revenue) > Number(r0.month_revenue), "this month's revenue grows");
  for (const h of ["misty_mountain", "taj_kuttikkanam"]) assert.deepEqual(after[h], before[h], h + " unchanged");

  const res = await c.query("select public.admin_update_booking_status('MM-AGTST1', 'cancelled', 'test') as r");
  assert.equal(res.rows[0].r.ok, true);
  const back = byId(await overview(c)).royal_kuttikkanam;
  assert.equal(back.occupied, r0.occupied);
  assert.equal(back.available, r0.available);
}));

test("a hotel manager sees their own hotel and nothing of the other clients", () => scenario(async (c, { as, book }) => {
  await as("owner");
  await book("misty_mountain", "MM-AGTST2", "2027-06-10", "2027-06-12");
  await book("royal_kuttikkanam", "MM-AGTST3", "2027-06-10", "2027-06-12");

  await as("manager");
  const one = async sql => (await c.query(sql)).rows;
  assert.deepEqual((await one("select id from public.hotels")).map(x => x.id), ["royal_kuttikkanam"]);
  const rooms = await one("select hotel_id from public.rooms");
  assert.equal(rooms.length, 10);
  rooms.forEach(r => assert.equal(r.hotel_id, "royal_kuttikkanam"));
  for (const t of ["reservations", "guests", "guest_summaries"]){
    const rows = await one(`select distinct hotel_id from public.${t}`);
    assert.deepEqual(rows.map(x => x.hotel_id), ["royal_kuttikkanam"], t);
  }
  assert.equal((await one("select 1 from public.reservations where booking_ref = 'MM-AGTST2'")).length, 0, "another client's booking is invisible");
  assert.equal((await one("select 1 from public.reservations where booking_ref = 'MM-AGTST3'")).length, 1);
  assert.deepEqual((await one("select hotel_id from public.hotel_staff")).map(x => x.hotel_id), ["royal_kuttikkanam"]);
  assert.deepEqual((await one("select id from public.agencies")).map(x => x.id), [AGENCY]);

  const o = await overview(c);
  assert.deepEqual(o.hotels.map(h => h.id), ["royal_kuttikkanam"]);
}));

test("a hotel manager cannot read, change or report on another client — even asking the database directly", () => scenario(async (c, { as, book }) => {
  await as("owner");
  await book("misty_mountain", "MM-AGTST4", "2027-06-14", "2027-06-16");
  await as("manager");

  const denied = async (sql, args, re) => {
    await c.query("savepoint s");
    await assert.rejects(c.query(sql, args), re);
    await c.query("rollback to savepoint s");
  };
  await denied("select public.admin_report('misty_mountain', '2027-06-01', '2027-06-30')", [], /forbidden/);
  await denied("select * from public.admin_availability('taj_kuttikkanam', '2027-06-01', '2027-06-02')", [], /forbidden/);
  const report = await c.query("select public.admin_report('royal_kuttikkanam', '2027-06-01', '2027-06-30') as r");
  assert.equal(report.rows[0].r.active_rooms, 10);
  const avail = await c.query("select count(*)::int n from public.admin_availability('royal_kuttikkanam', '2027-06-01', '2027-06-02')");
  assert.equal(avail.rows[0].n, 10);

  const st = await c.query("select public.admin_update_booking_status('MM-AGTST4', 'cancelled', 'not mine') as r");
  assert.deepEqual(st.rows[0].r, { ok: false, reason: "not_found" }, "another client's booking reads as not found");

  assert.equal((await c.query("update public.rooms set price_per_night = 1234 where hotel_id = 'misty_mountain'")).rowCount, 0);
  assert.equal((await c.query("update public.rooms set price_per_night = 3100 where hotel_id = 'royal_kuttikkanam' and room_number = 1")).rowCount, 1);
  assert.equal((await c.query("update public.hotels set phone = '+91 1' where id = 'taj_kuttikkanam'")).rowCount, 0);
  assert.equal((await c.query("update public.hotels set phone = '+91 94470 00000' where id = 'royal_kuttikkanam'")).rowCount, 1);
  await denied("update public.hotels set name = 'Mine now' where id = 'royal_kuttikkanam'", [], /permission denied/);
  await denied("update public.rooms set hotel_id = 'misty_mountain' where hotel_id = 'royal_kuttikkanam'", [], /permission denied/);
  await denied("insert into public.hotel_staff (user_id, hotel_id) values ($1, 'misty_mountain')", [MANAGER], /permission denied/);
}));

test("removing a manager from their hotel takes effect at once", () => scenario(async (c, { as }) => {
  await as("manager");
  assert.equal((await c.query("select count(*)::int n from public.rooms")).rows[0].n, 10);
  await as("owner");
  await c.query("delete from public.hotel_staff where user_id = $1", [MANAGER]);
  await as("manager");
  assert.equal((await c.query("select count(*)::int n from public.rooms")).rows[0].n, 0);
  await c.query("savepoint s");
  await assert.rejects(c.query("select public.agency_overview()"), /forbidden/);
  await c.query("rollback to savepoint s");
}));

test("a guest account gets no agency figures", () => scenario(async (c, { as }) => {
  await as("guest");
  await assert.rejects(c.query("select public.agency_overview()"), /forbidden/);
}));
