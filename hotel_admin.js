/* ============================================================================
   hotel_admin.js — Misty Mountain sign-in, sign-up and the hotel
   management dashboard.

   Everyone signs in here with Supabase Auth (email + password). Guests can
   create an account (full name, email, password); with email confirmation
   on in the Supabase project they verify it first. Who lands where:

     app_metadata.hotel_role = "admin"   the dashboard below
     anyone else                         the guest area (hotel_guest.js)

   Both read the database with the signed-in user's own token, so Row Level
   Security and the database functions decide what comes back
   (supabase/migrations/004_security.sql, 005_guest_accounts.sql); the role
   check here picks a screen, it does not protect anything. app_metadata can
   only be set with the service-role key, so nobody signs up as staff.

   window.MMAuth gives the ChatBot the current access token (sent to
   /api/chat so a booking is tied to the account) and lets it open the
   sign-in form when a signed-out guest tries to book.

   What it does
     Dashboard     tonight's rooms, KPIs, arrivals/departures, 14-night
                   occupancy, latest bookings — live via Supabase Realtime
     Rooms         availability check, rate per type, per-room type / rate /
                   capacity / active edits
     Reservations  search, filter, detail, check-in / check-out / no-show /
                   cancel (admin_update_booking_status)
     Guests        profiles with booking history (guest_summaries view)
     Reports       revenue, room-nights, occupancy, ADR, RevPAR from
                   admin_report, by night and by room type; CSV export

   Every view is about one hotel at a time, chosen with the Property picker
   (all active hotels in the hotels table). Switching re-reads everything
   for that hotel and re-subscribes Realtime to it; a load still in flight
   for the previous hotel is discarded, never shown under the new one. The
   choice is kept for the tab in sessionStorage.

   The session is kept in sessionStorage: it survives a page refresh and
   ends with the tab — the right default for a front-desk machine or a
   shared phone. Guest data and the ChatBot conversation are wiped from the
   page on sign-out.
   ============================================================================ */

