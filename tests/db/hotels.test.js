"use strict";

/* Live database: three hotels, ten rooms each, and bookings at one never
   touching another's availability.  npm run test:db
   June 2027 dates and @test.invalid emails only; removed afterwards. */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { EMAIL_DOMAIN, TEST_FROM, TEST_TO, withPg, repo } = require("./_db");
const { hashToken } = require("../../server/booking/state");

const R = repo();
const HOTELS = ["misty_mountain", "royal_kuttikkanam", "taj_kuttikkanam"];
const NEW = ["royal_kuttikkanam", "taj_kuttikkanam"];
let ROOM;                                         // ROOM[hotel][number] → id

async function cleanup(){
  return withPg(async c => {
    await c.query("begin");
    const r = await c.query("delete from public.reservations where hotel_id = any($1) and check_in >= $2 and check_in < $3", [HOTELS, TEST_FROM, TEST_TO]);
    const g = await c.query(`delete from public.guests g where email like $1
                               and not exists (select 1 from public.reservations x where x.guest_id = g.id)`, ["%" + EMAIL_DOMAIN]);
    await c.query("commit");
    return { reservations: r.rowCount, guests: g.rowCount };
  });
}

async function book(hotelId, numbers, checkIn, checkOut){
  const t = crypto.randomBytes(16).toString("hex");
  const held = await R.holdRooms({ hotelId, roomIds: numbers.map(n => ROOM[hotelId][n]), guests: numbers.map(() => 2),
                                   checkIn, checkOut, arrival: "14:00", departure: "12:00", tokenHash: hashToken(t) });
  assert.equal(held.ok, true, JSON.stringify(held));
  const done = await R.confirmBooking({ ref: held.booking.booking_ref, tokenHash: hashToken(t),
                                        name: "Test Guest", email: "multi" + EMAIL_DOMAIN, phone: "+919847000001" });
  assert.equal(done.ok, true, JSON.stringify(done));
  return done.booking;
}
const free = async (hotelId, a, b) => (await R.getAvailability(hotelId, a, b)).filter(r => r.is_available).map(r => r.room_number);

test.before(async () => {
  await cleanup();
  ROOM = await withPg(async c => {
    const r = await c.query("select hotel_id, room_number, id from public.rooms where hotel_id = any($1)", [HOTELS]);
    const out = {};
    for (const x of r.rows) (out[x.hotel_id] = out[x.hotel_id] || {})[x.room_number] = x.id;
    return out;
  });
});
test.after(async () => console.log("cleanup removed", JSON.stringify(await cleanup())));

test("three active hotels, each with rooms 1–10 of its own", async () => {
  const hotels = (await R.listHotels()).map(h => h.id);
  for (const h of HOTELS) assert.ok(hotels.includes(h), h + " is active");
  for (const h of HOTELS){
    const rooms = await R.getRooms(h);
    assert.deepEqual(rooms.map(r => r.room_number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], h);
  }
  const ids = HOTELS.flatMap(h => Object.values(ROOM[h]));
  assert.equal(new Set(ids).size, 30, "30 distinct rooms");
});

test("each new hotel has its own rates", async () => {
  const rates = async h => Object.fromEntries((await R.getRooms(h)).map(r => [r.room_number, [r.room_type, r.price_per_night]]));
  const royal = await rates("royal_kuttikkanam"), taj = await rates("taj_kuttikkanam");
  assert.deepEqual(royal[1], ["Normal", 3000]);
  assert.deepEqual(royal[7], ["Luxury", 5500]);
  assert.deepEqual(taj[5], ["Normal", 4000]);
  assert.deepEqual(taj[6], ["Luxury", 7500]);
});

test("room 1 booked at Royal Hotel stays free at Misty Mountain and Taj Hotel", async () => {
  const b = await book("royal_kuttikkanam", [1], "2027-06-10", "2027-06-12");
  assert.equal(b.hotel_id, "royal_kuttikkanam");
  assert.ok(!(await free("royal_kuttikkanam", "2027-06-10", "2027-06-12")).includes(1));
  assert.ok((await free("misty_mountain", "2027-06-10", "2027-06-12")).includes(1));
  assert.ok((await free("taj_kuttikkanam", "2027-06-10", "2027-06-12")).includes(1));
  // And the same room number, same nights, can be booked at Taj Hotel too.
  const t = await book("taj_kuttikkanam", [1], "2027-06-10", "2027-06-12");
  assert.equal(t.rooms[0].room_number, 1);
});

test("a fully booked hotel leaves the others untouched", async () => {
  await book("taj_kuttikkanam", [2, 3, 4, 5, 6, 7, 8, 9, 10], "2027-06-20", "2027-06-21");
  await book("taj_kuttikkanam", [1], "2027-06-20", "2027-06-21");
  assert.deepEqual(await free("taj_kuttikkanam", "2027-06-20", "2027-06-21"), []);
  assert.equal((await free("royal_kuttikkanam", "2027-06-20", "2027-06-21")).length, 10);
  assert.equal((await free("misty_mountain", "2027-06-20", "2027-06-21")).length, 10);
});

test("hold_rooms refuses another hotel's room", async () => {
  const t = crypto.randomBytes(16).toString("hex");
  const res = await R.holdRooms({ hotelId: "royal_kuttikkanam", roomIds: [ROOM.taj_kuttikkanam[3]], guests: [2],
                                  checkIn: "2027-06-15", checkOut: "2027-06-16", arrival: null, departure: null, tokenHash: hashToken(t) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unavailable");
});

test("double-booking is still refused within a hotel", async () => {
  await book("royal_kuttikkanam", [5], "2027-06-24", "2027-06-26");
  const t = crypto.randomBytes(16).toString("hex");
  const res = await R.holdRooms({ hotelId: "royal_kuttikkanam", roomIds: [ROOM.royal_kuttikkanam[5]], guests: [2],
                                  checkIn: "2027-06-25", checkOut: "2027-06-27", arrival: null, departure: null, tokenHash: hashToken(t) });
  assert.equal(res.ok, false);
  assert.deepEqual(res.rooms, [5]);
});

test("guest profiles are kept per hotel", async () => {
  const rows = await withPg(c => c.query("select hotel_id from public.guests where email = $1 order by hotel_id", ["multi" + EMAIL_DOMAIN]));
  for (const h of NEW) assert.ok(rows.rows.some(r => r.hotel_id === h), h);
});
