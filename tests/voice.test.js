"use strict";

/* Voice is another way of typing: the words Whisper writes go into the chat
   field, the guest sends them, and they arrive here as an ordinary message
   through the same intent rules, booking flow and repository. These tests
   are the requests a guest says aloud, written the way speech-to-text
   writes them (capitalised, punctuated, numbers sometimes as words), and the
   progress steps the page animates while a turn runs. Today is Fri 16 Oct
   2026 (tests/helpers.js). */

const test = require("node:test");
const assert = require("node:assert/strict");
const { conversation, fakeRepo, optionLabels, HOTEL, ROOMS, ROYAL, ROYAL_ROOMS, TAJ, TAJ_ROOMS, uuid } = require("./helpers");
const { extract } = require("../server/booking/extract");
const { STAGES, wantsProgress } = require("../server/app");

const hotels = [HOTEL, ROYAL, TAJ];
const roomsByHotel = { misty_mountain: ROOMS, royal_kuttikkanam: ROYAL_ROOMS, taj_kuttikkanam: TAJ_ROOMS };
const three = (opts = {}) => {
  const steps = [];
  const c = conversation({ repo: fakeRepo({ hotels, roomsByHotel }), hotelId: "misty_mountain",
                           progress: s => steps.push(s), ...opts });
  c.steps = steps;
  return c;
};
const kinds = c => c.repo.calls.map(([k]) => k);

/* ---- the requests from the brief ------------------------------------------ */

test('"Are there any rooms available at Taj Hotel tomorrow?" → a booking at Taj Hotel from tomorrow', async () => {
  const c = three();
  const out = await c.say("Are there any rooms available at Taj Hotel tomorrow?");
  assert.equal(out.hotel.id, "taj_kuttikkanam");
  assert.equal(c.decoded().checkIn, "2026-10-17");
  assert.equal(c.decoded().hotelId, "taj_kuttikkanam");
  assert.match(out.reply, /What time do you expect to arrive\?/);
});

test('"I need a room at Royal Hotel for two nights." → booking; the two nights wait for a check-in date', async () => {
  const c = three();
  let out = await c.say("I need a room at Royal Hotel for two nights.");
  assert.equal(out.hotel.id, "royal_kuttikkanam");
  assert.match(out.reply, /2 nights and 1 room\. What date would you like to check in\?$/);
  out = await c.say("October 25th.");
  assert.equal(c.decoded().checkIn, "2026-10-25");
  assert.equal(c.decoded().checkOut, "2026-10-27", "check-out from the nights said earlier");
  assert.equal(c.decoded().nights, undefined);
  assert.doesNotMatch(out.reply, /check out\?/, "check-out is not asked again");
});

test('"Book a room at Misty Mountain for two adults." → 2 guests, 1 room, and the dates are asked for', async () => {
  const c = three({ hotelId: "royal_kuttikkanam" });
  const out = await c.say("Book a room at Misty Mountain for two adults.");
  assert.equal(out.hotel.id, "misty_mountain");
  assert.equal(c.decoded().guests, 2);
  assert.equal(c.decoded().rooms, 1);
  assert.match(out.reply, /What date would you like to check in\?$/);
  assert.ok(!kinds(c).includes("hold"), "mentioning a booking holds nothing");
});

test('"What is the price of a luxury room?" → the rates from the rooms table', async () => {
  const c = three();
  const out = await c.say("What is the price of a luxury room?");
  assert.equal(out.intent, "room_info");
  assert.match(out.reply, /Luxury rooms at ₹4,500 a night/);
  assert.deepEqual(c.steps, ["understand", "rooms"]);
});

test('"I want to check out on October 27th." → check-out is kept and check-in is asked', async () => {
  const c = three();
  const out = await c.say("I want to check out on October 27th.");
  assert.equal(out.handled, true);
  assert.equal(c.decoded().checkOut, "2026-10-27");
  assert.equal(c.decoded().checkIn, undefined, "no check-in date is invented");
  assert.match(out.reply, /What date would you like to check in\?$/);
  await c.say("October 25th");
  assert.equal(c.decoded().checkIn, "2026-10-25");
  assert.equal(c.decoded().checkOut, "2026-10-27");
});