(function(){
  "use strict";

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const VIEWS = ["dashboard", "rooms", "reservations", "guests", "reports"];
  const TITLES = { dashboard: "Dashboard", rooms: "Rooms", reservations: "Reservations", guests: "Guests", reports: "Reports" };
  const LIVE = new Set(["confirmed", "checked_in"]);                   // holds a room for the night
  const SOLD = new Set(["confirmed", "checked_in", "checked_out"]);    // counts as revenue
  const STATUS_LABEL = { held: "Held", expired: "Expired hold", confirmed: "Confirmed", checked_in: "Checked in",
                         checked_out: "Checked out", cancelled: "Cancelled", no_show: "No-show", mixed: "Mixed" };
  const PAGE = 20;

  /* Round icons for the KPI tiles, drawn at 20px in the tile's purple disc. */
  const svg = d => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    bed:      svg('<path d="M3 18.5v-12M3 14h18v4.5M21 14v-2.5a3 3 0 0 0-3-3h-7V14"/><circle cx="7" cy="10.8" r="1.8"/>'),
    door:     svg('<path d="M5 20.5h14M7 20.5V4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5v16"/><circle cx="14" cy="12" r=".9" fill="currentColor"/>'),
    guests:   svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'),
    gauge:    svg('<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 3.5-5"/><path d="M8.5 21h7"/>'),
    luggage:  svg('<rect x="6" y="6.5" width="12" height="13" rx="2"/><path d="M9.5 6.5V4.5A1.5 1.5 0 0 1 11 3h2a1.5 1.5 0 0 1 1.5 1.5v2M10 10.5v5M14 10.5v5M9 19.5v1.5M15 19.5v1.5"/>'),
    out:      svg('<path d="M14 4h3.5A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M9.5 16.5 5 12l4.5-4.5M5 12h10"/>'),
    rupee:    svg('<path d="M7 4.5h10M7 9h10M8 4.5h2.5a4.5 4.5 0 0 1 0 9H8l7.5 6.5"/>'),
    moon:     svg('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
    tag:      svg('<path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1.5 1.5 0 0 1 0 2.1l-6 6a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8.3" cy="8.3" r="1.4"/>'),
    chart:    svg('<path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>'),
    calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M16 3v4M8 3v4M3.5 10h17"/>')
  };
  const kpiTile = (label, val, foot, icon, extra = "") => `<div class="mm-kpi"><span class="mm-kpi__label">${esc(label)}</span>`
    + `<span class="mm-kpi__ico">${ICON[icon] || ""}</span><span class="mm-kpi__val">${esc(val)}</span>${extra}<span class="mm-kpi__foot">${foot}</span></div>`;

  /* A guest's initials in a lavender disc, beside their name in the lists. */
  const initials = name => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "·";
  const who = (name, inner) => `<span class="mm-who"><span class="mm-initials" aria-hidden="true">${esc(initials(name))}</span><span class="mm-who__txt">${inner}</span></span>`;
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

  const S = {
    client: null, user: null, mode: null, resumeChat: false, hotelId: "misty_mountain", hotel: null, hotels: [], boardDate: "", again: false,
    rooms: [], roomById: new Map(), res: [], guests: [],
    view: "dashboard", moves: "arrivals", resPage: 0, report: null,
    channel: null, poll: 0, reloadTimer: 0, toasted: new Set(), loading: false, opener: null
  };

  /* ---- formatting ------------------------------------------------------ */

  const tz = () => (S.hotel && S.hotel.timezone) || "Asia/Kolkata";
  const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const diffDays = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  const dateObj = d => new Date(d + "T00:00:00Z");
  const fmtDate = d => d ? dateObj(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
  const fmtShort = d => d ? dateObj(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "—";
  const fmtTime = t => {
    if (!t) return "Not given";
    const [h, m] = t.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  };
  const fmtStamp = ts => ts ? new Date(ts).toLocaleString("en-IN", { timeZone: tz(), day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
  const inr = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: Number(n) % 1 ? 2 : 0 }).format(Number(n) || 0);
  const inrShort = n => n >= 100000 ? "₹" + (n / 100000).toFixed(n >= 1000000 ? 0 : 1) + "L" : n >= 1000 ? "₹" + Math.round(n / 1000) + "k" : "₹" + Math.round(n);
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const digits = s => String(s || "").replace(/\D/g, "");

  /* A hold past its expiry is shown as what it is: not holding anything. */
  const eff = r => (r.status === "held" && new Date(r.hold_expires_at) <= new Date()) ? "expired" : r.status;

  /* ---- toasts, banners ------------------------------------------------- */

  function toast(msg, kind = ""){
    const t = document.createElement("div");
    t.className = "mm-toast" + (kind ? " mm-toast--" + kind : "");
    t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => t.remove(), 5200);
  }
  function banner(msg, error = false){
    const b = $("#loadBanner");
    b.hidden = !msg;
    b.textContent = msg || "";
    b.classList.toggle("mm-banner--error", !!error);
  }
  function setLive(state){
    const el = $("#liveStatus");
    el.classList.toggle("mm-live--on", state === "on");
    el.classList.toggle("mm-live--off", state === "off");
    $(".mm-live__text", el).textContent = state === "on" ? "Live" : state === "off" ? "Refreshing every minute" : "Connecting…";
  }

  /* ==================================================================== AUTH */

  const isAdmin = user => !!(user && user.app_metadata && user.app_metadata.hotel_role === "admin");
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const NAME_RE = /^[\p{L}][\p{L}\p{M}' .-]{1,119}$/u;
  const PW_RULES = {
    len:  p => p.length >= 8,
    case: p => /[a-z]/.test(p) && /[A-Z]/.test(p),
    num:  p => /\d/.test(p)
  };
  const redirectTo = () => location.origin + location.pathname;

  function gateError(msg){ $("#signinError").textContent = msg || ""; }
  function signupError(msg){ $("#signupError").textContent = msg || ""; }
  function notice(msg, kind = "ok"){
    const n = $("#authNotice");
    n.hidden = !msg;
    n.textContent = msg || "";
    n.className = "mm-auth__notice" + (kind === "error" ? " mm-auth__notice--error" : "");
  }

  function authTab(mode){
    const signup = mode === "signup";
    $("#mmSignin").hidden = signup;
    $("#mmSignup").hidden = !signup;
    $$(".mm-auth__tab").forEach(t => {
      const on = t.dataset.authTab === (signup ? "signup" : "signin");
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    });
  }

  /* Supabase puts the result of an email-verification link in the URL
     fragment: tokens on success (read by the client below), an error
     otherwise. Read the error before anything else, then tidy the URL. */
  function readAuthRedirect(){
    const h = new URLSearchParams(location.hash.slice(1));
    const q = new URLSearchParams(location.search);
    const err = h.get("error_description") || q.get("error_description");
    if (err){
      const expired = /expired|invalid/i.test(err) || h.get("error_code") === "otp_expired";
      notice(expired ? "That verification link has expired or was already used. Sign in — or, if your account isn't verified yet, we can send a new link." : "Couldn't verify your email: " + err, "error");
      if (expired) $("#resendBtn").hidden = false;
    }
    return { verified: h.get("type") === "signup" && !!h.get("access_token") };
  }
  function tidyUrl(){
    if (/access_token=|error_description=|error_code=/.test(location.hash + location.search)){
      history.replaceState(null, "", location.pathname);
    }
  }

  async function boot(){
    bindStatic();
    const redirect = readAuthRedirect();
    let cfg;
    try {
      const r = await fetch("/api/config", { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("status " + r.status);
      cfg = await r.json();
    } catch (e){
      gateError("Sign-in isn't available on this server right now. The ChatBot still answers questions.");
      $("#signinBtn").disabled = true; $("#signupBtn").disabled = true;
      return;
    }
    if (!window.supabase || !window.supabase.createClient){
      gateError("The sign-in library didn't load. Check the connection and reload the page.");
      $("#signinBtn").disabled = true; $("#signupBtn").disabled = true;
      return;
    }
    S.hotelId = cfg.hotelId || S.hotelId;
    let storage = null;
    try { storage = window.sessionStorage; storage.getItem("probe"); } catch { storage = null; }
    S.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: !!storage, storage: storage || undefined, storageKey: "mm-admin-auth",
              autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" }
    });
    S.client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") leave();
      else if (session && S.user && event === "TOKEN_REFRESHED") S.user = session.user;
      else if (session && !S.user && event === "SIGNED_IN") setTimeout(() => { if (!S.user) enterAs(session); }, 0);
    });
    const { data } = await S.client.auth.getSession();
    tidyUrl();
    if (data && data.session){
      if (redirect.verified) toast("Your email is verified — welcome to Misty Mountain.", "ok");
      enterAs(data.session);
    }
  }

  function enterAs(session){
    if (!session || !session.user || S.user) return;
    notice("");
    if (isAdmin(session.user)) enter(session);
    else enterGuest(session);
    if (S.resumeChat && window.MMChat){
      S.resumeChat = false;
      setTimeout(() => window.MMChat.resume(), 250);
    }
  }

  async function signIn(e){
    e.preventDefault();
    if (!S.client) return;
    const email = $("#signinEmail").value.trim().toLowerCase();
    const password = $("#signinPassword").value;
    $("#resendBtn").hidden = true;
    if (!email || !password){ gateError("Enter your email address and password."); return; }
    if (!EMAIL_RE.test(email)){ gateError("That email address doesn't look right."); return; }
    const btn = $("#signinBtn");
    btn.disabled = true; btn.textContent = "Signing in…"; gateError(""); notice("");
    try {
      const { data, error } = await S.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      $("#signinPassword").value = "";
      enterAs(data.session);
    } catch (err){
      const m = (err && err.message) || "";
      if (err.code === "email_not_confirmed" || /not confirmed/i.test(m)){
        gateError("Please verify your email first — open the link we sent to " + email + ".");
        $("#resendBtn").hidden = false;
      } else if (err.status === 429 || /rate limit|too many/i.test(m)){
        gateError("Too many attempts. Please wait a minute and try again.");
      } else if (/invalid|credentials/i.test(m)){
        gateError("That email and password don't match an account.");
      } else {
        gateError("Sign-in failed: " + (m || "please try again."));
      }
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  }

  /* ---- sign-up ---------------------------------------------------------- */

  function fieldError(id, msg){
    const input = $("#" + id);
    const out = $("#" + id + "Err");
    if (out) out.textContent = msg || "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    return !msg;
  }

  function checkRules(){
    const p = $("#signupPassword").value;
    let ok = true;
    $$("#pwRules [data-rule]").forEach(li => {
      const pass = PW_RULES[li.dataset.rule](p);
      li.classList.toggle("is-ok", pass);
      ok = ok && pass;
    });
    return ok;
  }

  function validateSignup(){
    const name = $("#signupName").value.trim().replace(/\s+/g, " ");
    const email = $("#signupEmail").value.trim().toLowerCase();
    const pw = $("#signupPassword").value;
    const confirm = $("#signupConfirm").value;
    const results = [
      fieldError("signupName", !name ? "Enter your full name." : !NAME_RE.test(name) ? "Use letters only (spaces, hyphens and apostrophes are fine)." : ""),
      fieldError("signupEmail", !email ? "Enter your email address." : !EMAIL_RE.test(email) || email.length > 254 ? "That email address doesn't look right." : ""),
      (() => { const ok = checkRules(); $("#signupPassword").setAttribute("aria-invalid", ok ? "false" : "true"); return ok; })(),
      fieldError("signupConfirm", !confirm ? "Enter the password again." : confirm !== pw ? "The passwords don't match." : "")
    ];
    return { ok: results.every(Boolean), name, email, pw };
  }

  async function signUp(e){
    e.preventDefault();
    if (!S.client) return;
    signupError(""); notice("");
    const v = validateSignup();
    if (!v.ok){
      const bad = $$("#mmSignup input").find(i => i.getAttribute("aria-invalid") === "true");
      if (bad) bad.focus();
      if (!checkRules()) signupError("Choose a password that meets all three requirements.");
      return;
    }
    const btn = $("#signupBtn");
    btn.disabled = true; btn.textContent = "Creating your account…";
    try {
      const { data, error } = await S.client.auth.signUp({
        email: v.email, password: v.pw,
        options: { data: { full_name: v.name }, emailRedirectTo: redirectTo() }
      });
      if (error) throw error;
      // With email confirmation on, Supabase answers a sign-up for an
      // address that already has an account with a user that has no
      // identities (so the reply can't be used to probe for accounts).
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0){
        return alreadyRegistered(v.email);
      }
      $("#mmSignup").reset(); checkRules();
      if (data.session){
        toast("Account created — welcome, " + v.name.split(" ")[0] + ".", "ok");
        enterAs(data.session);
      } else {
        authTab("signin");
        $("#signinEmail").value = v.email;
        notice("Almost there — we've sent a verification link to " + v.email + ". Open it to activate your account, then sign in here.");
      }
    } catch (err){
      const m = (err && err.message) || "";
      if (err.code === "user_already_exists" || /already (registered|exists)/i.test(m)) return alreadyRegistered(v.email);
      if (err.code === "weak_password" || /password/i.test(m)) signupError("That password isn't accepted: " + m);
      else if (err.status === 429 || /rate limit|too many/i.test(m)) signupError("Too many sign-ups from here just now. Please wait a few minutes and try again.");
      else if (/email/i.test(m) && /invalid/i.test(m)) fieldError("signupEmail", "That email address isn't accepted.");
      else signupError("Couldn't create the account: " + (m || "please try again."));
    } finally {
      btn.disabled = false; btn.textContent = "Create account";
    }
  }

  function alreadyRegistered(email){
    authTab("signin");
    $("#signinEmail").value = email;
    $("#signupPassword").value = ""; $("#signupConfirm").value = ""; checkRules();
    notice("An account with " + email + " already exists. Sign in below — if you haven't verified it yet, we can send the link again.", "error");
    $("#resendBtn").hidden = false;
    $("#signinPassword").focus();
  }

  async function resend(){
    const email = $("#signinEmail").value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)){ gateError("Enter your email address above first."); $("#signinEmail").focus(); return; }
    const btn = $("#resendBtn");
    btn.disabled = true;
    const { error } = await S.client.auth.resend({ type: "signup", email, options: { emailRedirectTo: redirectTo() } });
    btn.disabled = false;
    if (error){ gateError(/rate|seconds|too many/i.test(error.message) ? "Please wait a minute before asking for another email." : "Couldn't send the email: " + error.message); return; }
    gateError("");
    notice("If " + email + " has an account that isn't verified yet, a new link is on its way.");
  }

  /* ---- entering --------------------------------------------------------- */

  function enter(session){
    S.user = session.user;
    S.mode = "admin";
    $("#mmGate").hidden = true;
    $("#mmApp").hidden = false;
    const email = S.user.email || "";
    $("#userEmail").textContent = email;
    $("#userAvatar").textContent = (email[0] || "·");
    route();
    loadHotels().then(() => { loadAll(); subscribe(); });
    clearInterval(S.poll);
    S.poll = setInterval(() => loadAll(true), 60000);
  }

  /* ---- which hotel ------------------------------------------------------ */

  const PICK_KEY = "mm-admin-hotel";
  function rememberHotel(id){ try { sessionStorage.setItem(PICK_KEY, id); } catch {} }
  function rememberedHotel(){ try { return sessionStorage.getItem(PICK_KEY); } catch { return null; } }

  async function loadHotels(){
    const { data, error } = await S.client.from("hotels").select("id, name").eq("is_active", true).order("name");
    if (error || !data || !data.length) return;           // loadAll reports a real failure
    S.hotels = data;
    const saved = rememberedHotel();
    if (saved && data.some(h => h.id === saved)) S.hotelId = saved;
    else if (!data.some(h => h.id === S.hotelId)) S.hotelId = data[0].id;
    $("#hotelSwitch").innerHTML = data.map(h => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join("");
    $("#hotelSwitch").value = S.hotelId;
    $("#hotelPick").hidden = data.length < 2;
  }

  function switchHotel(id){
    if (!id || id === S.hotelId || !S.hotels.some(h => h.id === id)) return;
    S.hotelId = id;
    rememberHotel(id);
    closeDrawer();
    // Nothing of the previous hotel may stay on screen under the new name.
    S.hotel = null; S.rooms = []; S.roomById = new Map(); S.res = []; S.guests = []; S.report = null;
    ["#kpis", "#roomBoard", "#moves", "#occChart", "#recentTable", "#roomsTable", "#typeRates", "#resTable",
     "#guestTable", "#reportKpis", "#revChart", "#repOccChart", "#typeSplit", "#availResult", "#resCount", "#guestCount", "#resPager"]
      .forEach(s => { const n = $(s); if (n) n.innerHTML = ""; });
    const name = (S.hotels.find(h => h.id === id) || {}).name || "";
    $("#sideHotel").textContent = name;
    navOpen(false);
    loadAll();
    subscribe();
    if (S.view === "reports") loadReport();
  }

  function enterGuest(session){
    S.user = session.user;
    S.mode = "guest";
    $("#mmGate").hidden = true;
    if (window.MMGuest) window.MMGuest.enter({ client: S.client, user: S.user, hotelId: S.hotelId });
  }

  /* Drop everything: no guest data may stay in the page once signed out. */
  function leave(){
    const was = S.mode;
    clearInterval(S.poll);
    if (S.channel && S.client){ S.client.removeChannel(S.channel); S.channel = null; }
    S.user = null; S.mode = null; S.hotel = null; S.hotels = []; S.rooms = []; S.res = []; S.guests = []; S.report = null; S.roomById = new Map();
    ["#kpis", "#roomBoard", "#moves", "#occChart", "#recentTable", "#roomsTable", "#typeRates", "#resTable",
     "#guestTable", "#reportKpis", "#revChart", "#repOccChart", "#typeSplit", "#availResult", "#resCount", "#guestCount", "#resPager"]
      .forEach(s => { const n = $(s); if (n) n.innerHTML = ""; });
    closeDrawer();
    if (window.MMGuest) window.MMGuest.leave();
    if (was && window.MMChat) window.MMChat.reset();
    $("#mmApp").hidden = true;
    $("#mmGate").hidden = false;
    document.title = "Misty Mountain";
  }

  window.MMAuth = {
    /* The current access token, refreshed by the client when it is close to
       expiry; null when signed out. */
    async token(){
      if (!S.client || !S.user) return null;
      const { data } = await S.client.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    },
    signedIn: () => !!S.user,
    open(mode, { resumeChat = false } = {}){
      if (S.user){ if (resumeChat && window.MMChat) window.MMChat.resume(); return; }
      S.resumeChat = resumeChat;
      authTab(mode === "signup" ? "signup" : "signin");
      if (resumeChat) notice("Sign in or create an account to finish your booking — the ChatBot will pick up where you left off.");
      const panel = $("#authPanel");
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => $(mode === "signup" ? "#signupName" : "#signinEmail").focus({ preventScroll: true }), 350);
    }
  };

  /* ==================================================================== DATA */

  async function loadAll(quiet){
    if (!S.client || !S.user) return;
    if (S.loading){ S.again = true; return; }
    S.loading = true;
    const hid = S.hotelId;
    if (!quiet && !S.rooms.length) renderSkeletons();
    try {
      const [h, r, x, g] = await Promise.all([
        S.client.from("hotels").select("id, name, timezone, address, check_in_time, check_out_time, hold_minutes").eq("id", S.hotelId),
        S.client.from("rooms").select("id, room_number, room_type, name, price_per_night, max_guests, is_active, updated_at").eq("hotel_id", S.hotelId).order("room_number"),
        S.client.from("reservations").select("id, booking_ref, room_id, guest_id, guest_name, guest_email, guest_phone, check_in, check_out, arrival_time, departure_time, num_guests, room_type, price_per_night, nights, total_price, status, source, hold_expires_at, confirmed_at, cancelled_at, cancel_reason, created_at").eq("hotel_id", S.hotelId).order("created_at", { ascending: false }).limit(5000),
        S.client.from("guest_summaries").select("*").eq("hotel_id", S.hotelId).order("full_name")
      ]);
      if (hid !== S.hotelId) return;                      // switched while loading: the re-run below reads the new one
      const err = [h, r, x, g].find(q => q.error);
      if (err){
        const e = err.error;
        if (/jwt|expired|401/i.test((e.message || "") + (e.code || ""))){ toast("Your session expired — please sign in again.", "error"); await S.client.auth.signOut(); return; }
        throw new Error(e.message || "query failed");
      }
      if (!h.data.length){
        banner("This account can't see this hotel's data. Its admin rights may have been removed — sign out and back in, or ask the property administrator.", true);
        return;
      }
      S.hotel = h.data[0];
      S.rooms = r.data.map(x => ({ ...x, price_per_night: Number(x.price_per_night) }));
      S.roomById = new Map(S.rooms.map(x => [x.id, x]));
      S.res = x.data.map(z => ({ ...z, price_per_night: Number(z.price_per_night), total_price: Number(z.total_price) }));
      S.guests = g.data;
      banner("");
      renderAll();
      if (S.view === "reports" && !S.report) loadReport();
    } catch (e){
      banner("Couldn't load data from Supabase: " + e.message + ". The figures shown may be out of date.", true);
    } finally {
      S.loading = false;
      if (S.again || hid !== S.hotelId){ S.again = false; loadAll(true); }
    }
  }

  function scheduleReload(){
    clearTimeout(S.reloadTimer);
    S.reloadTimer = setTimeout(() => { loadAll(true); if (S.view === "reports") loadReport(); }, 500);
  }

  /* The ChatBot in this page just held, booked or released a room. */
  window.addEventListener("mm:booking-changed", () => { if (S.mode === "admin") scheduleReload(); });

  function subscribe(){
    if (S.channel) S.client.removeChannel(S.channel);
    setLive("connecting");
    S.channel = S.client.channel("mm-admin-" + S.hotelId)
      .on("postgres_changes", { event: "*", schema: "public", table: "reservations", filter: "hotel_id=eq." + S.hotelId }, payload => {
        const n = payload.new || {};
        if (n.status === "confirmed" && n.booking_ref && !S.toasted.has(n.booking_ref)
            && n.confirmed_at && Date.now() - Date.parse(n.confirmed_at) < 120000){
          S.toasted.add(n.booking_ref);
          toast(`New booking confirmed · ${n.booking_ref}`, "ok");
        }
        scheduleReload();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: "hotel_id=eq." + S.hotelId }, scheduleReload)
      .subscribe(status => setLive(status === "SUBSCRIBED" ? "on" : (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") ? "off" : "connecting"));
  }

  /* Rows → bookings (one booking may hold several rooms). */
  function bookings(rows = S.res){
    const map = new Map();
    for (const r of rows){
      let b = map.get(r.booking_ref);
      if (!b){
        b = { ref: r.booking_ref, rows: [], guest_id: r.guest_id, guest_name: r.guest_name, guest_email: r.guest_email, guest_phone: r.guest_phone,
              check_in: r.check_in, check_out: r.check_out, nights: r.nights, arrival_time: r.arrival_time, departure_time: r.departure_time,
              source: r.source, created_at: r.created_at, confirmed_at: r.confirmed_at, cancelled_at: r.cancelled_at, cancel_reason: r.cancel_reason,
              hold_expires_at: r.hold_expires_at, guests: 0, total: 0 };
        map.set(r.booking_ref, b);
      }
      b.rows.push(r);
      b.guests += r.num_guests;
      b.total += r.total_price;
      if (r.created_at < b.created_at) b.created_at = r.created_at;
    }
    for (const b of map.values()){
      const st = [...new Set(b.rows.map(eff))];
      b.status = st.length === 1 ? st[0] : "mixed";
      b.rooms = b.rows.map(r => (S.roomById.get(r.room_id) || {}).room_number).filter(Boolean).sort((a, c) => a - c);
      b.types = [...new Set(b.rows.map(r => r.room_type))];
    }
    return [...map.values()];
  }

  /* ================================================================ ROUTING */

  function route(){
    if (S.mode !== "admin") return;
    const v = (location.hash || "#dashboard").slice(1);
    S.view = VIEWS.includes(v) ? v : "dashboard";
    $$("[data-view-panel]").forEach(p => { p.hidden = p.dataset.viewPanel !== S.view; });
    $$(".mm-nav__item").forEach(a => {
      if (a.dataset.view === S.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    $("#topPage").textContent = TITLES[S.view];
    document.title = TITLES[S.view] + " — " + ((S.hotel && S.hotel.name) || "Misty Mountain");
    navOpen(false);
    if (S.view === "reports" && S.user && S.hotel) loadReport();
  }

  function navOpen(on){
    $("#mmApp").classList.toggle("is-nav-open", on);
    $("#mmScrim").hidden = !on;
    $("#menuBtn").setAttribute("aria-expanded", on ? "true" : "false");
  }

  /* ================================================================ RENDER */

  function renderSkeletons(){
    $("#kpis").innerHTML = Array.from({ length: 6 }, () =>
      '<div class="mm-kpi"><span class="mm-skel" style="width:60%"></span><span class="mm-skel" style="height:2rem;width:40%"></span><span class="mm-skel" style="width:80%"></span></div>').join("");
  }

  function renderAll(){
    if (!S.hotel) return;
    $("#sideHotel").textContent = S.hotel.name;
    $("#policyChip").textContent = `Check-in ${fmtTime(S.hotel.check_in_time)} · Check-out ${fmtTime(S.hotel.check_out_time)}`;
    const first = String((S.user && S.user.user_metadata && S.user.user_metadata.full_name) || "").trim().split(/\s+/)[0];
    $("#hDashboard").textContent = greeting() + (first ? ", " + first : "");
    $("#todayLabel").textContent = S.hotel.name + " · Business date " + fmtDate(todayISO());
    const active = S.rooms.filter(r => r.is_active).length;
    $("#navRooms").textContent = active + "/" + S.rooms.length;
    const upcoming = bookings().filter(b => (b.status === "confirmed" || b.status === "checked_in") && b.check_out >= todayISO()).length;
    $("#navReservations").textContent = upcoming || "";
    renderDashboard();
    renderRooms();
    renderReservations();
    renderGuests();
  }

  /* ---- dashboard ------------------------------------------------------- */

  /* What holds each room on the night of `day` (default tonight). */
  function tonight(day = todayISO()){
    const byRoom = new Map();
    for (const r of S.res){
      const s = eff(r);
      if (!(LIVE.has(s) || s === "held") || !(r.check_in <= day && day < r.check_out)) continue;
      const prev = byRoom.get(r.room_id);
      if (!prev || prev.status === "held") byRoom.set(r.room_id, { ...r, status: s });
    }
    return byRoom;
  }

  function roomState(room, tn, day){
    if (!room.is_active) return { cls: "inactive", label: "Inactive", who: "Not offered for booking" };
    const r = tn.get(room.id);
    const isToday = day === todayISO();
    if (!r){
      // Free that night, but already sold for a later one: shown as booked
      // (with the date), so a confirmed ChatBot booking is visible on the
      // board straight away whatever night it starts.
      const next = S.res.filter(x => x.room_id === room.id && LIVE.has(eff(x)) && x.check_in > day).sort((a, b) => a.check_in < b.check_in ? -1 : 1)[0];
      if (next) return { cls: "reserved", label: "Booked · " + fmtShort(next.check_in), who: (isToday ? "Free tonight" : "Free this night") + (next.guest_name ? " · " + next.guest_name : ""), ref: next.booking_ref };
      return { cls: "available", label: "Available", who: "No upcoming stays" };
    }
    if (r.status === "held") return { cls: "held", label: "Held", who: "Guest is booking now", ref: r.booking_ref };
    if (r.status === "checked_in") return { cls: "occupied", label: "In house", who: r.guest_name || "", ref: r.booking_ref };
    if (r.check_in === day) return { cls: "arriving", label: isToday ? "Arriving today" : "Booked · arriving", who: r.guest_name || "", ref: r.booking_ref };
    return { cls: "occupied", label: isToday ? "Booked · not checked in" : "Booked", who: r.guest_name || "", ref: r.booking_ref };
  }

  function soldNights(from, to){
    const nights = [];
    for (const r of S.res){
      if (!SOLD.has(r.status) || r.check_in > to || r.check_out <= from) continue;
      for (let d = r.check_in > from ? r.check_in : from; d <= to && d < r.check_out; d = addDays(d, 1)) nights.push({ d, room: r.room_id, price: r.price_per_night, type: r.room_type });
    }
    return nights;
  }

  function renderDashboard(){
    const today = todayISO();
    const active = S.rooms.filter(r => r.is_active);
    const tn = tonight();
    const occupied = active.filter(r => { const x = tn.get(r.id); return x && x.status !== "held"; }).length;
    const held = active.filter(r => { const x = tn.get(r.id); return x && x.status === "held"; }).length;
    const available = active.length - occupied - held;
    const all = bookings();
    const arrivals = all.filter(b => b.check_in === today && (b.status === "confirmed" || b.status === "checked_in"));
    const departures = all.filter(b => b.check_out === today && (b.status === "checked_in" || b.status === "confirmed" || b.status === "checked_out"));
    const monthStart = today.slice(0, 8) + "01";
    const monthEnd = addDays(addDays(monthStart, 32).slice(0, 8) + "01", -1);
    const mtd = soldNights(monthStart, monthEnd).reduce((s, n) => s + n.price, 0);
    const types = {};
    S.rooms.forEach(r => { if (r.is_active) types[r.room_type] = (types[r.room_type] || 0) + 1; });
    const inactive = S.rooms.length - active.length;
    const occPct = pct(occupied, active.length);

    $("#kpis").innerHTML = [
      kpiTile("Arrivals today", arrivals.length, arrivals.filter(b => b.status === "confirmed").length + " still to check in", "luggage"),
      kpiTile("Occupied tonight", occupied, `of ${active.length} active rooms`, "guests"),
      kpiTile("Departures today", departures.length, departures.filter(b => b.status === "checked_in").length + " still to check out", "out"),
      kpiTile("Available tonight", available, held ? `${held} held by guests booking now` : "Ready to sell", "door"),
      kpiTile("Room revenue · " + dateObj(today).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" }), inr(mtd), "Booked nights this month", "rupee"),
      kpiTile("Occupancy rate", occPct + "%", "Tonight", "gauge", `<span class="mm-kpi__bar" role="presentation"><i style="width:${occPct}%"></i></span>`),
      kpiTile("Total rooms", S.rooms.length, esc(Object.entries(types).map(([t, n]) => `${n} ${t}`).join(" · ") + (inactive ? ` · ${inactive} inactive` : "")), "bed")
    ].join("");

    const day = S.boardDate && S.boardDate >= today ? S.boardDate : today;
    const tnDay = day === today ? tn : tonight(day);
    const freeOnDay = active.filter(r => !tnDay.get(r.id)).length;
    const ahead = active.filter(r => roomState(r, tnDay, day).cls === "reserved").length;
    $("#boardDate").min = today;
    $("#boardDate").value = day;
    $("#boardTitle").textContent = day === today ? "Room status tonight" : "Room status · night of " + fmtShort(day);
    $("#boardSub").textContent = `${fmtDate(day)} · ${freeOnDay} of ${active.length} free ${day === today ? "tonight" : "that night"}${ahead ? ` · ${ahead} booked for later dates` : ""}`;
    $("#roomBoard").innerHTML = S.rooms.map(room => {
      const st = roomState(room, tnDay, day);
      return `<button type="button" class="mm-tile mm-tile--${st.cls} mm-tile--${esc(room.room_type)}" ${st.ref ? `data-ref="${esc(st.ref)}"` : `data-room="${esc(room.id)}"`}
        aria-label="Room ${room.room_number}, ${esc(room.room_type)}, ${esc(st.label)}${st.who ? ", " + esc(st.who) : ""}">
        <span class="mm-tile__no">${room.room_number}</span>
        <span class="mm-tile__type">${room.room_type === "Luxury" ? "★ " : ""}${esc(room.room_type)} · ${inr(room.price_per_night)}</span>
        <span class="mm-tile__state">${esc(st.label)}</span>
        <span class="mm-tile__who">${esc(st.who)}</span></button>`;
    }).join("") || '<p class="mm-empty">No rooms found.</p>';

    renderMoves();
    renderOccChart(today, active.length);

    const recent = all.filter(b => b.status !== "held" && b.status !== "expired").sort((a, b) => a.created_at < b.created_at ? 1 : -1).slice(0, 8);
    $("#recentTable").innerHTML = recent.length
      ? `<thead><tr><th>Booking</th><th>Guest</th><th>Stay</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>` +
        recent.map(b => `<tr><td><button type="button" class="mm-rowbtn" data-ref="${esc(b.ref)}"><span class="ref">${esc(b.ref)}</span></button><span class="sub">${fmtStamp(b.created_at)}</span></td>
          <td>${who(b.guest_name, `${esc(b.guest_name || "—")}<span class="sub">Room ${b.rooms.join(", ")}</span>`)}</td>
          <td>${fmtShort(b.check_in)} → ${fmtShort(b.check_out)}<span class="sub">${plural(b.nights, "night")}</span></td>
          <td class="num">${inr(b.total)}</td><td>${badge(b.status)}</td></tr>`).join("") + "</tbody>"
      : '<tbody><tr><td class="mm-empty">No bookings yet. New ChatBot bookings appear here as soon as they are confirmed.</td></tr></tbody>';
  }

  function renderMoves(){
    const today = todayISO(), end = addDays(today, 6);
    const key = S.moves === "arrivals" ? "check_in" : "check_out";
    const list = bookings().filter(b => b[key] >= today && b[key] <= end &&
      (S.moves === "arrivals" ? (b.status === "confirmed" || b.status === "checked_in") : (b.status === "confirmed" || b.status === "checked_in")))
      .sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
    $$(".mm-seg__btn[data-move]").forEach(btn => btn.setAttribute("aria-selected", btn.dataset.move === S.moves ? "true" : "false"));
    $("#moves").innerHTML = list.length ? list.map(b => {
      const d = dateObj(b[key]);
      const when = S.moves === "arrivals" ? "Arrives " + fmtTime(b.arrival_time) : "Leaves by " + fmtTime(b.departure_time);
      return `<li class="mm-move"><span class="mm-move__date"><small>${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</small><b>${d.getUTCDate()}</b></span>
        <span class="mm-move__who"><button type="button" class="mm-rowbtn" data-ref="${esc(b.ref)}"><b>${esc(b.guest_name || b.ref)}</b></button>
        <small>${esc(b.ref)} · Room ${b.rooms.join(", ")} · ${plural(b.guests, "guest")} · ${esc(when)}</small></span>${badge(b.status)}</li>`;
    }).join("") : `<li class="mm-empty">No ${S.moves} in the next 7 days.</li>`;
  }

  /* ---- charts ----------------------------------------------------------
     One series per chart, so no legend box: the card title names it.
     Thin columns with a 4px rounded top on a single baseline, hairline
     grid, value in the tooltip, a summary for screen readers. */
  function barChart(el, data, { max, ticks, tickFmt, tip, aria, highlight = -1 }){
    const W = 640, H = 230, L = 46, R = 8, T = 10, B = 30;
    const iw = W - L - R, ih = H - T - B;
    const band = iw / Math.max(1, data.length);
    const bw = Math.min(24, band * 0.62);
    const y = v => T + ih - (max ? (v / max) * ih : 0);
    const every = Math.ceil(data.length / Math.floor(iw / 46));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}"><g class="grid">`;
    ticks.forEach(t => { svg += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`; });
    svg += `</g><g class="axis">`;
    ticks.forEach(t => { svg += `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${esc(tickFmt(t))}</text>`; });
    data.forEach((d, i) => { if (i % every === 0) svg += `<text x="${L + band * i + band / 2}" y="${H - 10}" text-anchor="middle">${esc(d.label)}</text>`; });
    svg += `</g>`;
    data.forEach((d, i) => {
      const x = L + band * i + (band - bw) / 2, top = y(d.value), h = T + ih - top;
      const r = Math.min(4, h);
      const path = h <= 0 ? "" : `M${x},${T + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + ih} Z`;
      svg += `<rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${ih}"/>`;
      svg += path ? `<path class="bar${i === highlight ? " bar--today" : ""}" data-i="${i}" d="${path}"/>` : "";
    });
    svg += "</svg>";
    el.innerHTML = svg + '<div class="mm-tip" hidden></div>';
    const tipEl = $(".mm-tip", el), s = $("svg", el);
    const show = i => {
      const d = data[i]; if (!d) return;
      const scale = s.getBoundingClientRect().width / W;
      const offX = s.getBoundingClientRect().left - el.getBoundingClientRect().left;
      const offY = s.getBoundingClientRect().top - el.getBoundingClientRect().top;
      tipEl.innerHTML = tip(d);
      tipEl.style.left = (offX + (L + band * i + band / 2) * scale) + "px";
      tipEl.style.top = (offY + Math.min(y(d.value), T + ih - 2) * scale) + "px";
      tipEl.hidden = false;
      $$(".bar", s).forEach(b => b.classList.toggle("is-hot", Number(b.dataset.i) === i));
    };
    const hide = () => { tipEl.hidden = true; $$(".bar", s).forEach(b => b.classList.remove("is-hot")); };
    $$(".hit", s).forEach(h => {
      h.addEventListener("mouseenter", () => show(Number(h.dataset.i)));
      h.addEventListener("mouseleave", hide);
      h.addEventListener("click", () => show(Number(h.dataset.i)));
    });
    s.addEventListener("mouseleave", hide);
  }

  function renderOccChart(today, activeCount){
    const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
    const nights = soldNights(days[0], days[13]);
    const data = days.map(d => {
      const occ = new Set(nights.filter(n => n.d === d).map(n => n.room)).size;
      return { label: dateObj(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }), date: d, occ, value: pct(occ, activeCount) };
    });
    const peak = data.reduce((m, d) => d.value > m.value ? d : m, data[0]);
    barChart($("#occChart"), data, {
      max: 100, ticks: [0, 25, 50, 75, 100], tickFmt: t => t + "%", highlight: 0,
      tip: d => `${esc(fmtShort(d.date))}<br><b>${d.occ} of ${activeCount}</b> rooms · ${d.value}%`,
      aria: `Occupancy for the next 14 nights. Peak ${peak.value}% on ${fmtShort(peak.date)}. Tonight ${data[0].value}%.`
    });
  }

  const badge = s => `<span class="mm-badge mm-badge--${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

  /* ---- rooms ----------------------------------------------------------- */

  function renderRooms(){
    const today = todayISO();
    const tn = tonight();
    const byType = {};
    S.rooms.forEach(r => { (byType[r.room_type] = byType[r.room_type] || []).push(r); });
    $("#typeRates").innerHTML = ["Normal", "Luxury"].filter(t => byType[t]).map(t => {
      const list = byType[t], act = list.filter(r => r.is_active);
      const prices = [...new Set(list.map(r => r.price_per_night))];
      return `<div class="mm-typerate"><div class="mm-typerate__head"><b><span class="mm-type mm-type--${t}">${t}</span></b>
        <span>${plural(list.length, "room")} · ${act.length} active · ${prices.length === 1 ? inr(prices[0]) : inr(Math.min(...prices)) + "–" + inr(Math.max(...prices))} / night</span></div>
        <form data-type-rate="${t}"><label class="mm-field"><span>New nightly rate for all ${t} rooms (₹)</span>
        <input type="number" name="price" min="1" max="1000000" step="1" required value="${prices.length === 1 ? prices[0] : ""}"></label>
        <button type="submit" class="mm-btn mm-btn--navy">Apply</button></form></div>`;
    }).join("");

    $("#roomsTable").classList.add("mm-table--stack");
    $("#roomsTable").innerHTML = `<thead><tr><th>Room</th><th>Type</th><th class="num">Rate / night (₹)</th><th>Sleeps</th><th>Tonight</th><th class="num">Upcoming</th><th>Bookable</th><th></th></tr></thead><tbody>` +
      S.rooms.map(r => {
        const st = roomState(r, tn, today);
        const upcoming = new Set(S.res.filter(x => x.room_id === r.id && LIVE.has(eff(x)) && x.check_out > today).map(x => x.booking_ref)).size;
        return `<tr data-room-row="${esc(r.id)}">
          <td data-label="Room"><b>Room ${r.room_number}</b></td>
          <td data-label="Type"><select data-f="room_type" aria-label="Room ${r.room_number} type"><option${r.room_type === "Normal" ? " selected" : ""}>Normal</option><option${r.room_type === "Luxury" ? " selected" : ""}>Luxury</option></select></td>
          <td data-label="Rate / night (₹)" class="num"><input type="number" data-f="price_per_night" min="1" max="1000000" step="1" value="${r.price_per_night}" aria-label="Room ${r.room_number} nightly rate in rupees"></td>
          <td data-label="Sleeps"><input type="number" data-f="max_guests" min="1" max="10" step="1" value="${r.max_guests}" aria-label="Room ${r.room_number} capacity"></td>
          <td data-label="Tonight"><span class="mm-tile__state" style="font-size:.84rem">${esc(st.label)}</span></td>
          <td data-label="Upcoming" class="num">${upcoming}</td>
          <td data-label="Bookable"><label class="mm-switch"><input type="checkbox" data-f="is_active"${r.is_active ? " checked" : ""} aria-label="Room ${r.room_number} can be booked"><span>${r.is_active ? "Yes" : "No"}</span></label></td>
          <td data-label=""><button type="button" class="mm-btn mm-btn--navy mm-btn--sm" data-save-room="${esc(r.id)}" disabled>Save</button></td></tr>`;
      }).join("") + "</tbody>";
  }

  function roomRowValues(tr){
    return {
      room_type: $('[data-f="room_type"]', tr).value,
      price_per_night: Number($('[data-f="price_per_night"]', tr).value),
      max_guests: Number($('[data-f="max_guests"]', tr).value),
      is_active: $('[data-f="is_active"]', tr).checked
    };
  }

  function markDirty(tr){
    const room = S.roomById.get(tr.dataset.roomRow);
    const v = roomRowValues(tr);
    const dirty = v.room_type !== room.room_type || v.price_per_night !== room.price_per_night || v.max_guests !== room.max_guests || v.is_active !== room.is_active;
    tr.classList.toggle("is-dirty", dirty);
    $("[data-save-room]", tr).disabled = !dirty;
    $(".mm-switch span", tr).textContent = v.is_active ? "Yes" : "No";
  }

  async function saveRoom(id){
    const tr = $(`[data-room-row="${id}"]`);
    const room = S.roomById.get(id);
    const v = roomRowValues(tr);
    if (!Number.isFinite(v.price_per_night) || v.price_per_night <= 0 || v.price_per_night > 1000000) return toast("Enter a nightly rate between ₹1 and ₹10,00,000.", "error");
    if (!Number.isInteger(v.max_guests) || v.max_guests < 1 || v.max_guests > 10) return toast("Capacity must be between 1 and 10 guests.", "error");
    const today = todayISO();
    const future = S.res.filter(x => x.room_id === id && LIVE.has(eff(x)) && x.check_out > today);
    if (room.is_active && !v.is_active && future.length &&
        !window.confirm(`Room ${room.room_number} has ${plural(new Set(future.map(f => f.booking_ref)).size, "upcoming booking")}. They stay booked — the room just won't be offered for new bookings. Continue?`)) return;
    const crowded = future.filter(f => f.num_guests > v.max_guests);
    if (crowded.length && !window.confirm(`${plural(crowded.length, "upcoming booking")} in room ${room.room_number} ${crowded.length === 1 ? "has" : "have"} more guests than ${v.max_guests}. Existing bookings are not changed. Continue?`)) return;
    const btn = $("[data-save-room]", tr);
    btn.disabled = true; btn.textContent = "Saving…";
    const { data, error } = await S.client.from("rooms").update(v).eq("id", id).select("id");
    btn.textContent = "Save";
    if (error || !data || !data.length){
      btn.disabled = false;
      return toast("Couldn't save room " + room.room_number + ": " + (error ? error.message : "not permitted for this account."), "error");
    }
    toast(`Room ${room.room_number} saved.`, "ok");
    loadAll(true);
  }

  async function saveTypeRate(form){
    const type = form.dataset.typeRate;
    const price = Number(form.elements.price.value);
    if (!Number.isFinite(price) || price <= 0 || price > 1000000) return toast("Enter a nightly rate between ₹1 and ₹10,00,000.", "error");
    const n = S.rooms.filter(r => r.room_type === type).length;
    if (!window.confirm(`Set the nightly rate of all ${n} ${type} rooms to ${inr(price)}? Existing bookings keep the rate they were made at.`)) return;
    const { data, error } = await S.client.from("rooms").update({ price_per_night: price }).eq("hotel_id", S.hotelId).eq("room_type", type).select("id");
    if (error) return toast("Couldn't update rates: " + error.message, "error");
    toast(`${plural(data.length, type + " room")} now ${inr(price)} per night.`, "ok");
    loadAll(true);
  }

  async function checkAvailability(e){
    e.preventDefault();
    const f = e.target, a = f.elements.in.value, b = f.elements.out.value;
    const out = $("#availResult");
    if (!a || !b || b <= a){ out.textContent = "Choose a check-out date after the check-in date."; return; }
    out.textContent = "Checking…";
    const hid = S.hotelId;
    const { data, error } = await S.client.rpc("admin_availability", { p_hotel_id: hid, p_check_in: a, p_check_out: b });
    if (hid !== S.hotelId) return;
    if (error){ out.textContent = "Couldn't check availability: " + error.message; return; }
    const free = data.filter(r => r.is_available);
    const byType = t => free.filter(r => r.room_type === t).length;
    out.innerHTML = `<b>${free.length} of ${data.length}</b> active rooms free for ${esc(fmtShort(a))} → ${esc(fmtShort(b))} (${plural(diffDays(a, b), "night")}) · ${byType("Normal")} Normal, ${byType("Luxury")} Luxury`
      + `<span class="mm-avail-list">${data.map(r => `<span class="mm-avail-pill${r.is_available ? "" : " mm-avail-pill--taken"}"><span class="mm-type mm-type--${esc(r.room_type)}">${r.room_number}</span>${r.is_available ? inr(r.price_per_night) : "booked"}</span>`).join("")}</span>`;
  }

  /* ---- reservations ---------------------------------------------------- */

  function resFilters(){
    const f = $("#resFilters").elements;
    return { q: f.q.value.trim().toLowerCase(), status: f.status.value, type: f.type.value, from: f.from.value, to: f.to.value };
  }

  function renderReservations(){
    const F = resFilters();
    const today = todayISO();
    let list = bookings();
    list = list.filter(b => {
      if (F.status === "active" && !((b.status === "confirmed" || b.status === "checked_in") && b.check_out >= today)) return false;
      if (F.status !== "active" && F.status !== "all" && b.status !== F.status) return false;
      if (F.status === "all" && b.status === "expired" && !F.q) return false;
      if (F.type && !b.types.includes(F.type)) return false;
      if (F.from && b.check_out <= F.from) return false;
      if (F.to && b.check_in > F.to) return false;
      if (F.q){
        const qd = digits(F.q);
        const hay = [b.ref, b.guest_name, b.guest_email].join(" ").toLowerCase();
        const roomHit = /^(room\s*)?\d{1,2}$/.test(F.q) && b.rooms.includes(Number(digits(F.q)));
        if (!hay.includes(F.q) && !(qd.length >= 4 && digits(b.guest_phone).includes(qd)) && !roomHit) return false;
      }
      return true;
    });
    list.sort(F.status === "active" ? (a, b) => a.check_in < b.check_in ? -1 : a.check_in > b.check_in ? 1 : 0
                                     : (a, b) => a.created_at < b.created_at ? 1 : -1);
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    S.resPage = Math.min(S.resPage, pages - 1);
    const shown = list.slice(S.resPage * PAGE, S.resPage * PAGE + PAGE);
    $("#resCount").textContent = list.length ? `${plural(list.length, "booking")} · ${inr(list.filter(b => SOLD.has(b.status)).reduce((s, b) => s + b.total, 0))} booked value` : "";
    const t = $("#resTable");
    t.classList.add("mm-table--stack");
    t.innerHTML = shown.length
      ? `<thead><tr><th>Booking</th><th>Guest</th><th>Stay</th><th>Rooms</th><th class="num">Guests</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>` +
        shown.map(b => `<tr>
          <td data-label="Booking"><button type="button" class="mm-rowbtn" data-ref="${esc(b.ref)}"><span class="ref">${esc(b.ref)}</span></button><span class="sub">${b.source === "chatbot" ? "ChatBot" : "Admin"} · ${fmtStamp(b.created_at)}</span></td>
          <td data-label="Guest">${who(b.guest_name, `${esc(b.guest_name || "—")}<span class="sub">${esc(b.guest_phone || "")}</span>`)}</td>
          <td data-label="Stay">${fmtShort(b.check_in)} → ${fmtShort(b.check_out)}<span class="sub">${plural(b.nights, "night")} · arrives ${fmtTime(b.arrival_time)}</span></td>
          <td data-label="Rooms">${b.rows.map(r => `<span class="mm-type mm-type--${esc(r.room_type)}">${(S.roomById.get(r.room_id) || {}).room_number || "?"}</span>`).join(" ")}</td>
          <td data-label="Guests" class="num">${b.guests}</td>
          <td data-label="Total" class="num">${inr(b.total)}</td>
          <td data-label="Status">${badge(b.status)}</td></tr>`).join("") + "</tbody>"
      : `<tbody><tr><td class="mm-empty">${S.res.length ? "No bookings match these filters." : "No bookings yet. Bookings made through the ChatBot appear here as soon as they are confirmed."}</td></tr></tbody>`;
    $("#resPager").innerHTML = pages > 1
      ? `<button type="button" class="mm-btn mm-btn--outline mm-btn--sm" data-page="-1"${S.resPage === 0 ? " disabled" : ""}>Previous</button>
         <span>Page ${S.resPage + 1} of ${pages}</span>
         <button type="button" class="mm-btn mm-btn--outline mm-btn--sm" data-page="1"${S.resPage >= pages - 1 ? " disabled" : ""}>Next</button>` : "";
  }

  /* ---- drawer: one booking ---------------------------------------------- */

  function openDrawer(title, html){
    S.opener = document.activeElement;
    $("#drawerTitle").textContent = title;
    $("#drawerBody").innerHTML = html;
    $("#drawer").hidden = false;
    $("#drawerBack").hidden = false;
    setTimeout(() => $("#drawerClose").focus(), 20);
  }
  function closeDrawer(){
    if ($("#drawer").hidden) return;
    $("#drawer").hidden = true;
    $("#drawerBack").hidden = true;
    $("#drawerBody").innerHTML = "";
    if (S.opener && document.contains(S.opener)) S.opener.focus();
  }

  function openBooking(ref){
    const b = bookings().find(x => x.ref === ref);
    if (!b) return toast("That booking is no longer in the list.", "error");
    const today = todayISO();
    const acts = [];
    if (b.status === "confirmed" && b.check_in <= today) acts.push(`<button type="button" class="mm-btn mm-btn--success" data-status="checked_in">Check in</button>`);
    if (b.status === "checked_in") acts.push(`<button type="button" class="mm-btn mm-btn--success" data-status="checked_out">Check out</button>`);
    if (b.status === "confirmed" && b.check_in <= today) acts.push(`<button type="button" class="mm-btn mm-btn--outline" data-status="no_show">Mark no-show</button>`);
    if (b.status === "confirmed") acts.push(`<button type="button" class="mm-btn mm-btn--outline" data-cancel>Cancel booking</button>`);
    if (b.status === "held") acts.push(`<button type="button" class="mm-btn mm-btn--outline" data-status="cancelled">Release hold</button>`);
    const lines = b.rows.map(r => {
      const room = S.roomById.get(r.room_id) || {};
      return `<div class="mm-lines__row"><span><b>Room ${room.room_number || "?"}</b> · ${esc(r.room_type)} · ${plural(r.num_guests, "guest")}<br><small>${inr(r.price_per_night)} × ${plural(r.nights, "night")}</small></span><span class="num">${inr(r.total_price)}</span></div>`;
    }).join("");
    openDrawer("Booking " + b.ref, `
      <div>${badge(b.status)}</div>
      <dl class="mm-dl">
        <dt>Guest</dt><dd>${b.guest_id ? `<button type="button" class="mm-rowbtn mm-link" data-guest="${esc(b.guest_id)}">${esc(b.guest_name)}</button>` : esc(b.guest_name || "Not yet given")}</dd>
        <dt>Email</dt><dd>${b.guest_email ? `<a class="mm-link" href="mailto:${esc(b.guest_email)}">${esc(b.guest_email)}</a>` : "—"}</dd>
        <dt>Mobile</dt><dd>${b.guest_phone ? `<a class="mm-link" href="tel:${esc(b.guest_phone)}">${esc(b.guest_phone)}</a>` : "—"}</dd>
        <dt>Check-in</dt><dd>${fmtDate(b.check_in)} · arrives ${fmtTime(b.arrival_time)}</dd>
        <dt>Check-out</dt><dd>${fmtDate(b.check_out)} · by ${fmtTime(b.departure_time)}</dd>
        <dt>Stay</dt><dd>${plural(b.nights, "night")} · ${plural(b.guests, "guest")} · ${plural(b.rows.length, "room")}</dd>
        <dt>Booked</dt><dd>${fmtStamp(b.created_at)} via ${b.source === "chatbot" ? "ChatBot" : "admin"}</dd>
        ${b.confirmed_at ? `<dt>Confirmed</dt><dd>${fmtStamp(b.confirmed_at)}</dd>` : ""}
        ${b.status === "held" ? `<dt>Hold expires</dt><dd>${fmtStamp(b.hold_expires_at)}</dd>` : ""}
        ${b.cancelled_at ? `<dt>Cancelled</dt><dd>${fmtStamp(b.cancelled_at)}${b.cancel_reason ? " · " + esc(b.cancel_reason) : ""}</dd>` : ""}
      </dl>
      <div><p class="mm-section-title">Rooms &amp; charges</p><div class="mm-lines">${lines}<div class="mm-lines__row mm-lines__row--total"><span>Total</span><span>${inr(b.total)}</span></div></div></div>
      ${acts.length ? `<div><p class="mm-section-title">Actions</p><div class="mm-actions" data-booking="${esc(b.ref)}">${acts.join("")}</div><div id="cancelBox"></div></div>` : ""}
    `);
  }

  function showCancel(ref){
    $("#cancelBox").innerHTML = `<form class="mm-confirm" data-cancel-form="${esc(ref)}">
      <p>Cancel booking ${esc(ref)}? Its rooms become available to other guests straight away. This can't be undone.</p>
      <label class="mm-field"><span>Reason (optional, kept with the booking)</span><input name="reason" maxlength="300"></label>
      <div class="mm-actions"><button type="submit" class="mm-btn mm-btn--danger">Cancel booking</button>
      <button type="button" class="mm-btn mm-btn--ghost" data-keep>Keep booking</button></div></form>`;
    $("#cancelBox input").focus();
  }

  async function setStatus(ref, status, reason){
    const box = $(`[data-booking="${ref}"]`);
    if (box) $$("button", box).forEach(b => { b.disabled = true; });
    const { data, error } = await S.client.rpc("admin_update_booking_status", { p_booking_ref: ref, p_status: status, p_reason: reason || null });
    if (error || !data || !data.ok){
      if (box) $$("button", box).forEach(b => { b.disabled = false; });
      const why = error ? error.message : ({ invalid_transition: "its current status doesn't allow that", not_found: "it wasn't found" }[data && data.reason] || "unknown error");
      return toast(`Couldn't update ${ref}: ${why}.`, "error");
    }
    toast(`${ref}: ${STATUS_LABEL[status]}.`, "ok");
    await loadAll(true);
    openBooking(ref);
  }

  /* ---- guests ----------------------------------------------------------- */

  function renderGuests(){
    const q = $("#guestFilters").elements.q.value.trim().toLowerCase();
    const qd = digits(q);
    const list = S.guests.filter(g => !q || (g.full_name + " " + g.email).toLowerCase().includes(q) || (qd.length >= 4 && digits(g.phone).includes(qd)));
    $("#guestCount").textContent = S.guests.length ? `${plural(list.length, "guest")}${q ? " found" : ""}` : "";
    const t = $("#guestTable");
    t.classList.add("mm-table--stack");
    t.innerHTML = list.length
      ? `<thead><tr><th>Guest</th><th>Mobile</th><th class="num">Bookings</th><th class="num">Total spend</th><th>Last stay</th><th>Next stay</th></tr></thead><tbody>` +
        list.map(g => `<tr>
          <td data-label="Guest">${who(g.full_name, `<button type="button" class="mm-rowbtn" data-guest="${esc(g.id)}"><b>${esc(g.full_name)}</b></button><span class="sub">${esc(g.email)}</span>`)}</td>
          <td data-label="Mobile">${esc(g.phone)}</td>
          <td data-label="Bookings" class="num">${Number(g.bookings)}${Number(g.cancelled) ? `<span class="sub">${g.cancelled} cancelled</span>` : ""}</td>
          <td data-label="Total spend" class="num">${inr(g.total_spend)}</td>
          <td data-label="Last stay">${g.last_stay ? fmtShort(addDays(g.last_stay, 0)) : "—"}</td>
          <td data-label="Next stay">${g.next_stay ? fmtShort(g.next_stay) : "—"}</td></tr>`).join("") + "</tbody>"
      : `<tbody><tr><td class="mm-empty">${S.guests.length ? "No guests match." : "No guests yet. A profile is created when a guest confirms their first booking."}</td></tr></tbody>`;
  }

  function openGuest(id){
    const g = S.guests.find(x => x.id === id);
    if (!g) return;
    const hist = bookings(S.res.filter(r => r.guest_id === id)).sort((a, b) => a.check_in < b.check_in ? 1 : -1);
    openDrawer(g.full_name, `
      <dl class="mm-dl">
        <dt>Email</dt><dd><a class="mm-link" href="mailto:${esc(g.email)}">${esc(g.email)}</a></dd>
        <dt>Mobile</dt><dd><a class="mm-link" href="tel:${esc(g.phone)}">${esc(g.phone)}</a></dd>
        <dt>Guest since</dt><dd>${fmtStamp(g.created_at)}</dd>
        <dt>Bookings</dt><dd>${Number(g.bookings)}${Number(g.cancelled) ? ` (${g.cancelled} cancelled)` : ""}</dd>
        <dt>Total spend</dt><dd>${inr(g.total_spend)}</dd>
      </dl>
      <div><p class="mm-section-title">Booking history</p><div class="mm-lines">${hist.length ? hist.map(b =>
        `<div class="mm-lines__row"><span><button type="button" class="mm-rowbtn" data-ref="${esc(b.ref)}"><b class="ref">${esc(b.ref)}</b></button><br><small>${fmtShort(b.check_in)} → ${fmtShort(b.check_out)} · Room ${b.rooms.join(", ")}</small></span><span style="text-align:right">${inr(b.total)}<br>${badge(b.status)}</span></div>`).join("")
        : '<div class="mm-lines__row">No bookings.</div>'}</div></div>`);
  }

  /* ---- reports ---------------------------------------------------------- */

  function setRange(kind){
    const today = todayISO();
    let from, to;
    if (kind === "last30"){ from = addDays(today, -29); to = today; }
    else if (kind === "next30"){ from = today; to = addDays(today, 29); }
    else { from = today.slice(0, 8) + "01"; to = addDays(addDays(from, 32).slice(0, 8) + "01", -1); }
    const f = $("#reportForm").elements;
    f.from.value = from; f.to.value = to;
    $$("[data-range]").forEach(b => b.setAttribute("aria-pressed", b.dataset.range === kind ? "true" : "false"));
  }

  async function loadReport(){
    const f = $("#reportForm").elements;
    if (!f.from.value) setRange("month");
    const from = f.from.value, to = f.to.value;
    if (!from || !to || to < from){ toast("Choose an end date on or after the start date.", "error"); return; }
    if (diffDays(from, to) > 366){ toast("Reports cover up to a year at a time.", "error"); return; }
    $("#reportKpis").innerHTML = '<div class="mm-kpi"><span class="mm-skel" style="width:50%"></span><span class="mm-skel" style="height:2rem;width:40%"></span></div>';
    const hid = S.hotelId;
    const { data, error } = await S.client.rpc("admin_report", { p_hotel_id: hid, p_from: from, p_to: to });
    if (hid !== S.hotelId) return;
    if (error){ $("#reportKpis").innerHTML = ""; banner("Couldn't load the report: " + error.message, true); return; }
    S.report = data;
    renderReport();
  }

  function renderReport(){
    const r = S.report;
    if (!r) return;
    const capacity = r.active_rooms * r.days;
    const rev = Number(r.room_revenue), sold = Number(r.room_nights_sold);
    const kpi = (label, val, foot, icon) => kpiTile(label, val, esc(foot), icon);
    $("#reportKpis").innerHTML = [
      kpi("Room revenue", inr(rev), `${fmtShort(r.from)} – ${fmtShort(r.to)}`, "rupee"),
      kpi("Room-nights sold", sold, `of ${capacity} available`, "moon"),
      kpi("Occupancy", pct(sold, capacity) + "%", `${r.active_rooms} active rooms × ${plural(r.days, "day")}`, "gauge"),
      kpi("ADR", inr(sold ? Math.round(rev / sold) : 0), "Average rate per sold night", "tag"),
      kpi("RevPAR", inr(capacity ? Math.round(rev / capacity) : 0), "Revenue per available room-night", "chart"),
      kpi("Bookings made", Number(r.bookings_made), `${inr(r.bookings_value)} booked in the period`, "calendar"),
      kpi("Cancellations", Number(r.cancellations), "Cancelled in the period")
    ].join("");

    const daily = r.daily || [];
    const lbl = d => dateObj(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    const maxRev = Math.max(...daily.map(d => Number(d.revenue)), 0);
    const step = niceStep(maxRev || 1000);
    const top = Math.max(step * 4, Math.ceil(maxRev / step) * step);
    $("#revSub").textContent = `INR per night · total ${inr(rev)}`;
    barChart($("#revChart"), daily.map(d => ({ label: lbl(d.date), date: d.date, value: Number(d.revenue), occ: Number(d.occupied) })), {
      max: top, ticks: [0, top / 4, top / 2, 3 * top / 4, top], tickFmt: inrShort,
      tip: d => `${esc(fmtShort(d.date))}<br><b>${inr(d.value)}</b> · ${plural(d.occ, "room")}`,
      aria: `Room revenue by night from ${fmtShort(r.from)} to ${fmtShort(r.to)}, total ${inr(rev)}.`
    });
    barChart($("#repOccChart"), daily.map(d => ({ label: lbl(d.date), date: d.date, value: pct(Number(d.occupied), r.active_rooms), occ: Number(d.occupied) })), {
      max: 100, ticks: [0, 25, 50, 75, 100], tickFmt: t => t + "%",
      tip: d => `${esc(fmtShort(d.date))}<br><b>${d.occ} of ${r.active_rooms}</b> rooms · ${d.value}%`,
      aria: `Occupancy by night from ${fmtShort(r.from)} to ${fmtShort(r.to)}, average ${pct(sold, capacity)}%.`
    });

    const types = (r.by_type || []);
    const all = types.reduce((s, t) => s + Number(t.revenue), 0);
    $("#typeSplit").innerHTML = types.length ? `<div class="mm-split">${types.map(t => `
      <div class="mm-split__row mm-split__row--${esc(t.room_type)}"><span class="mm-type mm-type--${esc(t.room_type)}">${esc(t.room_type)}</span>
      <span class="mm-split__bar" role="presentation"><i style="width:${pct(Number(t.revenue), all)}%"></i></span>
      <span class="mm-split__val">${inr(t.revenue)} · ${pct(Number(t.revenue), all)}%<small>${plural(Number(t.room_nights), "room-night")}</small></span></div>`).join("")}</div>
      <details style="padding:0 1.2rem 1.2rem"><summary class="mm-link">View nightly figures as a table</summary>
      <div class="mm-table-wrap"><table class="mm-table mm-table--compact"><thead><tr><th>Night</th><th class="num">Rooms sold</th><th class="num">Occupancy</th><th class="num">Revenue</th></tr></thead><tbody>
      ${daily.map(d => `<tr><td>${fmtShort(d.date)}</td><td class="num">${d.occupied}</td><td class="num">${pct(Number(d.occupied), r.active_rooms)}%</td><td class="num">${inr(d.revenue)}</td></tr>`).join("")}</tbody></table></div></details>`
      : '<p class="mm-empty">No sold room-nights in this period.</p>';
  }

  function niceStep(max){
    const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
  }

  function exportCsv(){
    const r = S.report;
    if (!r) return toast("Load a report first.", "error");
    const rows = [["night", "rooms_sold", "active_rooms", "occupancy_pct", "room_revenue_inr"]]
      .concat((r.daily || []).map(d => [d.date, d.occupied, r.active_rooms, pct(Number(d.occupied), r.active_rooms), Number(d.revenue).toFixed(2)]));
    const blob = new Blob([rows.map(x => x.join(",")).join("\n") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `misty-mountain-report-${r.from}-to-${r.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ================================================================ WIRING */

  function bindStatic(){
    $("#hotelSwitch").addEventListener("change", e => switchHotel(e.target.value));
    $("#mmSignin").addEventListener("submit", signIn);
    $("#mmSignup").addEventListener("submit", signUp);
    $("#resendBtn").addEventListener("click", resend);
    $$("[data-auth-tab]").forEach(b => b.addEventListener("click", () => {
      authTab(b.dataset.authTab); gateError(""); signupError("");
      $(b.dataset.authTab === "signup" ? "#signupName" : "#signinEmail").focus();
    }));
    $(".mm-auth__tabs").addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const next = $("#tabSignin").getAttribute("aria-selected") === "true" ? "signup" : "signin";
      authTab(next); $(next === "signup" ? "#tabSignup" : "#tabSignin").focus();
    });
    $("#signupPassword").addEventListener("input", checkRules);
    $("#signupConfirm").addEventListener("input", () => {
      const c = $("#signupConfirm").value;
      if (c && c.length >= $("#signupPassword").value.length) fieldError("signupConfirm", c !== $("#signupPassword").value ? "The passwords don't match." : "");
      else if (!c) fieldError("signupConfirm", "");
    });
    $$("#mmSignup input").forEach(i => i.addEventListener("blur", () => {
      if (!i.value) return;
      if (i.id === "signupName") fieldError("signupName", NAME_RE.test(i.value.trim().replace(/\s+/g, " ")) ? "" : "Use letters only (spaces, hyphens and apostrophes are fine).");
      if (i.id === "signupEmail") fieldError("signupEmail", EMAIL_RE.test(i.value.trim()) ? "" : "That email address doesn't look right.");
    }));
    $$("[data-pw-toggle]").forEach(b => b.addEventListener("click", () => {
      const input = b.parentElement.querySelector("input");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.textContent = show ? "Hide" : "Show";
      b.setAttribute("aria-pressed", show ? "true" : "false");
      b.setAttribute("aria-label", show ? "Hide password" : "Show password");
    }));
    $("#gSignOut").addEventListener("click", async () => { if (S.client) await S.client.auth.signOut(); leave(); });
    $("#boardDate").addEventListener("change", e => { S.boardDate = e.target.value; renderDashboard(); });
    $("#signOutBtn").addEventListener("click", async () => { if (S.client) await S.client.auth.signOut(); leave(); });
    window.addEventListener("hashchange", route);
    $("#menuBtn").addEventListener("click", () => navOpen(!$("#mmApp").classList.contains("is-nav-open")));
    $("#mmScrim").addEventListener("click", () => navOpen(false));
    $("#refreshBtn").addEventListener("click", () => loadAll());
    $$(".mm-seg__btn[data-move]").forEach(b => b.addEventListener("click", () => { S.moves = b.dataset.move; renderMoves(); }));

    $("#globalSearch").addEventListener("submit", e => {
      e.preventDefault();
      const f = $("#resFilters").elements;
      f.q.value = $("#globalSearchInput").value;
      f.status.value = "all";
      S.resPage = 0;
      if (location.hash !== "#reservations") location.hash = "#reservations"; else renderReservations();
      renderReservations();
    });
    $("#resFilters").addEventListener("input", () => { S.resPage = 0; renderReservations(); });
    $("#resFilters").addEventListener("reset", () => setTimeout(() => { S.resPage = 0; renderReservations(); }, 0));
    $("#resFilters").addEventListener("submit", e => e.preventDefault());
    $("#resPager").addEventListener("click", e => { const b = e.target.closest("[data-page]"); if (b){ S.resPage += Number(b.dataset.page); renderReservations(); } });
    $("#guestFilters").addEventListener("input", renderGuests);
    $("#guestFilters").addEventListener("submit", e => e.preventDefault());

    $("#availForm").addEventListener("submit", checkAvailability);
    $("#typeRates").addEventListener("submit", e => { const f = e.target.closest("[data-type-rate]"); if (f){ e.preventDefault(); saveTypeRate(f); } });
    $("#roomsTable").addEventListener("input", e => { const tr = e.target.closest("[data-room-row]"); if (tr) markDirty(tr); });
    $("#roomsTable").addEventListener("change", e => { const tr = e.target.closest("[data-room-row]"); if (tr) markDirty(tr); });
    $("#roomsTable").addEventListener("click", e => { const b = e.target.closest("[data-save-room]"); if (b) saveRoom(b.dataset.saveRoom); });

    $("#reportForm").addEventListener("submit", e => { e.preventDefault(); $$("[data-range]").forEach(b => b.setAttribute("aria-pressed", "false")); loadReport(); });
    $$("[data-range]").forEach(b => b.addEventListener("click", () => { setRange(b.dataset.range); loadReport(); }));
    $("#exportCsv").addEventListener("click", exportCsv);

    // Anything that names a booking or a guest opens it.
    document.addEventListener("click", e => {
      if ($("#mmApp").hidden || S.mode !== "admin") return;
      const ref = e.target.closest("[data-ref]");
      if (ref && !e.target.closest(".dock")){ openBooking(ref.dataset.ref); return; }
      const g = e.target.closest("[data-guest]");
      if (g){ openGuest(g.dataset.guest); return; }
      const room = e.target.closest(".mm-tile[data-room]");
      if (room){ location.hash = "#rooms"; return; }
      const st = e.target.closest("[data-booking] [data-status]");
      if (st){ setStatus(st.closest("[data-booking]").dataset.booking, st.dataset.status); return; }
      const c = e.target.closest("[data-booking] [data-cancel]");
      if (c){ showCancel(c.closest("[data-booking]").dataset.booking); return; }
      if (e.target.closest("[data-keep]")){ $("#cancelBox").innerHTML = ""; }
    });
    document.addEventListener("submit", e => {
      const f = e.target.closest("[data-cancel-form]");
      if (f){ e.preventDefault(); setStatus(f.dataset.cancelForm, "cancelled", f.elements.reason.value.trim()); }
    });
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerBack").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !$("#drawer").hidden){ e.preventDefault(); closeDrawer(); }
      if (e.key === "Tab" && !$("#drawer").hidden){
        const f = $$("#drawer button, #drawer a[href], #drawer input, #drawer select").filter(n => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]){ e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]){ e.preventDefault(); f[0].focus(); }
      }
    });
    setRange("month");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
