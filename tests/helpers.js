"use strict";

/* An in-memory stand-in for server/db/repository.js. Availability follows
   the same rules as supabase/migrations/003_booking_functions.sql, so flow
   tests exercise realistic inventory; the SQL itself is tested against the
   real database in tests/db/. */

const { memoryLogger } = require("../server/logger");
const { createStateCodec } = require("../server/booking/state");

// Fri 16 Oct 2026, 11:30 in Kerala.
const NOW = () => new Date("2026-10-16T06:00:00Z");

const HOTEL = {
  id: "misty_mountain", name: "Misty Mountain", aliases: ["misty mountain", "misty"],
  address: "Kuttikkanam, Peermade, Idukki, Kerala", timezone: "Asia/Kolkata",
  check_in_time: "14:00", check_out_time: "12:00", hold_minutes: 15, max_stay_nights: 30
};

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROOMS = Array.from({ length: 10 }, (_, i) => ({
  id: uuid(i + 1), room_number: i + 1,
  room_type: i < 6 ? "Normal" : "Luxury",
  price_per_night: i < 6 ? 2500 : 4500,
  max_guests: 3, is_active: true
}));

const CONFIG = {
  maxMessageChars: 500, nluFallback: "rules", intentThreshold: 0.6, hotelThreshold: 0.6,
  hotelTimezone: "Asia/Kolkata", defaultHotelId: "misty_mountain", maxStayNights: 30, maxDaysAhead: 540
};

function fakeRepo({ reservations = [], rooms = ROOMS, fail = null, holdResult = null, confirmResult = null } = {}){
  const calls = [];
  const res = reservations.map(r => ({ ...r }));
  const blocks = r => r.status === "confirmed" || r.status === "checked_in" || r.status === "held";
  const overlaps = (r, a, b) => r.check_in < b && r.check_out > a;
  const maybeFail = what => { if (fail === what || fail === "all") throw new Error(what + " timed out"); };
  let refN = 0;
  const booking = ref => {
    const rows = res.filter(r => r.ref === ref);
    return {
      booking_ref: ref, status: rows[0].status, check_in: rows[0].check_in, check_out: rows[0].check_out,
      nights: (Date.parse(rows[0].check_out) - Date.parse(rows[0].check_in)) / 86400000,
      num_guests: rows.reduce((s, r) => s + r.num_guests, 0),
      total_price: rows.reduce((s, r) => s + r.total_price, 0),
      guest_name: rows[0].guest_name || null, guest_email: rows[0].guest_email || null, guest_phone: rows[0].guest_phone || null,
      arrival_time: rows[0].arrival || null, departure_time: rows[0].departure || "12:00",
      hold_expires_at: "2026-10-16T06:15:00.000Z",
      rooms: rows.map(r => {
        const room = rooms.find(x => x.id === r.room_id);
        return { room_id: r.room_id, room_number: room.room_number, room_type: room.room_type,
                 price_per_night: r.price, num_guests: r.num_guests, total_price: r.total_price };
      })
    };
  };
  return {
    calls, res,
    async listHotels(){ calls.push(["hotels"]); maybeFail("hotels"); return [HOTEL]; },
    async getRooms(){ calls.push(["rooms"]); maybeFail("rooms"); return rooms.filter(r => r.is_active); },
    async getAvailability(h, a, b){
      calls.push(["availability", a, b]); maybeFail("availability");
      return rooms.filter(r => r.is_active).map(r => ({
        room_id: r.id, room_number: r.room_number, room_type: r.room_type, name: null,
        price_per_night: r.price_per_night, max_guests: r.max_guests,
        is_available: !res.some(x => x.room_id === r.id && blocks(x) && overlaps(x, a, b))
      }));
    },
    async holdRooms(args){
      calls.push(["hold", args]); maybeFail("hold");
      if (holdResult) return typeof holdResult === "function" ? holdResult(args) : holdResult;
      const taken = args.roomIds.filter(id => res.some(x => x.room_id === id && blocks(x) && overlaps(x, args.checkIn, args.checkOut)));
      if (taken.length) return { ok: false, reason: "unavailable", rooms: taken.map(id => rooms.find(r => r.id === id).room_number) };
      const ref = "MM-TEST" + String.fromCharCode(65 + refN++);
      const nights = (Date.parse(args.checkOut) - Date.parse(args.checkIn)) / 86400000;
      args.roomIds.forEach((id, i) => {
        const room = rooms.find(r => r.id === id);
        res.push({ ref, room_id: id, check_in: args.checkIn, check_out: args.checkOut, status: "held", token: args.tokenHash,
                   num_guests: args.guests[i], price: room.price_per_night, total_price: room.price_per_night * nights,
                   arrival: args.arrival, departure: args.departure });
      });
      return { ok: true, booking: booking(ref) };
    },
    async confirmBooking(args){
      calls.push(["confirm", args]); maybeFail("confirm");
      if (confirmResult) return confirmResult;
      const rows = res.filter(r => r.ref === args.ref && r.token === args.tokenHash);
      if (!rows.length) return { ok: false, reason: "not_found" };
      const already = rows.every(r => r.status === "confirmed");
      rows.forEach(r => Object.assign(r, { status: "confirmed", guest_name: args.name, guest_email: args.email, guest_phone: args.phone,
                                           user_id: args.userId || r.user_id || null }));
      return { ok: true, already, booking: booking(args.ref) };
    },
    async releaseHold(ref, hash){
      calls.push(["release", ref]);
      res.filter(r => r.ref === ref && r.token === hash && r.status === "held").forEach(r => { r.status = "expired"; });
      return 1;
    },
    async findBooking(ref, contact){
      calls.push(["find", ref]); maybeFail("find");
      const rows = res.filter(r => r.ref === ref && r.status !== "held" && r.status !== "expired");
      if (!rows.length) return null;
      const d = s => String(s).replace(/\D/g, "").slice(-10);
      const ok = rows[0].guest_email === contact.toLowerCase() || (d(contact).length === 10 && d(rows[0].guest_phone) === d(contact));
      return ok ? booking(ref) : null;
    }
  };
}

/* A conversation driver over handleChat: keeps the state token like the page does. */
function conversation({ repo = fakeRepo(), jev = null, config = CONFIG, now = NOW, user = null, authError = false } = {}){
  const { handleChat } = require("../server/chat");
  const codec = createStateCodec("test-secret-test-secret", { now: () => now().getTime() });
  const log = memoryLogger();
  let state = null;
  const deps = { config, repo, jev, log, codec, now, user, authError };
  async function send(input){
    const out = await handleChat({ ...input, state }, deps);
    if (out.state !== undefined) state = out.state;
    return out;
  }
  return {
    repo, log, codec,
    say: message => send({ message }),
    tap: action => send({ action }),
    get state(){ return state; },
    set state(v){ state = v; },
    signIn(u){ deps.user = u; deps.authError = false; },
    decoded: () => codec.decode(state)
  };
}

const optionLabels = out => ((out.ui && out.ui.options) || []).map(o => o.label);
const option = (out, re) => ((out.ui && out.ui.options) || []).find(o => re.test(o.label));

module.exports = { NOW, HOTEL, ROOMS, CONFIG, uuid, fakeRepo, conversation, optionLabels, option };