test('"Can I change my check-in date?" mid-booking → asks for the new date, keeps the rest, reads it back', async () => {
  const c = three();
  await c.say("Are there any rooms available at Royal Hotel for October 25th to October 27th?");
  await c.say("Around 2 PM.");
  await c.say("Two adults, one room.");
  let out = await c.say("Can I change my check-in date?");
  assert.equal(out.reply.startsWith("No problem. What date would you like to check in?"), true);
  assert.equal(c.decoded().checkIn, undefined);
  assert.equal(c.decoded().checkOut, "2026-10-27");
  assert.equal(c.decoded().guests, 2);
  out = await c.say("October 24th.");
  assert.match(out.reply, /^Got it — check-in Sat 24 Oct\./);
  assert.equal(c.decoded().hotelId, "royal_kuttikkanam");
});

/* ---- a whole booking, spoken ---------------------------------------------- */

test("the brief's voice conversation books at Misty Mountain only after the explicit confirmation", async () => {
  const c = three({ hotelId: "taj_kuttikkanam" });
  let out = await c.say("I want to book a room at Misty Mountain.");
  assert.equal(out.hotel.id, "misty_mountain");
  assert.match(out.reply, /What date would you like to check in\?$/);

  out = await c.say("October 25th to October 27th.");
  assert.match(out.reply, /check-in Sun 25 Oct and check-out Tue 27 Oct/);
  out = await c.say("Around 2 PM.");
  assert.match(out.reply, /How many guests/);
  out = await c.say("Two adults.");
  assert.match(out.reply, /Which room type would you prefer/);

  c.steps.length = 0;
  out = await c.say("Luxury, please.");
  assert.equal(out.ui.panel.type, "rooms");
  assert.deepEqual(out.ui.panel.available.map(r => r.number), [7, 8, 9, 10]);
  assert.deepEqual(c.steps, ["understand", "availability", "matching", "options"]);
  assert.ok(!kinds(c).includes("hold"));

  c.steps.length = 0;
  out = await c.say("I'll take room seven.");
  assert.match(out.reply, /^Room 7 \(Luxury\) is held for you/);
  assert.deepEqual(c.steps, ["understand", "availability", "hold"], "availability is re-read before holding");

  out = await c.say("Asha Nair, 98470 12345, asha at example dot com");
  assert.match(out.reply, /Here's your booking summary/);
  assert.deepEqual(out.ui.panel.guest, { name: "Asha Nair", phone: "+919847012345", email: "asha@example.com" });
  assert.ok(!kinds(c).includes("confirm"), "nothing is booked before the guest confirms");

  c.steps.length = 0;
  out = await c.say("Yes, confirm the booking.");
  assert.match(out.reply, /^Your booking is confirmed! Your booking reference is MM-TEST/);
  assert.deepEqual(c.steps, ["understand", "confirm"]);
  const rows = c.repo.res.filter(r => r.status === "confirmed");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hotel_id, "misty_mountain");
  assert.equal(rows[0].room_id, uuid(7));
  assert.equal(rows[0].guest_email, "asha@example.com");
});

test('"Yes, book it." books the rooms that were offered', async () => {
  const c = three();
  await c.say("Book a room at Misty Mountain from October 25th to October 27th for two adults.");
  await c.say("2 PM");
  const shown = await c.say("Normal room.");
  assert.equal(shown.ui.panel.type, "rooms");
  const out = await c.say("Yes, book it.");
  assert.match(out.reply, /^Room 1 \(Normal\) is held for you/);
});

