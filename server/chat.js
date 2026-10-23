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

   Which hotel a turn is about (see pickHotel): a booking in progress keeps
   its own hotel; otherwise the hotel named in the message, else the one the
   page has selected (`hotelId`), else the site's own hotel. Every reply says
   which hotel it was about (`hotel`), so the page's selector can follow.

   Returns
     { handled: false, hotel }
                             not ours; the page keeps any booking state
     { handled: true, kind: "answer" | "clarify" | "error",
       reply, ui?, data?, desk?, state?, hotel }
                             state: a new token, or null to forget it;
                             absent when this turn leaves it unchanged
   ============================================================================ */

"use strict";

const { sanitizeMessage, isHotelId, InputError } = require("./sanitize");
const { classify, classifyWithRules } = require("./nlu/classify");
const flow = require("./booking/flow");
const { extract } = require("./booking/extract");
const { todayIn } = require("./dates");
const { handleLookup, readRef } = require("./booking/lookup");
const R = require("./responses");

const BOOKING_INTENTS = new Set(["check_room_availability", "make_reservation"]);
const CLARIFY_FLOOR = 0.35;

/* "2 luxury rooms from 20 Oct to 22 Oct" names no intent word, but it is
   plainly a booking request: a date (or a number of nights) together with
   rooms, guests or a type. So is "I want to check out on October 27th". */
function carriesBookingDetails(message, hotel, now){
  const x = extract(message, { today: todayIn(hotel.timezone || "Asia/Kolkata", now), step: null });
  const when = x.checkIn || x.checkOut || x.nights;
  return !!(when && (x.rooms || x.guests || x.roomType
    || /\b(rooms?|stay|nights?|check(?:ing)?[\s-]?(?:in|out))\b/i.test(message)));
}

/* The hotel a turn starts from: a booking in progress stays with its own
   hotel, then the page's selection, then the site's own hotel. A hotel named
   in the message is applied later, once the classifier has read it. */
function pickHotel(hotels, config, st, wanted){
  const byId = id => (id && hotels.find(h => h.id === id)) || null;
  return (st && st.flow === "booking" && byId(st.hotelId))
      || byId(wanted)
      || byId(config.defaultHotelId)
      || (hotels.length === 1 ? hotels[0] : null);
}

const startAt = hotel => ({ type: "start", hotelId: hotel.id });

/* Mid-booking, a few words with no question in them ("nromal", "the
   second one") are an attempt at an answer, not a question. */
const QUESTION_WORD = /^\s*(what|how|is|are|do|does|can|could|where|when|why|which|who|will|would|should|may|tell|show|any)\b/i;
function looksLikeAnswer(message){
  const words = message.trim().split(/\s+/).filter(Boolean);
  return words.length <= 4 && !message.includes("?") && !QUESTION_WORD.test(message);
}

