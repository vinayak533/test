/* ============================================================================
   server/responses.js — fixed sentences outside the booking flow.

   No model writes these. The hotel list is built from the hotels table, so a
   second hotel added there would be named here without a code change — and
   no hotel that is not in the table can ever be named.
   ============================================================================ */

"use strict";

const F = require("./booking/format");

function list(names){
  if (names.length <= 1) return names[0] || "";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

const R = {
  hotels: (hotels) => hotels.length === 1
    ? `${hotels[0].name} is currently the only hotel available on this platform.` +
      (hotels[0].address ? ` It's in ${hotels[0].address}.` : "") +
      " Would you like me to check room availability there?"
    : `The hotels available on this platform are ${list(hotels.map(h => h.name))}. Which one would you like me to check?`,

  onlyHotel: (hotels) => hotels.length === 1
    ? `I can only help with bookings at ${hotels[0].name} — it's currently the only hotel available on this platform. Would you like me to check availability there?`
    : `I can only help with bookings at ${list(hotels.map(h => h.name))}. Which one would you like me to check?`,

  lookupFailed: () =>
    "I'm sorry — I couldn't reach our reservations system just now, so I can't check availability or bookings. " +
    "Nothing has been booked. Please try again in a moment, or contact the front desk.",

  confirmIntent: () => "Would you like me to check room availability?",

  /* How many rooms, of which types, at what rates — from the rooms table
     (active rooms only), never from memory. */
  roomInfo: (hotel, rooms) => {
    if (!rooms.length) return `I'm sorry — no rooms at ${hotel.name} are open for booking at the moment. Please contact the front desk.`;
    const order = ["Normal", "Luxury"];
    const types = [...new Set(rooms.map(r => r.room_type))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const parts = types.map(t => {
      const of = rooms.filter(r => r.room_type === t);
      const prices = of.map(r => r.price_per_night);
      const lo = Math.min(...prices), hi = Math.max(...prices);
      return `${F.plural(of.length, t + " room")} at ${hi > lo ? `${F.inr(lo)}–${F.inr(hi)}` : F.inr(lo)} a night`;
    });
    const cap = Math.max(...rooms.map(r => r.max_guests));
    return `${hotel.name} has ${F.plural(rooms.length, "room")}: ${list(parts)}.` +
      (types.includes("Luxury") ? " The Luxury rooms are our premium rooms." : "") +
      ` Each room sleeps up to ${cap} guests.` +
      (hotel.check_in_time && hotel.check_out_time ? ` Check-in is from ${F.time12(hotel.check_in_time)} and check-out by ${F.time12(hotel.check_out_time)}.` : "") +
      " Would you like me to check which rooms are free for your dates?";
  }
};

module.exports = R;