test("a room taken by someone else between hearing and saying it is not held", async () => {
  const c = three();
  await c.say("Book a room at Misty Mountain from October 25th to October 27th for two adults.");
  await c.say("2 PM");
  await c.say("Luxury.");
  c.repo.res.push({ ref: "MM-OTHER", hotel_id: "misty_mountain", room_id: uuid(7), check_in: "2026-10-25", check_out: "2026-10-26", status: "confirmed", num_guests: 2 });
  const out = await c.say("Room 7, please.");
  assert.match(out.reply, /room 7 is no longer available for your dates/);
  assert.ok(!kinds(c).includes("hold"));
  assert.ok(!out.ui.panel.available.some(r => r.number === 7));
});

test('"Change my phone number" at the details step is a request, not the guest\'s name', async () => {
  const c = three();
  await c.say("Book a room at Misty Mountain from October 25th to October 27th for two adults.");
  await c.say("2 PM");
  await c.say("Normal.");
  await c.say("Yes, book it.");
  await c.say("Asha Nair, 98470 12345, asha@example.com");
  const out = await c.say("Change my phone number");
  assert.notEqual((c.decoded().guest || {}).name, "Change My");
  assert.equal(out.ui.form.type, "guest", "the details form comes back to edit");
});

test("changing a date after rooms are held gives the hold back", async () => {
  const c = three();
  await c.say("Book a room at Misty Mountain from October 25th to October 27th for two adults.");
  await c.say("2 PM");
  await c.say("Normal.");
  await c.say("Yes, book it.");
  assert.ok(c.decoded().hold);
  await c.say("I need to change the check-out date");
  assert.equal(c.decoded().hold, undefined);
  assert.ok(kinds(c).includes("release"));
});

/* ---- progress steps -------------------------------------------------------- */

test("progress: nothing free → no 'Preparing available options' step", async () => {
  const c = three();
  for (const r of ROOMS) c.repo.res.push({ ref: "MM-FULL", hotel_id: "misty_mountain", room_id: r.id, check_in: "2026-10-25", check_out: "2026-10-27", status: "confirmed", num_guests: 1 });
  await c.say("Book a room at Misty Mountain from October 25th to October 27th for two adults.");
  await c.say("2 PM");
  c.steps.length = 0;
  const out = await c.say("Either is fine.");
  assert.match(out.reply, /fully booked/);
  assert.deepEqual(c.steps, ["understand", "availability", "matching"]);
});

test("progress: a tapped option is not 'understood'; every step is a known one", async () => {
  const c = three();
  await c.tap({ type: "start", hotelId: "taj_kuttikkanam" });
  assert.deepEqual(c.steps, []);
  await c.say("October 25th to October 27th, 2 PM, two adults, one room, luxury");
  assert.ok(c.steps.every(s => STAGES.has(s)), c.steps.join());
});

test("progress: a listener that throws never breaks the turn", async () => {
  const c = three({ progress: () => { throw new Error("connection gone"); } });
  const out = await c.say("Are there any rooms available at Taj Hotel tomorrow?");
  assert.equal(out.handled, true);
  assert.equal(out.hotel.id, "taj_kuttikkanam");
});

test("progress streams only when the page asks for it", () => {
  assert.equal(wantsProgress({ accept: "application/x-ndjson, application/json" }), true);
  assert.equal(wantsProgress({ accept: "application/json" }), false);
  assert.equal(wantsProgress({}), false);
});

/* ---- reading speech-to-text output ---------------------------------------- */

test("room numbers said as words", () => {
  assert.deepEqual(extract("I'll take room seven.", { today: "2026-10-16", step: "select" }).roomNumbers, [7]);
  assert.deepEqual(extract("Rooms two and three, please.", { today: "2026-10-16", step: "select" }).roomNumbers, [2, 3]);
  assert.equal(extract("A room for two.", { today: "2026-10-16", step: "select" }).roomNumbers, undefined);
});

test("an email address as speech-to-text writes it, only where one is asked for", () => {
  const at = (s, step = "guest") => extract(s, { today: "2026-10-16", step }).email;
  assert.equal(at("asha at example dot com"), "asha@example.com");
  assert.equal(at("Asha Nair, asha.nair at the rate gmail.com"), "asha.nair@gmail.com");
  assert.equal(at("my email is asha at example.co.in", "review"), "asha@example.co.in");
  assert.equal(at("arriving at 2 dot 30", "arrivalTime"), undefined);
  assert.equal(extract("Asha Nair, asha at example dot com", { today: "2026-10-16", step: "guest" }).name, "Asha Nair");
});