async function handleChat(input, deps){
  if (input && input.mode === "desk") return handleDesk(input, deps);
  const { config, repo, jev, log, codec } = deps;
  const now = deps.now ? deps.now() : new Date();
  let st = codec.decode(input && input.state);
  // A front-desk conversation never carries over into the guest ChatBot.
  if (st && st.desk) st = null;
  const action = input && input.action != null ? input.action : null;
  const message = action ? null : sanitizeMessage(input && input.message, config.maxMessageChars);
  const wanted = input && isHotelId(input.hotelId) ? input.hotelId : null;
  let ctx = null;
  // A typed or spoken message is read before anything else happens; a tapped
  // option needs no reading.
  if (message) flow.report(deps, "understand");

  const encode = s => (s === undefined ? undefined : s ? codec.encode(s) : null);
  const about = () => (ctx && ctx.hotel ? { hotel: { id: ctx.hotel.id, name: ctx.hotel.name } } : {});
  const finish = (r, extra = {}) => {
    const out = { handled: true, kind: r.kind, reply: r.reply, ...extra, ...about() };
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
  const byId = id => (id && hotels.find(h => h.id === id)) || null;
  // A booking whose hotel has since been taken off the platform cannot go on.
  if (st && st.flow === "booking" && !byId(st.hotelId)){
    log.warn("booking.hotel_gone", { hotel: st.hotelId });
    st = null;
  }
  const hotel = pickHotel(hotels, config, st, wanted);
  if (!hotel){
    log.error("hotels.none_active");
    if (action || (st && st.flow)) return finish({ kind: "error", reply: R.lookupFailed(), desk: true, error: "no_hotels" });
    return { handled: false, error: "no_hotels" };
  }

  ctx = {
    hotel, hotels, repo, log, config, now,
    user: deps.user || null, authError: !!deps.authError,
    lookupLimited: deps.lookupLimited, lookupFailed: deps.lookupFailed,
    progress: deps.progress
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
  // "start" and "switch" may name the hotel they are for; no other action
  // can move a conversation to another hotel.
  if (action){
    if (typeof action === "object" && (action.type === "start" || action.type === "switch") && action.hotelId != null){
      const target = isHotelId(action.hotelId) ? byId(action.hotelId) : null;
      if (!target) throw new InputError("unknown_hotel", "that hotel is not on this platform");
      ctx.hotel = target;
    }
    return guarded(() => flow.handleAction(st, action, ctx), { intent: "booking", source: "action" });
  }

  // ---- a typed message -----------------------------------------------------
  // One "book here" button per hotel, the current one first.
  const hotelOptions = () => (hotels.length === 1
    ? [{ label: "Check availability", action: { type: "start" }, tone: "primary" }]
    : [ctx.hotel, ...hotels.filter(h => h !== ctx.hotel)].map((h, i) =>
        ({ label: `Book at ${h.name}`, action: startAt(h), ...(i === 0 ? { tone: "primary" } : {}) })));

  const hotelAnswer = (n, tag) => {
    // Which hotels are there? Always from the table, never from memory.
    if (n.intent.name === "list_hotels" && n.intent.confidence >= config.intentThreshold){
      return finish({ kind: "answer", reply: R.hotels(hotels), ui: { options: hotelOptions() } }, tag);
    }
    // A hotel we do not have: say so, whatever the question was.
    if (n.hotel.kind === "other" && n.hotel.confidence >= config.hotelThreshold){
      return finish({ kind: "answer", reply: R.onlyHotel(hotels), ui: { options: hotelOptions() } }, tag);
    }
    return null;
  };

  // Another of our hotels, by name.
  const namedHotel = n => (n.hotel.kind === "known" && n.hotel.confidence >= config.hotelThreshold
    && n.hotel.id !== ctx.hotel.id ? byId(n.hotel.id) : null);

  // Mid-booking, naming another hotel does not silently move the booking:
  // the guest chooses, and the current selection is kept until they do.
  const switchOffer = (other, tag) => finish({
    kind: "clarify", reply: R.switchOffer(ctx.hotel, other),
    ui: { options: [
      { label: `Book at ${other.name} instead`, action: startAt(other), tone: "primary" },
      { label: `Continue at ${ctx.hotel.name}`, action: { type: "resume" } }
    ] }
  }, tag);

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
    const other = namedHotel(quick);
    if (other) return switchOffer(other, qtag);
    let r;
    try { r = await flow.handleText(st, message, ctx); }
    catch (e){ return guarded(() => { throw e; }, { ...qtag, intent: "booking" }); }
    if (r) return finish(r, { ...qtag, intent: "booking" });
    // A short reply the flow could not read is a missed answer — a typo, or
    // a word speech-to-text got wrong — not a question for the knowledge
    // base: the booking question comes again rather than a chat reply.
    if (quick.intent.name === "general_question" && looksLikeAnswer(message)){
      return guarded(() => flow.askAgain(st, ctx, "Sorry, I didn't catch that."), { ...qtag, intent: "booking" });
    }
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

  const named = namedHotel(nlu);
  if (named){
    if (st && st.flow === "booking") return switchOffer(named, tag);
    ctx.hotel = named;
  }

  // About the rooms themselves: count, types and rates from the rooms table.
  // Mid-booking the conversation is kept and can be picked up again.
  if (intent === "room_info" && confident){
    const midBooking = !!(st && st.flow === "booking");
    flow.report(ctx, "rooms");
    return guarded(async () => ({
      kind: "answer",
      reply: R.roomInfo(ctx.hotel, await repo.getRooms(ctx.hotel.id)),
      ui: { options: [midBooking
        ? { label: "Continue booking", action: { type: "resume" }, tone: "primary" }
        : { label: "Check availability", action: startAt(ctx.hotel), tone: "primary" }] }
    }), tag);
  }

  if ((st && st.flow === "lookup") || intent === "guest_details" || readRef(message)){
    return guarded(() => handleLookup(st, message, ctx), { ...tag, intent: "guest_details" });
  }

  if (!(st && st.flow === "booking") && (BOOKING_INTENTS.has(intent) || carriesBookingDetails(message, ctx.hotel, now))){
    if (confident || !BOOKING_INTENTS.has(intent)){
      return guarded(() => flow.start(message, ctx), tag);
    }
    if (nlu.intent.confidence >= CLARIFY_FLOOR){
      return finish({ kind: "clarify", reply: R.confirmIntent(),
                      ui: { options: [{ label: "Yes, check availability", action: startAt(ctx.hotel), tone: "primary" }] } }, tag);
    }
  }

  // The page's knowledge base describes the site's own hotel only. For any
  // other hotel, say what can be answered rather than describe the wrong
  // place.
  const bookingActive = !!(st && st.flow === "booking");
  if (ctx.hotel.id !== config.defaultHotelId){
    // Mid-booking, the booking's own question follows straight on, so the
    // conversation stays a booking.
    if (bookingActive) return guarded(() => flow.askAgain(st, ctx, R.limitedInfo(ctx.hotel)), tag);
    return finish({ kind: "answer", reply: R.limitedInfo(ctx.hotel),
                    ui: { options: [bookingActive
                      ? { label: "Continue booking", action: { type: "resume" }, tone: "primary" }
                      : { label: `Book at ${ctx.hotel.name}`, action: startAt(ctx.hotel), tone: "primary" }] } }, tag);
  }

  // Not ours. The page answers from its knowledge base; a booking in
  // progress stays exactly where it was.
  return { handled: false, ...tag, bookingActive, ...about() };
}

/* ============================================================================
   The front desk: a receptionist on the phone with a caller, in the staff
   dashboard. Same flow, same database functions, same checks; what differs:

     who     a signed-in staff account that manages the hotel asked about
             (the hotels table for an agency administrator, hotel_staff for a
             hotel manager) — anyone else is refused before anything is read
     hotel   exactly the one the dashboard has selected. Naming another hotel
             moves nothing: the receptionist switches hotel in the menu
     intent  the deterministic rules only, never Jev: no round trip while a
             caller waits, and nothing typed at the desk leaves the server
     else    no knowledge base here, so anything that is not rooms, rates,
             availability or a booking gets a short pointer; an existing
             booking is found with the dashboard's own reservation search

   Every reply carries `request`: what the desk has understood so far.
   ============================================================================ */
async function handleDesk(input, deps){
  const { config, repo, log, codec } = deps;
  const now = deps.now ? deps.now() : new Date();
  let st = codec.decode(input.state);
  if (st && !st.desk) st = null;
  const action = input.action != null ? input.action : null;
  const message = action ? null : sanitizeMessage(input.message, config.maxMessageChars);
  if (!isHotelId(input.hotelId)) throw new InputError("invalid_hotel", "the desk needs a hotel");
  if (message) flow.report(deps, "understand");

  const tag = { intent: "desk", source: action ? "action" : "rules" };
  const encode = s => (s === undefined ? undefined : s ? codec.encode(s) : null);
  let hotel = null;
  const finish = (r, extra = {}) => {
    const out = { handled: true, kind: r.kind, reply: r.reply, ...tag, ...extra };
    if (hotel) out.hotel = { id: hotel.id, name: hotel.name };
    if (r.ui && Object.keys(r.ui).length) out.ui = r.ui;
    if (r.data) out.data = r.data;
    if (r.error) out.error = r.error;
    const token = encode(r.state);
    if (token !== undefined) out.state = token;
    // What the desk holds after this turn: the new state, or the old one when
    // the turn left it alone.
    const after = r.state === undefined ? st : r.state;
    out.request = flow.deskSummary(after);
    return out;
  };

  if (!deps.user){
    return finish({ kind: "error", error: deps.authError ? "auth_unavailable" : "desk_sign_in",
                    reply: deps.authError ? "I couldn't check your sign-in just now. Please try again in a moment."
                                          : "Please sign in with your staff account to use the front desk assistant." });
  }

  let hotels, allowed;
  try {
    [hotels, allowed] = await Promise.all([repo.listHotels(), repo.staffHotelIds(deps.user)]);
  } catch (e){
    log.error("desk.lookup_failed", { error: e.message });
    return finish({ kind: "error", reply: R.lookupFailed(), error: "hotels_unavailable" });
  }
  hotel = hotels.find(h => h.id === input.hotelId) || null;
  if (!hotel || !allowed.includes(hotel.id)){
    log.warn("desk.forbidden", { hotel: input.hotelId });
    hotel = null;
    return finish({ kind: "error", error: "desk_forbidden",
                    reply: "This account can't check rooms at that hotel. Choose one of your hotels from the menu." });
  }

  const ctx = {
    hotel, hotels, repo, log, config, now, desk: true,
    user: deps.user, authError: false,
    lookupLimited: deps.lookupLimited, lookupFailed: deps.lookupFailed,
    progress: deps.progress
  };

  // A conversation from another hotel (the selection changed under it) is
  // closed, its hold given back, and never read here.
  if (st && st.hotelId !== hotel.id){
    if (st.flow === "booking") await flow.dropHold(st, ctx);
    st = null;
  }

  const guarded = async run => {
    try { return finish(await run()); }
    catch (e){
      if (e instanceof flow.ActionError) throw new InputError(e.message, "invalid action");
      if (e instanceof InputError) throw e;
      log.error("desk.turn_failed", { error: e.message });
      return finish({ kind: "error", reply: R.lookupFailed(), error: "reservations_unavailable" });
    }
  };

  if (action){
    if (typeof action === "object" && (action.type === "switch" || (action.hotelId != null && action.hotelId !== hotel.id))){
      throw new InputError("invalid_action", "the desk changes hotel from the menu only");
    }
    return guarded(() => flow.handleAction(st, action, ctx));
  }

  const quick = classifyWithRules(message, hotels);
  const intent = quick.intent.name;

  // Another of our hotels by name: say how to get there; change nothing.
  if (quick.hotel.kind === "known" && quick.hotel.id !== hotel.id){
    const other = hotels.find(h => h.id === quick.hotel.id);
    return finish({ kind: "clarify", reply: R.deskOtherHotel(hotel, other) });
  }

  const x = extract(message, { today: todayIn(hotel.timezone || "Asia/Kolkata", now), step: null });
  const staySaid = !!(x.checkIn || x.checkOut || x.nights || x.guests || x.rooms);
  const booking = st && st.flow === "booking";

  // Rates: straight from the rooms table. A search in progress is kept.
  // ("the price of a luxury room" names one room, not a room count.)
  if (intent === "room_info" && !(x.checkIn || x.checkOut || x.nights || x.guests)){
    flow.report(ctx, "rooms");
    return guarded(async () => {
      const rooms = await repo.getRooms(hotel.id);
      return {
        kind: "answer", reply: R.deskRates(hotel, rooms, x.roomType),
        ui: { panel: R.ratesPanel(hotel, rooms),
              options: booking ? [{ label: "Back to the search", action: { type: "resume" }, tone: "primary" }] : [] }
      };
    });
  }

  // An existing booking: staff already search reservations in the
  // dashboard, scoped to this hotel, with no contact check to pass.
  if (intent === "guest_details" || readRef(message)){
    const ref = readRef(message);
    return finish({ kind: "answer", reply: R.deskLookup(ref), data: { type: "lookup", bookingRef: ref } });
  }

  if (booking){
    return guarded(async () => {
      const r = await flow.handleText(st, message, ctx);
      if (r) return r;
      return flow.askAgain(st, ctx, R.deskHelp(hotel, true));
    });
  }

  if (staySaid || x.roomType || BOOKING_INTENTS.has(intent)){
    return guarded(() => flow.start(message, ctx));
  }
  return finish({ kind: "clarify", reply: R.deskHelp(hotel, false) });
}

module.exports = { handleChat };
