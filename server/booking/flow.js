/* ============================================================================
   server/booking/flow.js — the booking conversation.

   A slot-filling dialogue that asks only for what it does not know yet:

     check-in date → arrival time → check-out date (check-out time follows
     hotel policy) → guests and rooms → room type → live availability →
     choose rooms → "Book This Room" (a short hold) → guest details →
     summary → explicit "Confirm booking" → saved, reference returned

   Every answer can be a tap on an option or typed in the guest's own words;
   both arrive here as the same slot updates and go through the same checks.
   Nothing is written to the database until "Book This Room" (a hold that
   lapses on its own) and nothing is booked until "Confirm booking".

   Each turn returns { kind, reply, ui, state }:
     reply  plain text, from fixed templates
     ui     { options: [{ label, action }], date?, form?, panel?, hint? }
     state  the next conversation state (signed by the caller), or null
   ============================================================================ */

"use strict";

const { extract, normalizePhone, cleanName, EMAIL_RE } = require("./extract");
const { todayIn, addDays, diffDays, iso } = require("../dates");
const { newHoldToken, hashToken } = require("./state");
const { isHotelId } = require("../sanitize");
const F = require("./format");
const R = require("../responses");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESTART_RE = /^\s*(start (?:again|over)|restart|reset|begin again|new booking|start a new booking)\b/i;
const CANCEL_RE  = /^\s*(cancel(?: (?:this|the|my))?(?: booking| request| reservation)?|stop|never ?mind|forget it|quit|exit)\s*[.!]?\s*$/i;
const CONFIRM_RE = /^\s*(yes|yep|yeah|confirm|confirmed|book it|book now|go ahead|proceed|please confirm|confirm (?:the |my )?(?:booking|reservation)|that'?s (?:right|correct)|correct|ok(?:ay)?,? (?:confirm|book))\b/i;
const DECLINE_RE = /^\s*(no|nope|not yet|wait|hold on)\b/i;
const BOOK_IT_RE = /^\s*(book(?: it| this(?: room)?| these(?: rooms)?| them| now)?|yes|ok(?:ay)?|sure|go ahead|those|that one|these)\s*[.!]?\s*$/i;

/* ---- state ---------------------------------------------------------------- */

function fresh(hotel){ return { v: 1, flow: "booking", hotelId: hotel.id }; }

function guestComplete(st){ return !!(st.guest && st.guest.name && st.guest.phone && st.guest.email); }

function nextStep(st){
  if (!st.checkIn) return "checkIn";
  if (!st.arrival) return "arrivalTime";
  if (!st.checkOut) return "checkOut";
  if (!st.guests && !st.rooms) return "party";
  if (!st.guests) return "guests";
  if (!st.rooms) return "rooms";
  if (!st.roomType) return "roomType";
  if (!st.hold) return "select";
  if (!guestComplete(st)) return "guest";
  return "review";
}

/* ---- context -------------------------------------------------------------- */

function clock(ctx){
  const tz = ctx.hotel.timezone || "Asia/Kolkata";
  const today = todayIn(tz, ctx.now);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ctx.now);
  return { today, now: hm };
}

const limits = ctx => ({
  maxNights: Math.min(ctx.config.maxStayNights || 30, ctx.hotel.max_stay_nights || 30),
  maxDaysAhead: ctx.config.maxDaysAhead || 540
});

/* Room types, rates and capacity, read from the database once per turn. */
async function catalog(ctx){
  if (ctx._catalog) return ctx._catalog;
  const rooms = await ctx.repo.getRooms(ctx.hotel.id);
  const types = {};
  for (const r of rooms){
    const t = types[r.room_type] || (types[r.room_type] = { type: r.room_type, count: 0, minPrice: Infinity, maxPrice: 0, maxGuests: 0 });
    t.count++;
    t.minPrice = Math.min(t.minPrice, r.price_per_night);
    t.maxPrice = Math.max(t.maxPrice, r.price_per_night);
    t.maxGuests = Math.max(t.maxGuests, r.max_guests);
  }
  const order = ["Normal", "Luxury"];
  const list = Object.values(types).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  ctx._catalog = {
    rooms, types, list,
    activeRooms: rooms.length,
    maxGuests: Math.max(0, ...rooms.map(r => r.max_guests)),
    totalCapacity: rooms.reduce((n, r) => n + r.max_guests, 0)
  };
  return ctx._catalog;
}

function capFor(cat, roomType){
  if (roomType && roomType !== "any" && cat.types[roomType]) return cat.types[roomType].maxGuests;
  return cat.maxGuests;
}

/* ---- the hold ------------------------------------------------------------- */

async function dropHold(st, ctx){
  if (!st.hold) return;
  const { ref, token } = st.hold;
  delete st.hold;
  delete st.reviewed;
  try { await ctx.repo.releaseHold(ref, hashToken(token)); }
  catch (e){ ctx.log.warn("booking.release_failed", { error: e.message }); }   // it lapses on its own
}

/* ---- applying answers ----------------------------------------------------- */

const SLOT_LABEL = {
  checkIn: st => `check-in ${F.shortDay(st.checkIn)}`,
  arrival: st => st.arrival === "flexible" ? "arrival time to be confirmed" : `arriving around ${F.time12(st.arrival)}`,
  checkOut: st => `check-out ${F.shortDay(st.checkOut)}`,
  guests: st => F.plural(st.guests, "guest"),
  rooms: st => F.plural(st.rooms, "room"),
  roomType: st => st.roomType === "any" ? "any room type" : `${st.roomType} rooms`,
  departure: st => `leaving by ${F.time12(st.departure)}`
};

/* Applies whatever the guest gave us, in a fixed order, each through its own
   check. Returns { applied: [slot], notes: [text], error: text|null }. A
   failed check leaves that slot empty, so the next question re-asks it. */