/* ---- a quiet microphone ----------------------------------------------------- */

test("quiet audio is brought up to a standard level before transcription; loud audio is left alone", () => {
  const { normalizeWav, parseWav } = require("../server/stt/wav");
  // A 200 Hz tone stands in for speech; `click` adds a loud spike at the
  // start, as tapping the microphone button records on a laptop.
  const wav = (amp, click = 0) => {
    const n = 16000, b = Buffer.alloc(44 + n * 2);
    b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++){
      const v = i < 100 && click ? click * (i % 2 ? 1 : -1) : amp * Math.sin(2 * Math.PI * 200 * i / 16000);
      b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    return b;
  };
  const rmsOf = b => { let s = 0, n = 0; for (let a = 44 + 400; a < b.length; a += 2, n++) s += (b.readInt16LE(a) / 32768) ** 2; return Math.sqrt(s / n); };
  const peakOf = b => { let p = 0; for (let a = 44; a < b.length; a += 2) p = Math.max(p, Math.abs(b.readInt16LE(a))); return p / 32768; };

  const quiet = wav(0.03), q = normalizeWav(quiet);
  assert.ok(Math.abs(rmsOf(q.wav) - 0.1) < 0.005, "speech raised to -20 dBFS");
  assert.ok(peakOf(quiet) < 0.031, "the original is untouched");
  assert.deepEqual(parseWav(q.wav).seconds, parseWav(quiet).seconds);

  // The click is loud, the voice is quiet: the voice sets the gain, and the
  // click is limited instead of clipping.
  const clicked = normalizeWav(wav(0.03, 0.9));
  assert.ok(clicked.gain > 4, `gain ${clicked.gain} follows the voice, not the click`);
  assert.ok(Math.abs(rmsOf(clicked.wav) - 0.1) < 0.005);
  assert.ok(peakOf(clicked.wav) < 1);

  const faint = normalizeWav(wav(0.001));
  assert.equal(faint.gain, 40, "gain is capped, so near-silence stays faint");

  const loud = wav(0.5);
  assert.equal(normalizeWav(loud).wav, loud, "speech already at a good level is passed through");
});

/* ---- it books, it does not chat ------------------------------------------- */

test("an answer given ahead of its question is kept and said back; the question asked comes again", async () => {
  const c = three({ hotelId: "taj_kuttikkanam" });
  await c.say("Book a room at Taj Hotel from October 25 to October 27 for two adults");
  const out = await c.say("Normal");
  assert.equal(out.handled, true);
  assert.equal(c.decoded().roomType, "Normal");
  assert.match(out.reply, /^Got it — Normal rooms\. What time do you expect to arrive\?/);
  const next = await c.say("2 PM");
  assert.equal(next.ui.panel.type, "rooms", "straight on to the available rooms");
});

test("a short reply that isn't an answer re-asks the booking question instead of chatting", async () => {
  for (const hotelId of ["misty_mountain", "royal_kuttikkanam"]){
    const c = three({ hotelId });
    await c.say("Book a room from October 25 to October 27 for two adults");
    const out = await c.say("blue banana");
    assert.equal(out.handled, true, hotelId);
    assert.equal(out.intent, "booking");
    assert.match(out.reply, /^Sorry, I didn't catch that\. .*What time do you expect to arrive\?/);
    assert.ok(out.ui.options.length > 1, "with the question's own options");
  }
});

test("a real question mid-booking at Misty Mountain still goes to the knowledge base", async () => {
  const c = three();
  await c.say("Book a room from October 25 to October 27 for two adults");
  const out = await c.say("Do you serve breakfast?");
  assert.equal(out.handled, false);
  assert.equal(out.bookingActive, true);
});
