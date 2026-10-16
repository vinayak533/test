/* ============================================================================
   server/chat.js — one guest turn, start to finish.

     input ─► sanitise ─► hotels (Supabase) ─► intent (Jev, else rules)
           ─► route:  hotel questions   → answered from the hotels table
                      booking flow      → server/booking/flow.js
                      booking look-up   → server/booking/lookup.js
                      anything else     → { handled: false }: the page's own
                                          knowledge base answers, as before

   A turn is either a typed `message` or a tapped option's `action`. The
   conversation's memory comes back as `state` (signed; see booking/state.js)
   and goes out the same way.

   Returns
     { handled: false }      not ours; the page keeps any booking state
     { handled: true, kind: "answer" | "clarify" | "error",
       reply, ui?, data?, desk?, state? }
                             state: a new token, or null to forget it;
                             absent when this turn leaves it unchanged
   ============================================================================ */

"use strict";

const { sanitizeMessage, InputError } = require("./sanitize");
const { classify, classifyWithRules } = require("./nlu/classify");
const flow = require("./booking/flow");
const { extract } = require("./booking/extract");
const { todayIn } = require("./dates");
const { handleLookup, readRef } = require("./booking/lookup");
const R = require("./responses");

const BOOKING_INTENTS = new Set(["check_room_availability", "make_reservation"]);
const CLARIFY_FLOOR = 0.35;

/* "2 luxury rooms from 20 Oct to 22 Oct" names no intent word, but it is
   plainly a booking request: a date together with rooms, guests or a type. */
function carriesBookingDetails(message, hotel, now){
  const x = extract(message, { today: todayIn(hotel.timezone || "Asia/Kolkata", now), step: null });
  const when = x.checkIn || x.checkOut;
  return !!(when && (x.rooms || x.guests || x.roomType || /\b(rooms?|stay|nights?)\b/i.test(message)));
}

function pickHotel(hotels, config){
  return hotels.find(h => h.id === config.defaultHotelId) || (hotels.length === 1 ? hotels[0] : null);
}

