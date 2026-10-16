/* ============================================================================
   server/responses.js — fixed sentences outside the booking flow.

   No model writes these. The hotel list is built from the hotels table, so a
   second hotel added there would be named here without a code change — and
   no hotel that is not in the table can ever be named.
   ============================================================================ */

"use strict";

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

  confirmIntent: () => "Would you like me to check room availability?"
};

module.exports = R;
