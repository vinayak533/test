/* ============================================================================
   hotel_desk.js — the Desk assistant page of the staff dashboard.

   A receptionist on the phone types or speaks what the caller wants ("Luxury
   room for 3 adults from today for 2 nights"), reads live availability and
   prices off the screen, and books on request. Nothing here decides
   anything: every turn goes to POST /api/chat with mode "desk", where the
   same rules, Supabase functions and double-booking checks as the guest
   ChatBot run (server/chat.js handleDesk). This file only draws the answer.

     hotel     always the dashboard's selected hotel (hotel_admin.js sends
               "mm:desk-hotel"); changing it ends the call here and gives any
               held room back
     voice     the receptionist's own speech, into the text box to read and
               correct — never sent on its own, never spoken aloud. Whisper on
               this server (/api/transcribe) where it runs, else the
               browser's recognition
     memory    the conversation's signed state token, in a variable only, so
               each new detail adds to the request instead of starting over
     booking   rooms are held only on Book, and booked only on the Confirm
               booking button; typed or spoken "yes" never confirms

   Nothing is written to storage; "New caller" and signing out drop it all.
   ============================================================================ */

(function(){
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const view = $('[data-view-panel="assistant"]');
  if (!view) return;

  const text = $("#dkText"), send = $("#dkSend"), form = $("#dkForm");
  const API_URL = "/api/chat";
  const TIMEOUT_MS = 20000;
  const STAGES = {
    understand:   "Understanding the request",
    rooms:        "Reading room rates",
    availability: "Checking live availability",
    matching:     "Matching rooms to the request",
    options:      "Preparing the results",
    hold:         "Holding the room",
    confirm:      "Confirming the booking",
    lookup:       "Looking up the booking"
  };

  const D = {
    hotel: null,        // { id, name } — the dashboard's selection
    token: null,        // the conversation's signed state
    busy: false,
    picked: new Set(),  // room ids ticked in the results
    panel: null,        // the last rooms panel, for the Book bar
    history: []
  };

  /* ---- talking to the backend ------------------------------------------ */

  async function ask(payload, said){
    if (D.busy || !D.hotel) return;
    const hotelId = D.hotel.id;
    setBusy(true);
    steps([]);
    const reached = [];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let body = null, status = 0;
    try {
      const token = window.MMAuth ? await window.MMAuth.token() : null;
      const res = await fetch(API_URL, {
        method: "POST", signal: ctl.signal, credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json",
                   ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: JSON.stringify({ ...payload, state: D.token, hotelId, mode: "desk" })
      });
      if ((res.headers.get("content-type") || "").includes("application/x-ndjson")){
        ({ status, body } = await readStream(res, stage => { if (STAGES[stage]){ reached.push(stage); steps(reached); } }));
      } else {
        status = res.status;
        body = (res.headers.get("content-type") || "").includes("application/json") ? await res.json() : null;
      }
    } catch { body = null; status = 0; }
    finally { clearTimeout(timer); }
    // The hotel changed while this was in flight: its answer is not shown.
    if (!D.hotel || D.hotel.id !== hotelId){ setBusy(false); return; }
    setBusy(false);
    steps(reached, true);

    if (status === 200 && body && body.handled){
      if (body.state !== undefined) D.token = body.state;
      draw(body);
      remember(said, body.reply);
      if (body.data && (body.data.type === "booking") || (body.request && body.request.held)){
        window.dispatchEvent(new CustomEvent("mm:booking-changed"));
      }
      return;
    }
    const msg = status === 429 ? "Too many requests in a minute — wait a moment and try again."
              : status === 400 ? "That couldn't be read. Check the text and try again."
              : "Couldn't reach the reservations system. Nothing was booked — try again in a moment.";
    draw({ kind: "error", reply: msg });
    remember(said, msg);
  }

  /* One {"stage"} line per step as it happens, then {"status","body"}. */
  async function readStream(res, onStage){
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", last = null;
    for (;;){
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0){
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.stage) onStage(m.stage); else last = m;
      }
      if (done) break;
    }
    if (buf.trim()) last = JSON.parse(buf);
    return last || { status: 0, body: null };
  }

  function setBusy(on){
    D.busy = on;
    view.classList.toggle("is-busy", on);
    send.disabled = on || !text.value.trim();
    send.textContent = on ? "Checking…" : "Check";
    view.querySelectorAll("[data-act], .dk-book, .dk-form button").forEach(b => { b.disabled = on; });
  }

  /* The steps actually reached, in order; the last one spins until the
     answer arrives. */
  function steps(list, finished = false){
    const box = $("#dkSteps");
    if (!list.length && finished){ box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = (list.length ? list : ["understand"]).map((s, i, a) =>
      `<li class="${finished || i < a.length - 1 ? "is-done" : "is-now"}">${esc(STAGES[s])}</li>`).join("");
    if (finished) setTimeout(() => { if (!D.busy) box.hidden = true; }, 900);
  }

  /* ---- drawing an answer ------------------------------------------------- */

  function draw(r){
    const ui = r.ui || {};
    view.classList.add("has-call");
    request(r.request);

    $("#dkAnswer").hidden = false;
    const reply = $("#dkReply");
    reply.textContent = r.reply || "";
    reply.className = "dk-reply" + (r.kind === "error" ? " dk-reply--error" : r.kind === "clarify" ? " dk-reply--ask" : "");

    const opts = [];
    if (ui.date){
      opts.push(`<span class="dk-date"><label class="dk-sr" for="dkDate">${esc(ui.date.label)}</label>
        <input type="date" id="dkDate" min="${esc(ui.date.min)}" max="${esc(ui.date.max)}">
        <button type="button" class="dk-pill" data-date="${esc(ui.date.slot)}">Use date</button></span>`);
    }
    for (const o of ui.options || []){
      opts.push(`<button type="button" class="dk-pill${o.tone === "primary" ? " dk-pill--primary" : o.tone === "quiet" ? " dk-pill--quiet" : ""}"
        data-act='${esc(JSON.stringify(o.action))}'>${esc(o.label)}</button>`);
    }
    if (r.data && r.data.type === "lookup"){
      opts.push(`<button type="button" class="dk-pill dk-pill--primary" data-lookup="${esc(r.data.bookingRef || "")}">Open Reservations</button>`);
    }
    if (ui.hint) opts.push(`<span class="dk-hint">${esc(ui.hint)}</span>`);
    $("#dkOpts").innerHTML = opts.join("");

    const p = ui.panel;
    const out = $("#dkResult");
    // A question or an error with no new results keeps the last results on
    // screen, so the receptionist can keep reading prices while answering.
    const keep = !p && !ui.form && (r.kind === "error" || r.kind === "clarify");
    if (!keep){
      D.panel = null;
      if (ui.form && ui.form.type === "guest") out.innerHTML = (p ? summary(p) : "") + guestForm(ui.form);
      else if (!p) out.innerHTML = "";
      else if (p.type === "rooms") out.innerHTML = rooms(p);
      else if (p.type === "unavailable") out.innerHTML = unavailable(p);
      else if (p.type === "rates") out.innerHTML = rates(p);
      else if (p.type === "summary") out.innerHTML = summary(p);
      if (p && p.type === "rooms"){ D.panel = p; D.picked = new Set(p.selected || []); bookBar(); }
    }
    const first = out.querySelector(".dk-form input:not([value]), .dk-form input[value='']");
    if (first) first.focus({ preventScroll: true });
  }

  /* What has been understood so far — each detail a chip, assumptions
     marked, the main ones clearable with one tap. */
  function request(q){
    const bar = $("#dkRequest");
    if (!q){ bar.hidden = true; bar.innerHTML = ""; return; }
    const chip = (label, val, opts = {}) => `<span class="dk-chip${val ? "" : " dk-chip--empty"}${opts.soft ? " dk-chip--soft" : ""}">
      <small>${esc(label)}</small><b>${esc(val || "—")}</b>${opts.tag ? `<em>${esc(opts.tag)}</em>` : ""}
      ${val && opts.clear ? `<button type="button" class="dk-chip__x" data-act='${esc(JSON.stringify(opts.clear))}' aria-label="Clear ${esc(label.toLowerCase())}">×</button>` : ""}</span>`;
    const nights = q.nights ? `${q.nights} night${q.nights === 1 ? "" : "s"}` : null;
    bar.innerHTML = [
      chip("Check-in", q.checkInLabel, { clear: { type: "edit", what: "dates" } }),
      chip("Check-out", q.checkOutLabel ? q.checkOutLabel + (nights ? " · " + nights : "") : (nights ? nights : null), { tag: q.assumedNights ? "assumed" : "" , soft: q.assumedNights }),
      chip("Guests", q.party, { clear: { type: "edit", what: "party" } }),
      chip("Rooms", q.rooms ? String(q.rooms) : null, { tag: q.roomsAuto ? "suggested" : "", soft: q.roomsAuto }),
      chip("Type", q.roomType ? (q.roomType === "any" ? "Any" : q.roomType) : "Any", { clear: q.roomType && q.roomType !== "any" ? { type: "set", slot: "roomType", value: "any" } : null }),
      q.arrival ? chip("Arriving", q.arrival) : "",
      q.held ? chip("Held", `${q.held.ref} · ${q.held.totalLabel}`) : ""
    ].join("");
    bar.hidden = false;
  }

  const typeMark = t => t === "Luxury" ? '<span class="dk-type dk-type--lux">★ Luxury</span>' : `<span class="dk-type">${esc(t)}</span>`;
  const stay = p => `${esc(p.checkInLabel)} → ${esc(p.checkOutLabel)} · ${p.nights} night${p.nights === 1 ? "" : "s"}${p.assumedNights ? " (assumed)" : ""}`;

  /* Every room for those nights, free or not, in number order. */
  function strip(p){
    if (!p.rooms) return "";
    return `<div class="dk-strip" role="list" aria-label="All rooms for these nights">${p.rooms.map(r =>
      `<span role="listitem" class="dk-strip__r${r.free ? (r.match ? " is-match" : " is-free") : " is-taken"}${r.type === "Luxury" ? " is-lux" : ""}"
        title="Room ${r.number} · ${esc(r.type)} · ${r.free ? "free" : "booked"}">${r.number}<span class="dk-sr"> ${r.free ? "free" : "booked"}</span></span>`).join("")}</div>
      <p class="dk-strip__key"><span><i class="is-match"></i>Matches</span><span><i class="is-free"></i>Free, other type</span><span><i class="is-taken"></i>Booked or held</span></p>`;
  }

  /* Normal / Luxury / any, one tap — a quick filter on the same search. */
  function typeFilter(p){
    const cur = p.roomType || "any";
    return `<div class="dk-seg" role="group" aria-label="Room type">${[["any", "All types"], ["Normal", "Normal"], ["Luxury", "Luxury"]].map(([v, l]) =>
      `<button type="button" class="dk-seg__b" aria-pressed="${cur === v}" data-act='${esc(JSON.stringify({ type: "set", slot: "roomType", value: v }))}'>${l}</button>`).join("")}</div>`;
  }

  function rooms(p){
    const byType = {};
    for (const r of p.available){ (byType[r.type] = byType[r.type] || []).push(r); }
    const head = `<div class="dk-res__head">
        <div><span class="dk-big dk-big--ok">${p.available.length}</span>
          <span><b>${p.available.length === 1 ? "room matches" : "rooms match"}</b><small>${p.freeCount} of ${p.totalRooms} free · ${stay(p)}</small></span></div>
        ${typeFilter(p)}</div>`;
    const prices = Object.entries(byType).map(([t, list]) =>
      `<span class="dk-price">${typeMark(t)} <b>${esc(list[0].priceLabel)}</b>/night · ${esc(list[0].stayTotalLabel)} for the stay · sleeps ${list[0].maxGuests}</span>`).join("");
    const cards = p.available.map(r => `<label class="dk-room${r.type === "Luxury" ? " dk-room--lux" : ""}">
        <input type="checkbox" value="${esc(r.id)}" ${p.selected.includes(r.id) ? "checked" : ""}>
        <span class="dk-room__no">${r.number}</span>
        <span class="dk-room__t">${typeMark(r.type)}</span>
        <span class="dk-room__p"><b>${esc(r.priceLabel)}</b>/night</span>
        <span class="dk-room__s">${esc(r.stayTotalLabel)} · sleeps ${r.maxGuests}</span>
      </label>`).join("");
    return `<article class="mm-card dk-res">${head}<div class="dk-prices">${prices}</div>${strip(p)}
      <div class="dk-rooms" id="dkRooms">${cards}</div>
      <div class="dk-bookbar" id="dkBookBar"></div></article>`;
  }

  function bookBar(){
    const bar = $("#dkBookBar");
    if (!bar || !D.panel) return;
    const chosen = D.panel.available.filter(r => D.picked.has(r.id));
    const total = chosen.reduce((s, r) => s + r.stayTotal, 0);
    const need = D.panel.need;
    const note = !chosen.length ? (need ? `Tick ${need} room${need === 1 ? "" : "s"} to book` : "Tick the rooms the caller wants")
      : `Room${chosen.length === 1 ? "" : "s"} ${chosen.map(r => r.number).join(", ")} · ${inr(total)} for ${D.panel.nights} night${D.panel.nights === 1 ? "" : "s"}`;
    bar.innerHTML = `<span>${esc(note)}</span><button type="button" class="mm-btn mm-btn--gold dk-book" ${chosen.length && !D.busy ? "" : "disabled"}>
      Book ${chosen.length > 1 ? chosen.length + " rooms" : "room"}</button>`;
  }
  const inr = n => "₹" + Number(n).toLocaleString("en-IN");

  function unavailable(p){
    const by = (p.freeByType || []).map(t => `<span class="dk-price">${typeMark(t.type)} <b>${t.free}</b> free</span>`).join("");
    return `<article class="mm-card dk-res dk-res--none">
      <div class="dk-res__head"><div><span class="dk-big dk-big--none">0</span>
        <span><b>No match${p.matching ? " for that party" : ""}</b><small>${p.freeCount} of ${p.totalRooms} free · ${stay(p)}</small></span></div>${typeFilter(p)}</div>
      ${by ? `<div class="dk-prices">${by}</div>` : ""}${strip(p)}</article>`;
  }

  function rates(p){
    return `<article class="mm-card dk-res"><div class="dk-res__head"><div><span><b>Rates at ${esc(p.hotel)}</b>
      <small>Check-in from ${esc(p.checkInTime)} · check-out by ${esc(p.checkOutTime)}</small></span></div></div>
      <div class="dk-rates">${p.types.map(t => `<div class="dk-rate${t.type === "Luxury" ? " dk-rate--lux" : ""}">${typeMark(t.type)}
        <b>${esc(t.priceLabel)}</b><small>per night · ${t.count} rooms · sleeps ${t.maxGuests}</small></div>`).join("")}</div></article>`;
  }

  /* A held, reviewed or confirmed booking. */
  function summary(p){
    const done = p.stage === "confirmed";
    const lines = (p.rooms || []).map(r => `<tr><td>Room ${r.number} ${typeMark(r.type)}</td><td>${r.guests} guest${r.guests === 1 ? "" : "s"}</td>
      <td>${esc(r.priceLabel)} × ${p.nights}</td><td><b>${esc(r.totalLabel)}</b></td></tr>`).join("");
    const g = p.guest;
    return `<article class="mm-card dk-sum${done ? " dk-sum--done" : ""}">
      ${done ? `<div class="dk-sum__ref"><small>Booking reference</small><b id="dkRef">${esc(p.ref)}</b>
        <button type="button" class="dk-pill" data-copy="${esc(p.ref)}">Copy</button></div>`
             : `<p class="dk-sum__stage">${p.stage === "review" ? "Ready to confirm" : "Held — not booked yet"}${p.holdUntil ? ` · until ${esc(p.holdUntil)}` : ""}</p>`}
      <p class="dk-sum__stay"><b>${esc(p.hotel)}</b> · ${esc(p.checkInLabel)} → ${esc(p.checkOutLabel)} · ${p.nights} night${p.nights === 1 ? "" : "s"} · ${esc(p.party || (p.guests + " guests"))}</p>
      <div class="mm-table-wrap"><table class="dk-sum__t">${lines}<tr class="dk-sum__total"><td colspan="3">Total</td><td><b>${esc(p.totalLabel)}</b></td></tr></table></div>
      ${g && g.name ? `<p class="dk-sum__guest">${esc(g.name)} · ${esc(g.phone)} · ${esc(g.email)}${p.arrival && p.arrival !== "Not sure yet" ? ` · arriving ${esc(p.arrival)}` : ""}</p>` : ""}
    </article>`;
  }

  function guestForm(f){
    const err = (f.errors || []).map(e => `<li>${esc(e)}</li>`).join("");
    return `<form class="mm-card dk-form" id="dkGuest" novalidate>
      <h2>Caller's details</h2>
      ${err ? `<ul class="dk-form__err" role="alert">${err}</ul>` : ""}
      <div class="dk-form__grid">
        <label class="mm-field">Full name<input name="name" autocomplete="off" value="${esc(f.name)}" required></label>
        <label class="mm-field">Mobile<input name="phone" type="tel" inputmode="tel" autocomplete="off" value="${esc(f.phone)}" placeholder="98470 12345" required></label>
        <label class="mm-field">Email<input name="email" type="email" inputmode="email" autocomplete="off" value="${esc(f.email)}" required></label>
        <label class="mm-field">Arrival time <small>optional</small><input name="arrival" type="time" value="${esc(f.arrival || "")}"></label>
      </div>
      <button type="submit" class="mm-btn mm-btn--gold">Review booking</button>
    </form>`;
  }

  /* ---- the call so far --------------------------------------------------- */

  function remember(q, a){
    if (!q) return;
    D.history.push({ q, a });
    $("#dkHistory").hidden = false;
    $("#dkHistoryCount").textContent = "(" + D.history.length + ")";
    $("#dkHistoryList").innerHTML = D.history.map(h => `<li><b>${esc(h.q)}</b><span>${esc(h.a)}</span></li>`).join("");
  }

  /* Ends the call on screen. A held room is given back now rather than left
     to lapse, at the hotel it was held at. */
  function reset(release = true){
    if (release && D.token && D.hotel){
      const token = D.token, hotelId = D.hotel.id;
      (window.MMAuth ? window.MMAuth.token() : Promise.resolve(null)).then(t => fetch(API_URL, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) },
        body: JSON.stringify({ action: { type: "cancel" }, state: token, hotelId, mode: "desk" })
      })).catch(() => {});                                          // the hold lapses on its own anyway
    }
    D.token = null; D.picked = new Set(); D.panel = null; D.history = [];
    view.classList.remove("has-call");
    $("#dkRequest").hidden = true; $("#dkAnswer").hidden = true; $("#dkSteps").hidden = true; $("#dkHistory").hidden = true;
    $("#dkResult").innerHTML = ""; $("#dkHistoryList").innerHTML = "";
    text.value = ""; fit(); voice.stop(); voice.say("");
    send.disabled = true;
  }

  /* ---- events ------------------------------------------------------------ */

  function submitText(){
    const q = text.value.replace(/\s+/g, " ").trim();
    if (!q || D.busy) return;
    voice.stop();
    voice.say("");
    text.value = "";
    fit();
    ask({ message: q }, q);
  }
  form.addEventListener("submit", e => { e.preventDefault(); submitText(); });
  text.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); submitText(); }
  });
  text.addEventListener("input", () => { fit(); send.disabled = D.busy || !text.value.trim(); });
  /* The box grows with what is said, up to six lines or so, then scrolls. */
  function fit(){
    text.style.height = "auto";
    const want = text.scrollHeight + (text.offsetHeight - text.clientHeight);     // plus the border
    text.style.height = Math.max(52, Math.min(want, 180)) + "px";
    text.style.overflowY = want > 180 ? "auto" : "hidden";
  }

  $("#dkQuick").addEventListener("click", e => {
    const b = e.target.closest("[data-quick]");
    if (b) ask({ message: b.dataset.quick }, b.dataset.quick);
  });
  $("#dkNew").addEventListener("click", () => { reset(); text.focus(); });

  view.addEventListener("click", e => {
    const act = e.target.closest("[data-act]");
    if (act && !act.disabled){
      const a = JSON.parse(act.dataset.act);
      // "New caller" after a booking: a clean screen, as the header button.
      if (a.type === "start"){ reset(); text.focus(); return; }
      ask({ action: a }, act.textContent.replace(/[×\s]+/g, " ").trim() || "Option");
      return;
    }
    const d = e.target.closest("[data-date]");
    if (d){
      const v = $("#dkDate").value;
      if (v) ask({ action: { type: "set", slot: d.dataset.date, value: v } }, v);
      return;
    }
    if (e.target.closest(".dk-book") && D.panel){
      const ids = D.panel.available.filter(r => D.picked.has(r.id)).map(r => r.id);
      if (ids.length) ask({ action: { type: "book", roomIds: ids } }, "Book room" + (ids.length > 1 ? "s " : " ") +
        D.panel.available.filter(r => D.picked.has(r.id)).map(r => r.number).join(", "));
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy){
      navigator.clipboard && navigator.clipboard.writeText(copy.dataset.copy).then(() => { copy.textContent = "Copied"; }, () => {});
      return;
    }
    const look = e.target.closest("[data-lookup]");
    if (look){
      $("#globalSearchInput").value = look.dataset.lookup;
      $("#globalSearch").requestSubmit();
    }
  });
  view.addEventListener("change", e => {
    if (e.target.matches("#dkRooms input[type=checkbox]")){
      if (e.target.checked) D.picked.add(e.target.value); else D.picked.delete(e.target.value);
      bookBar();
    }
  });
  view.addEventListener("submit", e => {
    if (e.target.id !== "dkGuest") return;
    e.preventDefault();
    const f = e.target.elements;
    ask({ action: { type: "guest", name: f.name.value, phone: f.phone.value, email: f.email.value, arrival: f.arrival.value } }, "Caller's details");
  });

  window.addEventListener("mm:desk-hotel", e => {
    const h = e.detail;
    if ((h && h.id) === (D.hotel && D.hotel.id)){ D.hotel = h; showHotel(); return; }
    reset(true);
    D.hotel = h;
    showHotel();
  });
  window.addEventListener("mm:desk-shown", () => setTimeout(() => text.focus({ preventScroll: true }), 50));
  function showHotel(){
    $("#dkHotelName").textContent = D.hotel ? D.hotel.name : "—";
    form.classList.toggle("is-off", !D.hotel);
  }

  /* ---- voice --------------------------------------------------------------
     The receptionist's own words into the box, to read and correct before
     pressing Check. Tap to start and stop, or hold while speaking. */
  const voice = (function(){
    const mic = $("#dkMic"), note = $("#dkVoice");
    const STT_URL = "/api/transcribe", RATE = 16000, MAX_MS = 30000, HOLD_MS = 600;
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    const CAN_RECORD = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder
      && (window.AudioContext || window.webkitAudioContext) && window.OfflineAudioContext);
    let whisper = false, rec = null, hearing = null, working = null, press = null, tick = 0;

    function say(msg, tone){
      note.hidden = !msg;
      note.textContent = msg || "";
      note.dataset.tone = tone || "info";
    }
    function state(on){ mic.setAttribute("aria-pressed", on ? "true" : "false"); mic.classList.toggle("is-on", on); }
    const show = () => { mic.hidden = !(whisper && CAN_RECORD) && !Speech; };
    async function check(){
      if (!CAN_RECORD){ show(); return; }
      try {
        const r = await fetch(STT_URL, { headers: { Accept: "application/json" }, credentials: "same-origin" });
        const b = r.ok && (r.headers.get("content-type") || "").includes("application/json") ? await r.json() : null;
        whisper = !!(b && b.available);
      } catch { whisper = false; }
      show();
    }
    /* Words go after whatever is already in the box, never over it. */
    function put(words){
      const base = text.dataset.before || "";
      text.value = (base ? base + " " : "") + words;
      fit();
      send.disabled = D.busy || !text.value.trim();
    }
    function done(said){
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
      say(said ? "Check the text, edit it if needed, then press Check." : "Nothing was heard. Try again, or type it.", said ? "info" : "error");
    }

    function startHearing(){
      const r = new Speech();
      r.lang = "en-IN"; r.interimResults = true; r.continuous = true;
      let said = "", failed = "";
      text.dataset.before = text.value.trim();
      r.onresult = e => { said = [...e.results].map(x => x[0].transcript).join(" ").trim(); put(said); };
      r.onerror = e => { failed = e.error === "not-allowed" ? "Microphone access is blocked — allow it in the browser, or type." : e.error === "aborted" ? "" : "Voice input failed. Try again, or type."; };
      r.onend = () => { hearing = null; state(false); if (failed && !said) say(failed, "error"); else done(said); };
      hearing = r; state(true);
      try { r.start(); say("Listening… tap the microphone again when done.", "recording"); }
      catch { hearing = null; state(false); say("Voice input failed. Try again, or type.", "error"); }
    }

    async function startRecording(){
      const mine = rec = { chunks: [] };
      state(true);
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
      catch (e){
        rec = null; state(false);
        say(e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? "Microphone access is blocked — allow it in the browser, or type." : "No microphone was found. You can type instead.", "error");
        return;
      }
      if (rec !== mine){ stream.getTracks().forEach(t => t.stop()); return; }
      const mr = new MediaRecorder(stream);
      mine.mr = mr; mine.stream = stream;
      mr.ondataavailable = e => { if (e.data && e.data.size) mine.chunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        clearTimeout(mine.timer); clearInterval(tick);
        if (rec === mine) rec = null;
        state(false);
        if (!mine.cancelled) transcribe(new Blob(mine.chunks, { type: mr.mimeType || "audio/webm" }));
      };
      mine.timer = setTimeout(() => mr.state !== "inactive" && mr.stop(), MAX_MS);
      mr.start();
      const t0 = Date.now();
      const time = () => { const s = Math.floor((Date.now() - t0) / 1000); say(`Listening… 0:${String(s).padStart(2, "0")} — tap again when done.`, "recording"); };
      time(); tick = setInterval(time, 1000);
    }

    async function pcm16k(blob){
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      try {
        let dec;
        try { dec = await ctx.decodeAudioData(await blob.arrayBuffer()); }
        catch (e){ if (blob.size < 1024) return new Float32Array(0); throw e; }
        const frames = Math.min(Math.ceil(dec.duration * RATE), RATE * MAX_MS / 1000);
        if (!frames) return new Float32Array(0);
        const off = new OfflineAudioContext(1, frames, RATE);
        const src = off.createBufferSource();
        src.buffer = dec; src.connect(off.destination); src.start();
        return (await off.startRendering()).getChannelData(0);
      } finally { ctx.close().catch(() => {}); }
    }
    function wav(pcm){
      const v = new DataView(new ArrayBuffer(44 + pcm.length * 2));
      const tag = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
      tag(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); tag(8, "WAVE");
      tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      tag(36, "data"); v.setUint32(40, pcm.length * 2, true);
      for (let i = 0; i < pcm.length; i++){ const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
      return new Blob([v.buffer], { type: "audio/wav" });
    }
    async function transcribe(blob){
      const mine = working = new AbortController();
      mic.disabled = true;
      say("Transcribing…", "working");
      const timer = setTimeout(() => mine.abort(), 60000);
      let said = null, msg = "Couldn't transcribe that. Try again, or type it.";
      try {
        const pcm = await pcm16k(blob);
        let peak = 0;
        for (let i = 0; i < pcm.length; i++){ const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
        if (!pcm.length || peak < 0.003) msg = "Nothing was heard. Check the microphone and try again.";
        else if (pcm.length < RATE * 0.3) msg = "That was too short to make out. Try again.";
        else {
          const r = await fetch(STT_URL, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav(pcm), signal: mine.signal, credentials: "same-origin" });
          const b = (r.headers.get("content-type") || "").includes("application/json") ? await r.json() : null;
          if (r.ok && b && typeof b.text === "string") said = b.text.trim();
          else if (r.status === 429 || (b && b.error === "stt_busy")) msg = "Voice input is busy. Try again in a moment.";
          else if (b && b.error === "stt_unavailable"){ whisper = false; show(); }
          if (said === "") msg = "Couldn't make that out. Try again, or type it.";
        }
      } catch { /* msg stays */ }
      finally { clearTimeout(timer); }
      if (working !== mine) return;                 // cancelled meanwhile
      working = null; mic.disabled = false;
      if (said){ text.dataset.before = text.value.trim(); put(said); done(said); }
      else say(msg, "error");
    }

    function stop(){
      if (hearing){ const r = hearing; hearing = null; r.onresult = r.onend = null; try { r.abort(); } catch {} }
      if (rec){ const r = rec; rec = null; r.cancelled = true; clearTimeout(r.timer); clearInterval(tick);
                if (r.mr && r.mr.state !== "inactive") r.mr.stop(); else if (r.stream) r.stream.getTracks().forEach(t => t.stop()); }
      if (working){ working.abort(); working = null; mic.disabled = false; }
      state(false);
    }
    async function toggle(){
      if (rec){ if (rec.mr && rec.mr.state !== "inactive") rec.mr.stop(); return; }
      if (working) return;
      if (hearing){ hearing.stop(); return; }
      if (!window.isSecureContext){ say("Voice input needs https or localhost. You can type instead.", "error"); return; }
      if (!whisper && CAN_RECORD){ mic.disabled = true; await check(); mic.disabled = false; }
      if (whisper && CAN_RECORD) startRecording();
      else if (Speech) startHearing();
      else say("Voice input isn't available in this browser. You can type instead.", "error");
    }

    mic.addEventListener("pointerdown", e => {
      if (e.button !== 0 || mic.disabled) return;
      e.preventDefault();
      try { mic.setPointerCapture(e.pointerId); } catch {}
      press = { at: performance.now(), started: !rec && !hearing && !working };
      toggle();
    });
    const release = () => {
      const p = press; press = null;
      if (!p || !p.started || performance.now() - p.at < HOLD_MS) return;
      if (rec && rec.mr && rec.mr.state !== "inactive") rec.mr.stop();
      else if (hearing) hearing.stop();
    };
    mic.addEventListener("pointerup", release);
    mic.addEventListener("pointercancel", release);
    mic.addEventListener("contextmenu", e => e.preventDefault());
    mic.addEventListener("click", e => { if (e.detail === 0) toggle(); });   // keyboard
    view.addEventListener("keydown", e => {
      if (e.key === "Escape" && (rec || hearing || working)){ e.preventDefault(); stop(); say("Recording cancelled."); }
    });
    show();
    check();
    return { stop, say };
  })();

  showHotel();
  fit();
})();
