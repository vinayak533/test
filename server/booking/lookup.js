/* ============================================================================
   server/booking/lookup.js — "can you check my booking?"

   A booking is shown only to someone who has both its reference and the
   email address or mobile number it was made with. Whichever part is wrong,
   the answer is the same, so the reply never confirms that a reference
   exists. Failed attempts are limited per conversation and per address.
   ============================================================================ */

"use strict";

const F = require("./format");

const REF_RE = /\bMM[-\s]?([A-Z0-9]{6})\b/i;
const MAX_TRIES = 3;

function readRef(text){
  const m = String(text || "").match(REF_RE);
  return m ? "MM-" + m[1].toUpperCase() : null;
}

function panelFor(b, hotel){
  return {
    type: "summary", stage: "lookup", ref: b.booking_ref, hotel: hotel.name, status: b.status,
    checkIn: b.check_in, checkOut: b.check_out,
    checkInLabel: F.formatDay(b.check_in), checkOutLabel: F.formatDay(b.check_out),
    nights: b.nights, guests: b.num_guests,
    arrival: F.time12(b.arrival_time), departure: F.time12(b.departure_time),
    rooms: b.rooms.map(r => ({ number: r.room_number, type: r.room_type, price: Number(r.price_per_night), priceLabel: F.inr(r.price_per_night), guests: r.num_guests, total: Number(r.total_price), totalLabel: F.inr(r.total_price) })),
    total: Number(b.total_price), totalLabel: F.inr(b.total_price),
    guest: { name: b.guest_name, email: F.maskEmail(b.guest_email), phone: F.maskPhone(b.guest_phone) }
  };
}

const STATUS_WORDS = {
  confirmed: "confirmed", checked_in: "checked in", checked_out: "completed",
  cancelled: "cancelled", no_show: "marked as a no-show", mixed: "partly updated"
};

async function handleLookup(st, message, ctx){
  const s = st && st.flow === "lookup" ? st : { v: 1, flow: "lookup", hotelId: ctx.hotel.id, tries: 0 };
  const ref = readRef(message);
  if (ref) s.ref = ref;

  if (!s.ref){
    return { kind: "clarify", state: s,
             reply: "I can look up your booking. What's your booking reference? It looks like MM-AB12CD.",
             ui: { hint: "Type your booking reference", options: [{ label: "Cancel", action: { type: "cancel" }, tone: "quiet" }] } };
  }

  // The contact detail: whatever is left once the reference is taken out.
  const rest = String(message || "").replace(REF_RE, " ").trim();
  const contact = (rest.match(/[^\s@]+@[^\s@]+\.[^\s@]+/) || [])[0]
               || ((rest.replace(/\D/g, "").length >= 10) ? rest : null);
  if (!contact){
    return { kind: "clarify", state: s,
             reply: `Thanks. For your security, please enter the email address or mobile number used for booking ${s.ref}.`,
             ui: { hint: "Email address or mobile number", options: [{ label: "Cancel", action: { type: "cancel" }, tone: "quiet" }] } };
  }

  if (ctx.lookupLimited && ctx.lookupLimited()){
    return { kind: "error", state: null, desk: true,
             reply: "Too many look-up attempts from this connection. Please wait a little and try again, or contact the front desk." };
  }

  let b;
  if (typeof ctx.progress === "function") try { ctx.progress("lookup"); } catch { /* a courtesy only */ }
  try { b = await ctx.repo.findBooking(s.ref, contact); }
  catch (e){
    ctx.log.error("lookup.failed", { error: e.message });
    return { kind: "error", state: s, desk: true,
             reply: "I'm sorry — I couldn't reach our reservations system just now, so I can't look up your booking. Please try again in a moment, or contact the front desk." };
  }

  if (!b){
    s.tries = (s.tries || 0) + 1;
    ctx.lookupFailed && ctx.lookupFailed();
    ctx.log.info("lookup.no_match", { tries: s.tries });
    if (s.tries >= MAX_TRIES){
      return { kind: "error", state: null, desk: true,
               reply: "I couldn't find a booking matching those details. For your security I'll stop here — please contact the front desk and they'll help you." };
    }
    const keep = { ...s };
    delete keep.ref;
    return { kind: "clarify", state: keep,
             reply: "I couldn't find a booking matching that reference and contact detail. Please check both and send the booking reference again.",
             ui: { hint: "Booking reference, e.g. MM-AB12CD", options: [{ label: "Cancel", action: { type: "cancel" }, tone: "quiet" }] } };
  }

  ctx.log.info("lookup.found", { status: b.status });
  // A reference is unique across every hotel, so the booking says which
  // hotel it is at — not whichever one the page happens to have selected.
  const hotel = (ctx.hotels || []).find(h => h.id === b.hotel_id) || ctx.hotel;
  return {
    kind: "answer", state: null,
    reply: `I found booking ${b.booking_ref}: ${F.plural(b.rooms.length, "room")} at ${hotel.name} from ${F.formatDay(b.check_in)} to ${F.formatDay(b.check_out)}, ${STATUS_WORDS[b.status] || b.status}.`,
    data: { type: "booking", bookingRef: b.booking_ref, status: b.status },
    ui: { panel: panelFor(b, hotel), options: [{ label: "Book another stay", action: { type: "start" } }] }
  };
}

module.exports = { handleLookup, readRef, REF_RE };