async function apply(st, upd, ctx){
  const { today, now } = clock(ctx);
  const { maxNights, maxDaysAhead } = limits(ctx);
  const applied = [], notes = [];
  let error = null;
  const fail = msg => { if (!error) error = msg; };
  const hotel = ctx.hotel;

  // -- check-in
  if (upd.checkIn !== undefined && upd.checkIn !== st.checkIn){
    const d = upd.checkIn;
    if (!iso(...String(d).split("-").map(Number))) fail("I couldn't read that date. Could you choose one below, or type it like “20 Oct”?");
    else if (d < today) fail(`That date has already passed — today is ${F.formatDay(today)}. What date would you like to check in?`);
    else if (diffDays(today, d) > maxDaysAhead) fail("Our calendar doesn't open that far ahead yet. Could you choose a date within the next 18 months?");
    else {
      await dropHold(st, ctx);
      st.checkIn = d;
      applied.push("checkIn");
      if (st.checkOut && (st.checkOut <= d || diffDays(d, st.checkOut) > maxNights)){
        delete st.checkOut;
        notes.push("I've cleared your check-out date, as it no longer fits the new check-in.");
      }
      if (st.arrival && st.arrival !== "flexible" && d === today && st.arrival <= now) delete st.arrival;
    }
  }

  // -- check-out (as a date, or as a number of nights from check-in)
  let out = upd.checkOut;
  if (out === undefined && upd.nights && st.checkIn) out = addDays(st.checkIn, upd.nights);
  if (out !== undefined && out !== st.checkOut){
    if (!iso(...String(out).split("-").map(Number))) fail("I couldn't read that check-out date. Could you choose one below?");
    else if (out <= today) fail("Check-out has to be a future date. What date would you like to check out?");
    else if (st.checkIn && out <= st.checkIn) fail(`Check-out needs to be after your check-in date (${F.shortDay(st.checkIn)}). What date would you like to check out?`);
    else if (st.checkIn && diffDays(st.checkIn, out) > maxNights) fail(`I can book stays of up to ${maxNights} nights at a time. What date would you like to check out?`);
    else {
      await dropHold(st, ctx);
      st.checkOut = out;
      if (!st.departure) st.departure = hotel.check_out_time;
      applied.push("checkOut");
      notes.push(`Check-out is by ${F.time12(hotel.check_out_time)} on ${F.shortDay(out)}, as per hotel policy.`);
    }
  }

  // -- arrival time
  if (upd.arrival !== undefined && upd.arrival !== st.arrival){
    const t = upd.arrival;
    if (t !== "flexible" && !TIME_RE.test(t)) fail("I couldn't read that time. What time do you expect to arrive — for example “2 PM”?");
    else if (t !== "flexible" && st.checkIn === today && t <= now) fail(`It's already past ${F.time12(t)} at the hotel today. What time do you expect to arrive?`);
    else {
      st.arrival = t;
      applied.push("arrival");
      if (t !== "flexible" && t < hotel.check_in_time){
        notes.push(`Check-in begins at ${F.time12(hotel.check_in_time)}. If you arrive earlier we'll try to have your room ready, but early check-in can't be guaranteed and may carry a charge.`);
      } else if (t === "flexible"){
        notes.push(`No problem — check-in is from ${F.time12(hotel.check_in_time)} whenever you arrive.`);
      }
    }
  }

  // -- check-out time (only ever volunteered; policy sets the default)
  if (upd.departure !== undefined && upd.departure !== st.departure){
    const t = upd.departure;
    if (!TIME_RE.test(t)) fail("I couldn't read that check-out time.");
    else if (t > hotel.check_out_time){
      st.departure = hotel.check_out_time;
      notes.push(`Check-out is by ${F.time12(hotel.check_out_time)} under hotel policy, so I've noted ${F.time12(hotel.check_out_time)}. A later check-out can be requested at the front desk and may carry a charge.`);
    } else {
      st.departure = t;
      applied.push("departure");
    }
  }

  // -- guests and rooms
  if (upd.guests !== undefined || upd.rooms !== undefined || (upd.roomType !== undefined && st.guests && st.rooms)){
    const cat = await catalog(ctx);
    const g = upd.guests !== undefined ? upd.guests : st.guests;
    const r = upd.rooms !== undefined ? upd.rooms : st.rooms;
    const type = upd.roomType !== undefined ? upd.roomType : st.roomType;
    const cap = capFor(cat, type);
    const before = [st.guests, st.rooms].join();

    if (g !== undefined && (!Number.isInteger(g) || g < 1 || g > cat.totalCapacity)){
      fail(`We can host up to ${cat.totalCapacity} guests across our ${cat.activeRooms} rooms. How many guests will be staying?`);
    } else if (r !== undefined && (!Number.isInteger(r) || r < 1 || r > cat.activeRooms)){
      if (g !== undefined) st.guests = g;
      delete st.rooms;
      fail(`We have ${cat.activeRooms} rooms in total. How many rooms do you need?`);
    } else {
      if (g !== undefined) st.guests = g;
      if (r !== undefined) st.rooms = r;
      if (st.guests && st.rooms){
        if (st.rooms > st.guests){
          delete st.rooms;
          fail(`Each room needs at least one guest staying in it, so for ${F.plural(st.guests, "guest")} you'll need no more than ${F.plural(st.guests, "room")}. How many rooms do you need?`);
        } else if (st.guests > st.rooms * cap){
          const need = Math.ceil(st.guests / cap);
          delete st.rooms;
          fail(`Each ${type && type !== "any" ? type + " " : ""}room sleeps up to ${cap} guests, so ${F.plural(st.guests, "guest")} will need at least ${F.plural(need, "room")}. How many rooms would you like?`);
        }
      }
      if (upd.guests !== undefined && st.guests === upd.guests) applied.push("guests");
      if (upd.rooms !== undefined && st.rooms === upd.rooms) applied.push("rooms");
    }
    if ([st.guests, st.rooms].join() !== before) await dropHold(st, ctx);
  }

  // -- room type
  if (upd.roomType !== undefined && upd.roomType !== st.roomType && !error){
    const cat = await catalog(ctx);
    const t = upd.roomType;
    const info = cat.types[t];
    if (t !== "any" && !info){
      fail(`We don't have ${t} rooms available to book at the moment. Which room type would you prefer?`);
    } else if (t !== "any" && st.rooms && st.rooms > info.count){
      fail(`We have ${F.plural(info.count, t + " room")} in total, so ${F.plural(st.rooms, "room")} of that type isn't possible. Would you like a different type, or either?`);
    } else if (t !== "any" && st.guests && st.rooms && st.guests > st.rooms * info.maxGuests){
      fail(`Our ${t} rooms sleep up to ${info.maxGuests} guests each, which isn't enough for ${F.plural(st.guests, "guest")} in ${F.plural(st.rooms, "room")}. Would you like a different type, or more rooms?`);
    } else {
      await dropHold(st, ctx);
      st.roomType = t;
      applied.push("roomType");
    }
  }

  return { applied, notes, error };
}