async function handleChat(input, deps){
  const { config, repo, jev, log, codec } = deps;
  const now = deps.now ? deps.now() : new Date();
  const st = codec.decode(input && input.state);
  const action = input && input.action != null ? input.action : null;
  const message = action ? null : sanitizeMessage(input && input.message, config.maxMessageChars);

  const encode = s => (s === undefined ? undefined : s ? codec.encode(s) : null);
  const finish = (r, extra = {}) => {
    const out = { handled: true, kind: r.kind, reply: r.reply, ...extra };
    if (r.ui && Object.keys(r.ui).length) out.ui = r.ui;
    if (r.data) out.data = r.data;
    if (r.desk) out.desk = true;
    if (r.error) out.error = r.error;
    const token = encode(r.state);
    if (token !== undefined) out.state = token;
    return out;
  };

  // ---- hotels --------------------------------------------------------------
  let hotels;
  try {
    hotels = await repo.listHotels();
  } catch (e){
    log.error("hotels.lookup_failed", { error: e.message });
    // Mid-booking, or plainly asking about rooms: say we cannot check rather
    // than letting the page answer as if nothing were wrong.
    const guess = message ? classifyWithRules(message, []).intent.name : null;
    if (action || (st && st.flow) || BOOKING_INTENTS.has(guess) || guess === "list_hotels" || guess === "guest_details"){
      return finish({ kind: "error", reply: R.lookupFailed(), desk: true, error: "hotels_unavailable" });
    }
    return { handled: false, error: "hotels_unavailable" };
  }
  const hotel = pickHotel(hotels, config);
  if (!hotel){
    log.error("hotels.none_active");
    if (action || (st && st.flow)) return finish({ kind: "error", reply: R.lookupFailed(), desk: true, error: "no_hotels" });
    return { handled: false, error: "no_hotels" };
  }

  const ctx = {
    hotel, hotels, repo, log, config, now,
    user: deps.user || null, authError: !!deps.authError,
    lookupLimited: deps.lookupLimited, lookupFailed: deps.lookupFailed
  };

  /* Any database failure inside the booking flow ends the turn with "we
     can't check right now" and leaves the conversation where it was —
     never a number, never "booked". Bad input still surfaces as a 400. */
  const guarded = async (run, extra) => {
    try {
      return finish(await run(), extra);
    } catch (e){
      if (e instanceof flow.ActionError) throw new InputError(e.message, "invalid action");
      if (e instanceof InputError) throw e;
      log.error("booking.turn_failed", { error: e.message });
      return finish({ kind: "error", reply: R.lookupFailed(), desk: true, error: "reservations_unavailable" }, extra);
    }
  };

  // ---- a tapped option -----------------------------------------------------
  if (action){
    return guarded(() => flow.handleAction(st, action, ctx), { intent: "booking", source: "action" });
  }

  // ---- a typed message -----------------------------------------------------
  const hotelAnswer = (n, tag) => {
    // Which hotels are there? Always from the table, never from memory.
    if (n.intent.name === "list_hotels" && n.intent.confidence >= config.intentThreshold){
      return finish({ kind: "answer", reply: R.hotels(hotels),
                      ui: { options: [{ label: "Check availability", action: { type: "start" }, tone: "primary" }] } }, tag);
    }
    // A hotel we do not have: say so, whatever the question was.
    if (n.hotel.kind === "other" && n.hotel.confidence >= config.hotelThreshold){
      return finish({ kind: "answer", reply: R.onlyHotel(hotels),
                      ui: { options: [{ label: "Check availability", action: { type: "start" }, tone: "primary" }] } }, tag);
    }
    return null;
  };

  // Mid-booking, most messages are answers ("2 PM", "20 Oct", "Asha Nair…")
  // that the flow reads itself, so Jev — a network round trip of a second or
  // more — is consulted only when the flow does not recognise the message.
  // The rules still catch what must interrupt a booking: a question about
  // which hotels there are, or another hotel by name.
  if (st && st.flow === "booking"){
    const quick = classifyWithRules(message, hotels);
    const qtag = { intent: quick.intent.name, source: "rules" };
    const h = hotelAnswer(quick, qtag);
    if (h) return h;
    let r;
    try { r = await flow.handleText(st, message, ctx); }
    catch (e){ return guarded(() => { throw e; }, { ...qtag, intent: "booking" }); }
    if (r) return finish(r, { ...qtag, intent: "booking" });
  }

  let nlu;
  try {
    nlu = await classify(message, hotels, { jev, fallback: config.nluFallback, log });
  } catch (e){
    log.error("nlu.unavailable", { error: e.message });
    nlu = classifyWithRules(message, hotels);
  }
  const intent = nlu.intent.name;
  const confident = nlu.intent.confidence >= config.intentThreshold;
  const tag = { intent, source: nlu.source };

  const h = hotelAnswer(nlu, tag);
  if (h) return h;

  // About the rooms themselves: count, types and rates from the rooms table.
  // Mid-booking the conversation is kept and can be picked up again.
  if (intent === "room_info" && confident){
    const midBooking = !!(st && st.flow === "booking");
    return guarded(async () => ({
      kind: "answer",
      reply: R.roomInfo(hotel, await repo.getRooms(hotel.id)),
      ui: { options: [midBooking
        ? { label: "Continue booking", action: { type: "resume" }, tone: "primary" }
        : { label: "Check availability", action: { type: "start" }, tone: "primary" }] }
    }), tag);
  }

  if ((st && st.flow === "lookup") || intent === "guest_details" || readRef(message)){
    return guarded(() => handleLookup(st, message, ctx), { ...tag, intent: "guest_details" });
  }

  if (!(st && st.flow === "booking") && (BOOKING_INTENTS.has(intent) || carriesBookingDetails(message, hotel, now))){
    if (confident || !BOOKING_INTENTS.has(intent)){
      return guarded(() => flow.start(message, ctx), tag);
    }
    if (nlu.intent.confidence >= CLARIFY_FLOOR){
      return finish({ kind: "clarify", reply: R.confirmIntent(),
                      ui: { options: [{ label: "Yes, check availability", action: { type: "start" }, tone: "primary" }] } }, tag);
    }
  }

  // Not ours. The page answers from its knowledge base; a booking in
  // progress stays exactly where it was.
  return { handled: false, ...tag, bookingActive: !!(st && st.flow === "booking") };
}

module.exports = { handleChat };
