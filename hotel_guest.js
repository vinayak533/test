/* ============================================================================
   hotel_guest.js — the signed-in guest's area.

   hotel_admin.js signs everyone in; an account without the admin role lands
   here. Everything shown is read from Supabase with the guest's own token:

     room_board(hotel, in, out)   every room's type, rate and status for the
                                  chosen nights (available / booked / held /
                                  inactive). No other guest's details.
     my_bookings()                this account's bookings
     cancel_my_booking(ref)       cancel one, before its check-in day

   Live: a Realtime subscription on inventory_pulse (touched by a trigger
   whenever a reservation or room changes) re-reads both, so a booking made
   in the ChatBot — here or anywhere — shows up without a refresh. The page
   also re-reads at once on "mm:booking-changed" from the ChatBot, and every
   minute as a fallback if Realtime is not connected.
   ============================================================================ */

(function(){
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const TZ = "Asia/Kolkata";
  const TYPE_ORDER = ["Luxury", "Normal"];
  const STATUS = {
    available: { label: "Available", cls: "available" },
    booked:    { label: "Booked",    cls: "booked" },
    held:      { label: "Being booked", cls: "held" },
    inactive:  { label: "Not offered", cls: "inactive" }
  };
  const BOOKING_LABEL = { confirmed: "Confirmed", checked_in: "Checked in", checked_out: "Completed",
                          cancelled: "Cancelled", no_show: "No-show", mixed: "Mixed" };

  const G = { client: null, user: null, hotelId: "misty_mountain", channel: null, poll: 0, timer: 0,
              from: null, to: null, board: [], bookings: [], loading: false, again: false, bound: false };

  /* ---- dates & money ---------------------------------------------------- */
  const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const nightsBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  const fmtDay = d => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const fmtLong = d => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const inr = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(n) || 0);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  function toast(msg, kind){
    const box = $("#toasts");
    if (!box) return;
    const t = document.createElement("div");
    t.className = "mm-toast" + (kind ? " mm-toast--" + kind : "");
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 5200);
  }

  function setLive(state){
    const el = $("#gLive");
    el.classList.toggle("mm-live--on", state === "on");
    el.classList.toggle("mm-live--off", state === "off");
    $(".mm-live__text", el).textContent = state === "on" ? "Live" : state === "off" ? "Refreshing every minute" : "Connecting…";
  }

  /* ---- enter / leave ---------------------------------------------------- */

  function enter({ client, user, hotelId }){
    G.client = client; G.user = user; G.hotelId = hotelId || G.hotelId;
    bind();
    const meta = user.user_metadata || {};
    const name = (meta.full_name || "").trim();
    const first = name.split(/\s+/)[0] || "";
    $("#gHello").innerHTML = first ? `Welcome, <em>${esc(first)}</em>` : "Welcome <em>back</em>";
    $("#gName").textContent = name || user.email || "Guest";
    $("#gEmail").textContent = name ? (user.email || "") : "Guest account";
    $("#gAvatar").textContent = (name || user.email || "·")[0];
    document.title = "Your stay — Misty Mountain";
    if (!G.from){ setDates(todayISO(), addDays(todayISO(), 1)); }
    $("#mmGuest").hidden = false;
    load();
    subscribe();
    clearInterval(G.poll);
    G.poll = setInterval(load, 60000);
  }

  function leave(){
    clearInterval(G.poll);
    clearTimeout(G.timer);
    if (G.channel && G.client){ G.client.removeChannel(G.channel); }
    G.channel = null; G.user = null; G.board = []; G.bookings = []; G.from = G.to = null;
    ["#gBoard", "#gSummary", "#gBookings", "#gError"].forEach(s => { const n = $(s); if (n) n.innerHTML = ""; });
    $("#mmGuest").hidden = true;
  }

  function setDates(a, b){
    G.from = a; G.to = b;
    const f = $("#gDates").elements;
    f.in.value = a; f.out.value = b;
    f.in.min = todayISO();
    f.out.min = addDays(a, 1);
  }

  /* ---- data ------------------------------------------------------------- */

  async function load(){
    if (!G.client || !G.user) return;
    if (G.loading){ G.again = true; return; }
    G.loading = true;
    try {
      const [b, m] = await Promise.all([
        G.client.rpc("room_board", { p_hotel_id: G.hotelId, p_check_in: G.from, p_check_out: G.to }),
        G.client.rpc("my_bookings")
      ]);
      const err = b.error || m.error;
      if (err){
        if (/jwt|expired|401/i.test((err.message || "") + (err.code || ""))){
          toast("Your session expired — please sign in again.", "error");
          await G.client.auth.signOut();
          return;
        }
        throw new Error(err.message || "query failed");
      }
      G.board = (b.data || []).map(r => ({ ...r, price_per_night: Number(r.price_per_night) }));
      G.bookings = Array.isArray(m.data) ? m.data : [];
      $("#gError").textContent = "";
      render();
    } catch (e){
      $("#gError").textContent = "Couldn't load live availability: " + e.message + ". What's shown may be out of date.";
    } finally {
      G.loading = false;
      if (G.again){ G.again = false; load(); }
    }
  }

  function soon(){
    clearTimeout(G.timer);
    G.timer = setTimeout(load, 300);
  }

  function subscribe(){
    if (G.channel) G.client.removeChannel(G.channel);
    setLive("connecting");
    G.channel = G.client.channel("mm-guest-" + G.user.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_pulse", filter: "hotel_id=eq." + G.hotelId }, soon)
      .subscribe(status => setLive(status === "SUBSCRIBED" ? "on" : (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") ? "off" : "connecting"));
  }

  /* ---- render ----------------------------------------------------------- */

  function render(){
    renderBoard();
    renderBookings();
  }

  function renderBoard(){
    const n = nightsBetween(G.from, G.to);
    const offered = G.board.filter(r => r.status !== "inactive");
    const free = offered.filter(r => r.status === "available");
    const byType = t => ({ free: free.filter(r => r.room_type === t).length, all: offered.filter(r => r.room_type === t).length });
    $("#gRoomsSub").textContent = `${fmtDay(G.from)} → ${fmtDay(G.to)} · ${plural(n, "night")} · updated ${new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;

    $("#gSummary").innerHTML = `
      <div class="mm-gstat mm-gstat--all"><b>${free.length}</b><span>of ${offered.length} rooms available</span></div>
      ${TYPE_ORDER.filter(t => byType(t).all).map(t => {
        const c = byType(t);
        const min = Math.min(...offered.filter(r => r.room_type === t).map(r => r.price_per_night));
        return `<div class="mm-gstat mm-gstat--${t}"><b>${c.free}<small>/${c.all}</small></b><span>${t} free · from ${inr(min)}/night</span></div>`;
      }).join("")}`;

    if (!G.board.length){
      $("#gBoard").innerHTML = '<p class="mm-empty">No rooms found.</p>';
      return;
    }
    $("#gBoard").innerHTML = TYPE_ORDER.map(t => {
      const rooms = G.board.filter(r => r.room_type === t);
      if (!rooms.length) return "";
      return `<div class="mm-gtype mm-gtype--${t}">
        <h3 class="mm-gtype__title">${t === "Luxury" ? '<span class="mm-lux-mark" aria-hidden="true">★</span>' : ""}${t} rooms
          <small>${t === "Luxury" ? "Our finest rooms, with the best of the valley views" : "Comfortable, well-appointed estate rooms"}</small></h3>
        <div class="mm-gboard">${rooms.map(r => tile(r, n)).join("")}</div></div>`;
    }).join("");
  }

  function tile(r, n){
    const st = STATUS[r.status] || STATUS.inactive;
    const total = r.price_per_night * n;
    const action = r.status === "available"
      ? `<button type="button" class="mm-room__book" data-book-type="${esc(r.room_type)}" data-room-no="${r.room_number}">Book this room</button>`
      : r.mine ? '<span class="mm-room__mine">Your booking</span>' : "";
    return `<article class="mm-room mm-room--${esc(r.room_type)} mm-room--${st.cls}${r.mine ? " mm-room--mine" : ""}"
        aria-label="Room ${r.room_number}, ${esc(r.room_type)}, ${esc(st.label)}${r.mine ? ", your booking" : ""}, ${inr(r.price_per_night)} per night">
      <header class="mm-room__head">
        <span class="mm-room__no">${r.room_number}</span>
        <span class="mm-room__type">${r.room_type === "Luxury" ? "★ " : ""}${esc(r.room_type)}</span>
      </header>
      <span class="mm-room__status"><i aria-hidden="true"></i>${esc(st.label)}</span>
      <span class="mm-room__price"><b>${inr(r.price_per_night)}</b> / night</span>
      <span class="mm-room__meta">Sleeps ${r.max_guests}${n > 1 && r.status === "available" ? ` · ${inr(total)} for ${plural(n, "night")}` : ""}</span>
      ${action}
    </article>`;
  }

  function renderBookings(){
    const today = todayISO();
    const list = G.bookings;
    if (!list.length){
      $("#gBookings").innerHTML = '<p class="mm-empty">No bookings yet. Tap <b>Book with the ChatBot</b> — your booking will appear here the moment it is confirmed.</p>';
      return;
    }
    $("#gBookings").innerHTML = '<ul class="mm-gbookings">' + list.map(b => {
      const rooms = (b.rooms || []).map(r => `<span class="mm-chiproom mm-chiproom--${esc(r.room_type)}">${r.room_type === "Luxury" ? "★ " : ""}Room ${Number(r.room_number)} · ${esc(r.room_type)}</span>`).join("");
      const canCancel = b.status === "confirmed" && b.check_in > today;
      const past = b.check_out <= today;
      return `<li class="mm-gbooking${b.status === "cancelled" ? " is-cancelled" : ""}${past ? " is-past" : ""}" data-ref="${esc(b.booking_ref)}">
        <div class="mm-gbooking__main">
          <p class="mm-gbooking__ref">${esc(b.booking_ref)} <span class="mm-badge mm-badge--${esc(b.status)}">${esc(BOOKING_LABEL[b.status] || b.status)}</span></p>
          <p class="mm-gbooking__dates">${fmtLong(b.check_in)} → ${fmtLong(b.check_out)} · ${plural(Number(b.nights), "night")} · ${plural(Number(b.num_guests), "guest")}</p>
          <div class="mm-gbooking__rooms">${rooms}</div>
        </div>
        <div class="mm-gbooking__side">
          <b>${inr(b.total_price)}</b>
          ${canCancel ? `<button type="button" class="mm-btn mm-btn--outline mm-btn--sm" data-cancel-mine="${esc(b.booking_ref)}">Cancel booking</button>` : ""}
          ${b.status === "confirmed" && !canCancel && !past ? '<small>To change a same-day booking, call the front desk.</small>' : ""}
        </div>
        <div class="mm-gbooking__confirm" hidden></div>
      </li>`;
    }).join("") + "</ul>";
  }

  /* ---- actions ---------------------------------------------------------- */

  function askCancel(ref){
    const li = $(`.mm-gbooking[data-ref="${CSS.escape(ref)}"]`);
    const box = $(".mm-gbooking__confirm", li);
    box.hidden = false;
    box.innerHTML = `<div class="mm-confirm"><p>Cancel booking ${esc(ref)}? The room${li.querySelectorAll(".mm-chiproom").length > 1 ? "s" : ""} will be released to other guests straight away. This can't be undone.</p>
      <div class="mm-actions"><button type="button" class="mm-btn mm-btn--danger mm-btn--sm" data-cancel-yes="${esc(ref)}">Yes, cancel it</button>
      <button type="button" class="mm-btn mm-btn--ghost mm-btn--sm" data-cancel-no>Keep booking</button></div></div>`;
    $("[data-cancel-yes]", box).focus();
  }

  async function cancel(ref, btn){
    btn.disabled = true; btn.textContent = "Cancelling…";
    const { data, error } = await G.client.rpc("cancel_my_booking", { p_booking_ref: ref });
    if (error || !data || !data.ok){
      btn.disabled = false; btn.textContent = "Yes, cancel it";
      const why = error ? error.message : ({ too_late: "it's on or after the check-in day — please call the front desk",
                                             invalid_transition: "it isn't a confirmed booking any more",
                                             not_found: "it wasn't found on this account" }[data && data.reason] || "please try again");
      toast(`Couldn't cancel ${ref}: ${why}.`, "error");
      return;
    }
    toast(`${ref} cancelled. The room is available again.`, "ok");
    window.dispatchEvent(new CustomEvent("mm:booking-changed", { detail: { ref } }));
    load();
  }

  function bind(){
    if (G.bound) return;
    G.bound = true;
    $("#gDates").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target.elements;
      if (!f.in.value || !f.out.value || f.out.value <= f.in.value){
        $("#gError").textContent = "Choose a check-out date after the check-in date.";
        return;
      }
      if (nightsBetween(f.in.value, f.out.value) > 30){
        $("#gError").textContent = "Stays can be up to 30 nights.";
        return;
      }
      setDates(f.in.value, f.out.value);
      load();
    });
    $("#gDates").elements.in.addEventListener("change", e => {
      const f = $("#gDates").elements;
      f.out.min = e.target.value ? addDays(e.target.value, 1) : "";
      if (e.target.value && (!f.out.value || f.out.value <= e.target.value)) f.out.value = addDays(e.target.value, 1);
    });
    $("#mmGuest").addEventListener("click", e => {
      const book = e.target.closest("[data-book-type]");
      if (book && window.MMChat){
        window.MMChat.open(`I would like to book a ${book.dataset.bookType} room from ${fmtLong(G.from)} to ${fmtLong(G.to)}`);
        return;
      }
      const c = e.target.closest("[data-cancel-mine]");
      if (c){ askCancel(c.dataset.cancelMine); return; }
      const yes = e.target.closest("[data-cancel-yes]");
      if (yes){ cancel(yes.dataset.cancelYes, yes); return; }
      if (e.target.closest("[data-cancel-no]")){
        const box = e.target.closest(".mm-gbooking__confirm");
        box.hidden = true; box.innerHTML = "";
      }
    });
    window.addEventListener("mm:booking-changed", () => { if (G.user) soon(); });
  }

  window.MMGuest = { enter, leave, reload: () => load() };
})();