/* ---- questions ------------------------------------------------------------ */

const restartOpt = { label: "Start over", action: { type: "restart" }, tone: "quiet" };

function setOpt(label, slot, value){ return { label, action: { type: "set", slot, value } }; }

async function ask(st, ctx, prefix = "", { intro = false } = {}){
  const step = nextStep(st);
  const { today, now } = clock(ctx);
  const { maxNights, maxDaysAhead } = limits(ctx);
  const hotel = ctx.hotel;
  st.asked = step;
  const say = (q, ui = {}, kind = "clarify") => ({ kind, reply: [prefix, q].filter(Boolean).join(" "), ui, state: st });

  switch (step){
    case "checkIn": {
      const opts = [];
      if (now < "22:00") opts.push(setOpt(`Today · ${F.shortDay(today)}`, "checkIn", today));
      opts.push(setOpt(`Tomorrow · ${F.shortDay(addDays(today, 1))}`, "checkIn", addDays(today, 1)));
      opts.push(setOpt(F.shortDay(addDays(today, 2)), "checkIn", addDays(today, 2)));
      // The coming Friday, or the one after if that is already offered.
      let toFri = ((5 - new Date(today + "T00:00:00Z").getUTCDay()) + 7) % 7;
      if (toFri <= 2) toFri += 7;
      opts.push(setOpt(F.shortDay(addDays(today, toFri)), "checkIn", addDays(today, toFri)));
      const q = intro
        ? `I'd be happy to check room availability at ${hotel.name}. What date would you like to check in?`
        : "What date would you like to check in?";
      return say(q, {
        options: opts.concat(st.checkOut || st.guests ? [restartOpt] : []),
        date: { slot: "checkIn", min: today, max: addDays(today, maxDaysAhead), label: "Pick a check-in date" },
        hint: "Tap a date, or type one — e.g. “20 Oct”"
      });
    }
    case "arrivalTime": {
      let times = ["12:00", "14:00", "16:00", "18:00", "20:00"];
      if (st.checkIn === today) times = times.filter(t => t > now);
      const opts = times.map(t => setOpt(F.time12(t) + (t < hotel.check_in_time ? " (early)" : t === hotel.check_in_time ? " (check-in)" : ""), "arrival", t));
      opts.push(setOpt("Not sure yet", "arrival", "flexible"), restartOpt);
      return say(`Great! What time do you expect to arrive? Check-in is from ${F.time12(hotel.check_in_time)}.`, {
        options: opts, hint: "Tap a time, or type one — e.g. “3:30 PM”"
      });
    }
    case "checkOut": {
      const opts = [1, 2, 3, 7].filter(n => n <= maxNights)
        .map(n => setOpt(`${n === 7 ? "1 week" : F.plural(n, "night")} · ${F.shortDay(addDays(st.checkIn, n))}`, "checkOut", addDays(st.checkIn, n)));
      opts.push(restartOpt);
      return say("And what date would you like to check out?", {
        options: opts,
        date: { slot: "checkOut", min: addDays(st.checkIn, 1), max: addDays(st.checkIn, maxNights), label: "Pick a check-out date" },
        hint: "Tap an option, or type a date — e.g. “22 Oct” or “3 nights”"
      });
    }
    case "party":
    case "guests":
    case "rooms": {
      const cat = await catalog(ctx);
      const cap = capFor(cat, st.roomType);
      let opts = [], q, hint;
      if (step === "party"){
        const pairs = [[1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 2], [8, 3]];
        opts = pairs.filter(([g, r]) => g <= r * cap && r <= cat.activeRooms)
          .map(([g, r]) => ({ label: `${F.plural(g, "guest")} · ${F.plural(r, "room")}`, action: { type: "set", slot: "party", value: { guests: g, rooms: r } } }));
        q = "How many guests will be staying, and how many rooms do you need?";
        hint = "Tap an option, or type — e.g. “5 guests, 2 rooms”";
      } else if (step === "guests"){
        for (let g = st.rooms; g <= Math.min(st.rooms * cap, st.rooms + 5); g++) opts.push(setOpt(F.plural(g, "guest"), "guests", g));
        q = `How many guests will be staying in the ${F.plural(st.rooms, "room")}?`;
        hint = "Tap a number, or type it";
      } else {
        const min = Math.ceil(st.guests / cap);
        for (let r = min; r <= Math.min(st.guests, cat.activeRooms, min + 3); r++) opts.push(setOpt(F.plural(r, "room"), "rooms", r));
        q = `How many rooms do you need for ${F.plural(st.guests, "guest")}? Each room sleeps up to ${cap}.`;
        hint = "Tap a number, or type it";
      }
      opts.push(restartOpt);
      return say(q, { options: opts, hint });
    }
    case "roomType": {
      const cat = await catalog(ctx);
      const opts = cat.list
        .filter(t => !st.rooms || t.count >= st.rooms)
        .map(t => setOpt(`${t.type} · ${F.inr(t.minPrice)}${t.maxPrice > t.minPrice ? "+" : ""}/night`, "roomType", t.type));
      opts.push(setOpt("Either is fine", "roomType", "any"), restartOpt);
      const prices = cat.list.map(t => `${t.type} (${t.maxPrice > t.minPrice ? "from " : ""}${F.inr(t.minPrice)} per night)`);
      return say(`Which room type would you prefer — ${F.list(prices).replace(/ and /, " or ")}? Or I can show you either.`, {
        options: opts, hint: "Tap a type, or type “Normal”, “Luxury” or “either”"
      });
    }
    case "select":
      return showRooms(st, ctx, prefix);
    case "guest": {
      const g = { ...(st.guestDraft || {}), ...(st.guest || {}) };
      // A signed-in guest starts from their own account's name and email.
      if (ctx.user){ g.name = g.name || ctx.user.name || ""; g.email = g.email || ctx.user.email || ""; }
      const missing = ["name", "phone", "email"].filter(k => !(st.guest || {})[k]);
      const q = missing.length === 3
        ? "To complete the booking, I'll need the lead guest's full name, mobile number and email address."
        : `I still need the guest's ${F.list(missing.map(k => ({ name: "full name", phone: "mobile number", email: "email address" })[k]))}.`;
      return say(q, {
        form: { type: "guest", name: g.name || "", phone: g.phone || "", email: g.email || "" },
        panel: holdPanel(st, ctx, "hold"),
        options: [{ label: "Change rooms", action: { type: "edit", what: "rooms" }, tone: "quiet" }, restartOpt],
        hint: "Fill in the form, or type — e.g. “Asha Nair, 98470 12345, asha@example.com”"
      });
    }
    case "review":
    default: {
      st.reviewed = true;
      const until = holdUntil(st, ctx);
      return say(`Here's your booking summary. Please check the details and tap Confirm booking to complete your reservation${until ? ` — the room${st.hold.rooms.length > 1 ? "s are" : " is"} held for you until ${until}` : ""}.`, {
        panel: holdPanel(st, ctx, "review"),
        options: [
          { label: "Confirm booking", action: { type: "confirm" }, tone: "primary" },
          { label: "Edit guest details", action: { type: "edit", what: "guest" } },
          { label: "Change rooms", action: { type: "edit", what: "rooms" } },
          restartOpt
        ],
        hint: "Tap Confirm booking, or type “confirm”"
      });
    }
  }
}

function holdUntil(st, ctx){
  if (!st.hold || !st.hold.expiresAt) return "";
  return new Intl.DateTimeFormat("en-IN", { timeZone: ctx.hotel.timezone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(st.hold.expiresAt)).toUpperCase();
}

function stayFields(st){
  return {
    checkIn: st.checkIn, checkOut: st.checkOut,
    checkInLabel: F.formatDay(st.checkIn), checkOutLabel: F.formatDay(st.checkOut),
    nights: diffDays(st.checkIn, st.checkOut),
    arrival: F.time12(st.arrival), departure: F.time12(st.departure),
    guests: st.guests
  };
}

function holdPanel(st, ctx, stage){
  const h = st.hold;
  return {
    type: "summary", stage,
    hotel: ctx.hotel.name,
    ...stayFields(st),
    rooms: h.rooms.map(r => ({ number: r.number, type: r.type, price: r.price, priceLabel: F.inr(r.price), guests: r.guests, total: r.total, totalLabel: F.inr(r.total) })),
    total: h.total, totalLabel: F.inr(h.total),
    holdUntil: holdUntil(st, ctx),
    guest: stage === "review" ? { ...st.guest } : null
  };
}

/* ---- availability --------------------------------------------------------- */

/* Picks `n` rooms for the guests: cheapest first, then lowest number, unless
   that leaves too few beds, in which case the roomiest first. */
function preselect(rooms, n, guests){
  const cheap = [...rooms].sort((a, b) => a.price_per_night - b.price_per_night || a.room_number - b.room_number).slice(0, n);
  if (cheap.reduce((s, r) => s + r.max_guests, 0) >= guests) return cheap;
  return [...rooms].sort((a, b) => b.max_guests - a.max_guests || a.price_per_night - b.price_per_night).slice(0, n);
}

function describeRooms(rooms){
  const groups = new Map();
  for (const r of rooms){
    const k = r.room_type + "|" + r.price_per_night;
    if (!groups.has(k)) groups.set(k, { type: r.room_type, price: r.price_per_night, numbers: [] });
    groups.get(k).numbers.push(r.room_number);
  }
  return [...groups.values()].map(g =>
    `${g.type} room${g.numbers.length > 1 ? "s" : ""} ${F.list(g.numbers)} at ${F.inr(g.price)} per night`);
}

async function showRooms(st, ctx, prefix = ""){
  st.asked = "select";
  let avail;
  try {
    avail = await ctx.repo.getAvailability(st.hotelId, st.checkIn, st.checkOut);
  } catch (e){
    ctx.log.error("booking.availability_failed", { error: e.message });
    return lookupFailed(st, { type: "resume" });
  }
  if (!avail.length){
    ctx.log.error("booking.no_inventory", { hotel: st.hotelId });
    return lookupFailed(st, { type: "resume" });
  }

  const nights = diffDays(st.checkIn, st.checkOut);
  const free = avail.filter(r => r.is_available);
  const want = st.roomType === "any" ? free : free.filter(r => r.room_type === st.roomType);
  const typeWord = st.roomType === "any" ? "" : st.roomType + " ";
  const when = `${F.formatDay(st.checkIn)} to ${F.formatDay(st.checkOut)} (${F.plural(nights, "night")})`;
  const beds = rooms => rooms.reduce((s, r) => s + r.max_guests, 0);
  const capOk = want.length >= st.rooms && beds(preselect(want, st.rooms, st.guests)) >= st.guests;

  ctx.log.info("booking.availability", { checkIn: st.checkIn, checkOut: st.checkOut, type: st.roomType, free: free.length, matching: want.length, total: avail.length });

  if (capOk){
    const picked = preselect(want, st.rooms, st.guests);
    st.offer = picked.map(r => r.room_id);
    const count = want.length;
    const reply = [prefix,
      `Good news! ${count} ${typeWord}room${count === 1 ? " is" : "s are"} available at ${ctx.hotel.name} for ${when}: ${F.list(describeRooms(want))}.`,
      st.rooms === 1 ? "Choose a room and tap Book This Room." : `Choose ${st.rooms} rooms and tap Book These Rooms.`
    ].filter(Boolean).join(" ");
    return {
      kind: "answer", reply, state: st,
      data: { type: "availability", availableRooms: count, checkIn: st.checkIn, checkOut: st.checkOut, roomType: st.roomType },
      ui: {
        panel: {
          type: "rooms",
          hotel: ctx.hotel.name,
          ...stayFields(st),
          need: st.rooms,
          roomType: st.roomType,
          available: want.map(r => ({ id: r.room_id, number: r.room_number, type: r.room_type, price: r.price_per_night,
                                      priceLabel: F.inr(r.price_per_night), maxGuests: r.max_guests,
                                      stayTotal: r.price_per_night * nights, stayTotalLabel: F.inr(r.price_per_night * nights) })),
          selected: picked.map(r => r.room_id),
          freeCount: free.length,
          totalRooms: avail.length
        },
        options: [
          { label: "Change dates", action: { type: "edit", what: "dates" }, tone: "quiet" },
          { label: "Change guests or rooms", action: { type: "edit", what: "party" }, tone: "quiet" },
          restartOpt
        ],
        hint: st.rooms === 1 ? "Tap a room, or type e.g. “room 3”" : "Tick the rooms, or type e.g. “rooms 2 and 5”"
      }
    };
  }

  // Not enough of what was asked for: say exactly what there is, and offer
  // the nearest things that would work.
  const opts = [];
  let reply;
  if (!free.length){
    reply = `I'm sorry — ${ctx.hotel.name} is fully booked for ${when}.`;
  } else if (want.length === 0){
    reply = `I'm sorry — no ${typeWord}rooms are free for ${when}. ${F.plural(free.length, "room")} of another type ${free.length === 1 ? "is" : "are"} available: ${F.list(describeRooms(free))}.`;
  } else if (want.length < st.rooms){
    reply = `I'm sorry — only ${F.plural(want.length, typeWord + "room")} ${want.length === 1 ? "is" : "are"} free for ${when} (${F.list(describeRooms(want))}), and you asked for ${st.rooms}.`;
  } else {
    reply = `I'm sorry — the ${typeWord}rooms free for ${when} don't have enough beds for ${F.plural(st.guests, "guest")} in ${F.plural(st.rooms, "room")}.`;
  }
  if (st.roomType !== "any"){
    for (const t of ["Normal", "Luxury"].filter(t => t !== st.roomType)){
      const n = free.filter(r => r.room_type === t).length;
      if (n >= st.rooms) opts.push(setOpt(`See ${t} rooms (${n} free)`, "roomType", t));
    }
    if (free.length >= st.rooms && beds(preselect(free, st.rooms, st.guests)) >= st.guests) opts.push(setOpt("Either type", "roomType", "any"));
  }
  if (want.length && want.length < st.rooms && beds(want) >= st.guests) opts.push({ label: `Book ${F.plural(want.length, "room")} instead`, action: { type: "set", slot: "party", value: { guests: st.guests, rooms: want.length } } });
  opts.push({ label: "Change dates", action: { type: "edit", what: "dates" }, tone: opts.length ? "quiet" : "primary" }, restartOpt);
  delete st.offer;
  return {
    kind: "answer", reply: [prefix, reply, "Would you like to try something else?"].filter(Boolean).join(" "), state: st,
    data: { type: "availability", availableRooms: want.length, checkIn: st.checkIn, checkOut: st.checkOut, roomType: st.roomType },
    ui: { options: opts, panel: { type: "unavailable", ...stayFields(st), freeCount: free.length, totalRooms: avail.length, matching: want.length, need: st.rooms, roomType: st.roomType } }
  };
}

function lookupFailed(st, retry){
  return {
    kind: "error", desk: true, error: "reservations_unavailable", state: st,
    reply: "I'm sorry — I couldn't reach our reservations system just now, so I can't check which rooms are free. Nothing has been booked. Please try again in a moment, or contact the front desk.",
    ui: { options: [{ label: "Try again", action: retry, tone: "primary" }, restartOpt] }
  };
}

/* ---- signing in ------------------------------------------------------------

   Holding and confirming rooms need a signed-in guest account (config
   bookingRequiresSignIn), so every booking belongs to the person who made
   it. Questions and availability stay open to everyone. The conversation
   keeps its place: once signed in, "Continue booking" repeats the step. */
function needSignIn(st, ctx, retry){
  if (ctx.user || !ctx.config.bookingRequiresSignIn) return null;
  if (ctx.authError){
    return {
      kind: "error", desk: true, error: "auth_unavailable", state: st,
      reply: "I'm sorry — I couldn't check your sign-in just now, so I can't hold or book rooms. Nothing has been booked. Please try again in a moment.",
      ui: { options: [{ label: "Try again", action: retry, tone: "primary" }, restartOpt] }
    };
  }
  return {
    kind: "clarify", error: "sign_in_required", state: st,
    reply: "To book, please sign in or create a free account first, so the booking is saved to your account. I've kept your choices — once you're signed in, tap Continue booking.",
    ui: {
      auth: true,
      options: [{ label: "Continue booking", action: retry, tone: "primary" }, restartOpt],
      hint: "Sign in, then tap Continue booking"
    }
  };
}

/* ---- booking -------------------------------------------------------------- */

const HOLD_REASONS = {
  past_date: "That check-in date has already passed.",
  invalid_dates: "Those dates don't work — check-out has to be after check-in.",
  too_long: "That stay is longer than we can book in one go.",
  too_far: "Our calendar doesn't open that far ahead yet.",
  late_checkout: "That check-out time is later than hotel policy allows.",
  over_capacity: "Those rooms don't have enough beds for your party.",
  invalid_rooms: "I couldn't use that room selection."
};

async function book(st, pick, ctx){
  const step = nextStep(st);
  if (["checkIn", "arrivalTime", "checkOut", "party", "guests", "rooms", "roomType"].includes(step)) return ask(st, ctx);
  if (st.hold) return ask(st, ctx, "Your room is already held — let's finish the booking.");
  const gate = needSignIn(st, ctx, pick.ids ? { type: "book", roomIds: pick.ids } : { type: "resume" });
  if (gate) return gate;

  let avail;
  try { avail = await ctx.repo.getAvailability(st.hotelId, st.checkIn, st.checkOut); }
  catch (e){
    ctx.log.error("booking.availability_failed", { error: e.message });
    return lookupFailed(st, { type: "book", roomIds: pick.ids || [] });
  }
  const chosen = pick.ids
    ? avail.filter(r => pick.ids.includes(r.room_id))
    : avail.filter(r => pick.numbers.includes(r.room_number));
  const asked = pick.ids ? pick.ids.length : pick.numbers.length;

  if (chosen.length !== asked){
    const unknown = pick.numbers ? pick.numbers.filter(n => !avail.some(r => r.room_number === n)) : [];
    return showRooms(st, ctx, unknown.length
      ? `I couldn't find room ${F.list(unknown)} — please choose from the rooms below.`
      : "Some of those rooms aren't available to book. Here's what's free:");
  }
  const taken = chosen.filter(r => !r.is_available);
  if (taken.length){
    return showRooms(st, ctx, `I'm sorry — room ${F.list(taken.map(r => r.room_number))} ${taken.length === 1 ? "is" : "are"} no longer available for your dates.`);
  }
  if (chosen.length !== st.rooms){
    return showRooms(st, ctx, `You asked for ${F.plural(st.rooms, "room")}, so please choose exactly ${st.rooms}.`);
  }
  const beds = chosen.reduce((s, r) => s + r.max_guests, 0);
  if (beds < st.guests){
    return showRooms(st, ctx, `Those rooms sleep ${beds} in total, which isn't enough for ${F.plural(st.guests, "guest")}.`);
  }

  // Spread the party: one guest per room first, then fill the roomiest.
  const order = [...chosen].sort((a, b) => b.max_guests - a.max_guests || a.room_number - b.room_number);
  const guests = new Map(order.map(r => [r.room_id, 1]));
  let left = st.guests - order.length;
  for (const r of order){ const add = Math.min(left, r.max_guests - 1); guests.set(r.room_id, 1 + add); left -= add; }

  const token = newHoldToken();
  let res;
  try {
    res = await ctx.repo.holdRooms({
      hotelId: st.hotelId,
      roomIds: order.map(r => r.room_id),
      guests: order.map(r => guests.get(r.room_id)),
      checkIn: st.checkIn, checkOut: st.checkOut,
      arrival: st.arrival === "flexible" ? null : st.arrival,
      departure: st.departure || ctx.hotel.check_out_time,
      tokenHash: hashToken(token)
    });
  } catch (e){
    ctx.log.error("booking.hold_failed", { error: e.message });
    return lookupFailed(st, { type: "book", roomIds: order.map(r => r.room_id) });
  }

  if (!res || !res.ok){
    const reason = res && res.reason;
    ctx.log.info("booking.hold_refused", { reason });
    if (reason === "unavailable"){
      const n = (res.rooms || []).length ? `room ${F.list(res.rooms)}` : "one of those rooms";
      return showRooms(st, ctx, `I'm sorry — ${n} was just booked by another guest. Here's the updated availability:`);
    }
    if (reason === "past_date" || reason === "invalid_dates" || reason === "too_long" || reason === "too_far"){
      delete st.checkIn; delete st.checkOut;
      return ask(st, ctx, HOLD_REASONS[reason]);
    }
    return showRooms(st, ctx, HOLD_REASONS[reason] || "I couldn't hold those rooms.");
  }

  const b = res.booking;
  st.hold = {
    ref: b.booking_ref, token, expiresAt: b.hold_expires_at,
    total: Number(b.total_price), nights: b.nights,
    rooms: b.rooms.map(r => ({ id: r.room_id, number: r.room_number, type: r.room_type, price: Number(r.price_per_night), guests: r.num_guests, total: Number(r.total_price) }))
  };
  delete st.offer;
  ctx.log.info("booking.held", { rooms: st.hold.rooms.length, nights: b.nights });

  const label = st.hold.rooms.length === 1
    ? `Room ${st.hold.rooms[0].number} (${st.hold.rooms[0].type}) is`
    : `Rooms ${F.list(st.hold.rooms.map(r => r.number))} are`;
  return ask(st, ctx,
    `${label} held for you until ${holdUntil(st, ctx)} while you complete the booking — ${F.plural(b.nights, "night")}, ${F.inr(st.hold.total)} in total. It isn't booked until you confirm.`);
}

/* ---- guest details -------------------------------------------------------- */

function applyGuest(st, fields){
  const g = st.guest = st.guest || {};
  const errors = [];
  if (fields.name !== undefined){
    const n = cleanName(fields.name);
    if (n) g.name = n; else errors.push("Please enter the guest's full name (letters only).");
  }
  if (fields.phone !== undefined){
    const p = normalizePhone(fields.phone);
    if (p) g.phone = p; else errors.push("That mobile number doesn't look right — please include all 10 digits, or a + and country code.");
  }
  if (fields.email !== undefined){
    const e = String(fields.email).trim().toLowerCase();
    const m = e.match(EMAIL_RE);
    if (m && m[0] === e && e.length <= 254) g.email = e; else errors.push("That email address doesn't look right — please check it.");
  }
  delete st.reviewed;
  return errors;
}

/* ---- confirming ----------------------------------------------------------- */

async function confirm(st, ctx){
  if (!st.hold || !guestComplete(st) || !st.reviewed){
    return ask(st, ctx, st.hold ? "Let's check the details first." : "There's nothing to confirm yet.");
  }
  const gate = needSignIn(st, ctx, { type: "confirm" });
  if (gate) return gate;
  let res;
  try {
    res = await ctx.repo.confirmBooking({
      ref: st.hold.ref, tokenHash: hashToken(st.hold.token),
      name: st.guest.name, email: st.guest.email, phone: st.guest.phone,
      arrival: st.arrival === "flexible" ? null : st.arrival,
      departure: st.departure || ctx.hotel.check_out_time,
      userId: ctx.user ? ctx.user.id : null
    });
  } catch (e){
    // The request may or may not have reached the database. Say so, and make
    // retrying safe: the same reference and token can never book twice.
    ctx.log.error("booking.confirm_failed", { error: e.message });
    return {
      kind: "error", desk: true, error: "confirm_unavailable", state: st,
      reply: "I'm sorry — I couldn't reach our reservations system, so I can't tell whether your booking went through. Tapping Try again is safe: it will never book you twice. If it keeps failing, please contact the front desk.",
      ui: { options: [{ label: "Try again", action: { type: "confirm" }, tone: "primary" }, restartOpt] }
    };
  }

  if (res && res.ok){
    const b = res.booking;
    ctx.log.info("booking.confirmed", { rooms: b.rooms.length, nights: b.nights, already: !!res.already });
    const done = { v: 1, flow: null, hotelId: st.hotelId, lastRef: b.booking_ref };
    const rooms = b.rooms.map(r => ({ number: r.room_number, type: r.room_type, price: Number(r.price_per_night), priceLabel: F.inr(r.price_per_night), guests: r.num_guests, total: Number(r.total_price), totalLabel: F.inr(r.total_price) }));
    return {
      kind: "answer", state: done,
      reply: `Your booking is confirmed! Your booking reference is ${b.booking_ref}. We look forward to welcoming you to ${ctx.hotel.name} on ${F.formatDay(b.check_in)}. Please keep this reference — you'll need it, with your email or phone number, to look the booking up.`,
      data: { type: "booking", bookingRef: b.booking_ref, status: b.status },
      ui: {
        panel: {
          type: "summary", stage: "confirmed", ref: b.booking_ref, hotel: ctx.hotel.name,
          ...stayFields(st), guests: b.num_guests,
          rooms, total: Number(b.total_price), totalLabel: F.inr(b.total_price),
          guest: { name: b.guest_name, email: b.guest_email, phone: b.guest_phone }
        },
        options: [{ label: "Book another stay", action: { type: "start" } }]
      }
    };
  }

  const reason = res && res.reason;
  ctx.log.info("booking.confirm_refused", { reason });
  if (reason === "unavailable" || reason === "not_found"){
    const which = res.rooms && res.rooms.length ? `room ${F.list(res.rooms)}` : "your room";
    delete st.hold; delete st.reviewed;
    return showRooms(st, ctx, reason === "unavailable"
      ? `I'm sorry — ${which} was booked by another guest before you confirmed, so I couldn't complete this booking. Nothing has been saved or charged. Here's the updated availability:`
      : "I'm sorry — that hold is no longer valid, so nothing was booked. Here's the current availability:");
  }
  if (reason === "invalid_guest"){
    st.guest = {};
    return ask(st, ctx, "Some of the guest details weren't accepted — please enter them again.");
  }
  if (reason === "late_checkout"){
    st.departure = ctx.hotel.check_out_time;
    return ask(st, ctx, `Check-out is by ${F.time12(ctx.hotel.check_out_time)} under hotel policy; I've updated that.`);
  }
  return lookupFailed(st, { type: "confirm" });
}

/* ---- entry points --------------------------------------------------------- */

async function start(message, ctx){
  const st = fresh(ctx.hotel);
  if (!message) return ask(st, ctx, "", { intro: true });
  const { today } = clock(ctx);
  const x = extract(message, { today, step: null });
  const upd = pickSlots(x);
  if (x.badDate) return ask(st, ctx, "I couldn't read that date.", { intro: true });
  const res = await apply(st, upd, ctx);
  return respond(st, ctx, res, { intro: true });
}

function pickSlots(x){
  const upd = {};
  for (const k of ["checkIn", "checkOut", "nights", "arrival", "departure", "guests", "rooms", "roomType"]){
    if (x[k] !== undefined) upd[k] = x[k];
  }
  return upd;
}

const QUESTION_STEPS = new Set(["checkIn", "arrivalTime", "checkOut", "party", "guests", "rooms", "roomType"]);

async function respond(st, ctx, { applied, notes, error }, { intro = false } = {}){
  let prefix;
  if (error){
    prefix = [notes.join(" "), error].filter(Boolean).join(" ");
    // Where the failed answer is the next question, the error text already
    // asks it, so it replaces the question and keeps its options. Further
    // along (availability, details) it goes in front of what is shown.
    const r = await ask(st, ctx, "", { intro: false });
    r.reply = QUESTION_STEPS.has(nextStep(st)) ? prefix : [prefix, r.reply].join(" ");
    return r;
  }
  const ORDER = ["checkIn", "arrival", "checkOut", "guests", "rooms", "roomType"];
  const shown = applied.filter(k => k !== "departure").sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (shown.length >= 2){
    prefix = `Got it — ${F.list(shown.map(k => SLOT_LABEL[k](st)))}.`;
    if (intro) prefix = `I'd be happy to help you book at ${ctx.hotel.name}. ${prefix}`;
  } else {
    prefix = "";
    if (intro && shown.length === 1) prefix = `I'd be happy to help you book at ${ctx.hotel.name}.`;
  }
  prefix = [prefix, ...notes].filter(Boolean).join(" ");
  const step = nextStep(st);
  // The arrival question carries its own "Great!"; avoid "Got it … Great!".
  const r = await ask(st, ctx, prefix, { intro: intro && !shown.length });
  if (step === "arrivalTime" && shown.length >= 2) r.reply = r.reply.replace("Great! ", "");
  return r;
}

/* A turn that is a typed message. Returns null when the message is not about
   the booking at all, so the caller can let the knowledge base answer it
   while the booking waits where it was. */
async function handleText(st, message, ctx){
  const step = nextStep(st);
  const lower = message.toLowerCase().trim();

  if (RESTART_RE.test(lower)) return handleAction(st, { type: "restart" }, ctx);
  if (CANCEL_RE.test(lower)) return handleAction(st, { type: "cancel" }, ctx);
  if (step === "review"){
    if (CONFIRM_RE.test(lower)) return confirm(st, ctx);
    if (DECLINE_RE.test(lower)) return ask(st, ctx, "No problem — nothing has been booked. Change anything you like, or confirm when you're ready.");
  }

  const { today } = clock(ctx);
  const x = extract(message, { today, step });

  if (step === "select"){
    if (x.roomNumbers) return book(st, { numbers: x.roomNumbers }, ctx);
    if (BOOK_IT_RE.test(lower) && st.offer && st.offer.length === st.rooms) return book(st, { ids: st.offer }, ctx);
  }

  if (step === "guest" || (st.hold && (x.email || x.phone))){
    const fields = {};
    if (x.name) fields.name = x.name;
    if (x.phone) fields.phone = x.phone;
    if (x.email) fields.email = x.email;
    if (x.badPhone) fields.phone = "invalid";
    if (Object.keys(fields).length){
      const errors = applyGuest(st, fields);
      const r = await ask(st, ctx, errors.join(" "));
      if (r.ui && r.ui.form) r.ui.form.errors = errors;
      return r;
    }
  }

  if (x.badDate && (step === "checkIn" || step === "checkOut")){
    return ask(st, ctx, "I couldn't read that date. Could you choose one below, or type it like “20 Oct”?");
  }
  if (x.loneDate){
    return {
      kind: "clarify", state: st,
      reply: `Is ${F.formatDay(x.loneDate)} your check-in or your check-out date?`,
      ui: { options: [setOpt("Check-in", "checkIn", x.loneDate), setOpt("Check-out", "checkOut", x.loneDate)] }
    };
  }

  const upd = pickSlots(x);
  if (!Object.keys(upd).length) return null;
  const res = await apply(st, upd, ctx);
  if (!res.applied.length && !res.error && !res.notes.length) return null;
  return respond(st, ctx, res);
}

const SLOTS = new Set(["checkIn", "checkOut", "arrival", "departure", "party", "guests", "rooms", "roomType"]);
const EDITS = new Set(["dates", "party", "roomType", "rooms", "guest"]);

class ActionError extends Error {}

/* Validates an action from a tapped option. Anything malformed is rejected
   outright — buttons only ever send these shapes. */
function readAction(a){
  if (!a || typeof a !== "object" || Array.isArray(a) || typeof a.type !== "string") throw new ActionError("invalid_action");
  switch (a.type){
    case "restart": case "cancel": case "resume": case "confirm":
      return { type: a.type };
    // The hotel itself was resolved by the caller (server/chat.js); only
    // its shape is checked here.
    case "start":
      if (a.hotelId != null && !isHotelId(a.hotelId)) throw new ActionError("invalid_hotel");
      return { type: "start" };
    case "switch":
      if (!isHotelId(a.hotelId)) throw new ActionError("invalid_hotel");
      return { type: "switch" };
    case "set": {
      if (!SLOTS.has(a.slot)) throw new ActionError("invalid_slot");
      const v = a.value;
      if (a.slot === "checkIn" || a.slot === "checkOut"){
        if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ActionError("invalid_value");
      } else if (a.slot === "arrival" || a.slot === "departure"){
        if (typeof v !== "string" || !(TIME_RE.test(v) || (a.slot === "arrival" && v === "flexible"))) throw new ActionError("invalid_value");
      } else if (a.slot === "party"){
        if (!v || typeof v !== "object" || !Number.isInteger(v.guests) || !Number.isInteger(v.rooms)) throw new ActionError("invalid_value");
        return { type: "set", slot: "party", value: { guests: v.guests, rooms: v.rooms } };
      } else if (a.slot === "guests" || a.slot === "rooms"){
        if (!Number.isInteger(v)) throw new ActionError("invalid_value");
      } else if (a.slot === "roomType"){
        if (!["Normal", "Luxury", "any"].includes(v)) throw new ActionError("invalid_value");
      }
      return { type: "set", slot: a.slot, value: v };
    }
    case "book": {
      if (!Array.isArray(a.roomIds) || !a.roomIds.length || a.roomIds.length > 10 || !a.roomIds.every(id => typeof id === "string" && UUID_RE.test(id))){
        throw new ActionError("invalid_rooms");
      }
      return { type: "book", roomIds: [...new Set(a.roomIds.map(s => s.toLowerCase()))] };
    }
    case "guest": {
      const out = { type: "guest" };
      for (const k of ["name", "phone", "email"]){
        if (a[k] === undefined) continue;
        if (typeof a[k] !== "string" || a[k].length > 254) throw new ActionError("invalid_value");
        out[k] = a[k];
      }
      return out;
    }
    case "edit":
      if (!EDITS.has(a.what)) throw new ActionError("invalid_edit");
      return { type: "edit", what: a.what };
    default:
      throw new ActionError("invalid_action");
  }
}

async function handleAction(st, action, ctx){
  const a = readAction(action);
  const active = st && st.flow === "booking";

  if (a.type === "start"){
    // A new booking replaces one in progress: its hold is given back now
    // rather than left to lapse.
    if (active) await dropHold(st, ctx);
    return start(null, ctx);
  }
  if (a.type === "switch"){
    // The guest picked another hotel on the page. ctx.hotel is already the
    // new one; a booking in progress at the old one is stopped.
    if (active && st.hotelId === ctx.hotel.id) return ask(st, ctx, `You're already booking at ${ctx.hotel.name}.`);
    const from = active ? (ctx.hotels || []).find(h => h.id === st.hotelId) || null : null;
    const released = !!(active && st.hold);
    if (active) await dropHold(st, ctx);
    return {
      kind: "answer", state: null, reply: R.switched(ctx.hotel, from, released),
      ui: { options: [{ label: `Book at ${ctx.hotel.name}`, action: { type: "start", hotelId: ctx.hotel.id }, tone: "primary" }] }
    };
  }
  if (a.type === "confirm" && !active && st && st.lastRef){
    return { kind: "answer", state: st, reply: `Your booking ${st.lastRef} is already confirmed — there's nothing more to do.`,
             ui: { options: [{ label: "Book another stay", action: { type: "start" } }] } };
  }
  if (!active){
    if (a.type === "cancel") return { kind: "answer", state: null, reply: "No problem.", ui: {} };
    // An option from an earlier conversation: begin a fresh booking with it.
    const st2 = fresh(ctx.hotel);
    if (a.type === "set") return handleAction(st2, a, ctx);
    return start(null, ctx);
  }

  switch (a.type){
    case "restart":
      await dropHold(st, ctx);
      return ask(fresh(ctx.hotel), ctx, "Let's start again.", { intro: false });
    case "cancel":
      await dropHold(st, ctx);
      return { kind: "answer", state: null,
               reply: "No problem — I've cancelled this booking request. Nothing was booked.",
               ui: { options: [{ label: "Start a new booking", action: { type: "start" } }] } };
    case "resume":
      return ask(st, ctx);
    case "set": {
      const upd = a.slot === "party" ? { guests: a.value.guests, rooms: a.value.rooms } : { [a.slot]: a.value };
      const res = await apply(st, upd, ctx);
      return respond(st, ctx, res);
    }
    case "book":
      return book(st, { ids: a.roomIds }, ctx);
    case "guest": {
      const errors = applyGuest(st, a);
      const r = await ask(st, ctx, errors.join(" "));
      if (r.ui && r.ui.form) r.ui.form.errors = errors;
      return r;
    }
    case "confirm":
      return confirm(st, ctx);
    case "edit":
      if (a.what === "dates"){ await dropHold(st, ctx); delete st.checkIn; delete st.checkOut; delete st.arrival; delete st.departure; }
      if (a.what === "party"){ await dropHold(st, ctx); delete st.guests; delete st.rooms; }
      if (a.what === "roomType"){ await dropHold(st, ctx); delete st.roomType; }
      if (a.what === "rooms"){ await dropHold(st, ctx); }
      if (a.what === "guest"){ delete st.reviewed; st.guestDraft = st.guest; st.guest = {}; }
      return ask(st, ctx);
  }
  throw new ActionError("invalid_action");
}

module.exports = { start, handleText, handleAction, readAction, nextStep, ActionError, preselect };
