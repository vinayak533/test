# Misty Mountain — hotel dashboard and booking ChatBot

A hotel management dashboard for Misty Mountain, with a guest-facing booking
ChatBot, both backed by Supabase. Guests check real availability and book a
room through the ChatBot; staff sign in to manage rooms, rates, reservations
and guests, and to read revenue and occupancy reports.

## Files

| File | What it is |
|---|---|
| `index.html` | The welcome screen with sign-in / sign-up, the guest area, the dashboard markup and the ChatBot. |
| `hotel_admin.js` / `hotel_admin.css` | Supabase Auth sign-in and sign-up for everyone, then the staff dashboard: live data, edits, reports. The stylesheet covers the guest area too. |
| `hotel_guest.js` | The signed-in guest's area: live room board for any dates, their own bookings, cancelling. |
| `server/` | The backend for `POST /api/chat` and `GET /api/config` (see below). |
| `netlify/functions/` | Thin adapters from Netlify Functions to `server/app.js`. |
| `supabase/migrations/` | Schema, seed, booking functions, security. Idempotent; run in order. |
| `scripts/` | `migrate.js`, `create_admin.js`, `inspect_schema.js`, `dev_server.js`. |
| `tests/` | Unit tests (`npm test`) and live-database tests (`tests/db/`, `npm run test:db`). |
| `misty_i18n.js` | The language pack: English, Malayalam, Hindi and Tamil. |
| `sync_i18n_inline.js` | Copies `LANGS` and `UI` from the pack into the HTML. Run it after editing either. |
| `smoke_test.js` | Pre-deploy checks. Run it before shipping. |
| `misty_knowledge_base.js` | The verified photo library, the nearby-places data and the Google Maps URL builders. |
| `misty_knowledge_qa.js` | 1,000 question-and-answer pairs. |
| `misty_mountain_details.md` / `.json` | The source research the answers are grounded in. |

## Running it

```bash
npm install
npm run db:migrate          # schema, seed, functions, RLS — safe to re-run
npm run admin:create -- you@example.com   # once: a dashboard login (prints a temporary password)
npm run serve               # http://localhost:8792 — page, /api/chat, /api/config
```

`npx netlify dev` runs the real functions locally as well. The page alone can
still be served by any static server (`python -m http.server`); the ChatBot then
answers from its knowledge base and says plainly that it can't check rooms.

The ChatBot's three data files are loaded as classic `<script src>` tags, so they must sit
in the same folder as the HTML.

If the knowledge-base files fail to load for any reason, the assistant falls back to
the ~60 hand-written intents built into the page and keeps working — it simply
loses the 1,000-pair corpus, the map cards and the picture tiles on the Home page.
The Home photograph itself survives: `HERO_FALLBACK` in the page holds one URL from
the same library.

The language layer survives too. `LANGS` and `UI` — the dropdown and every fixed
label in the panel, about 18 KB — are copied into the HTML ahead of the script tag
by `sync_i18n_inline.js`, so a page opened without its siblings still offers all
four languages instead of collapsing to English and printing key names like
`tabHome` where labels belong. When `misty_i18n.js` does load it replaces
`window.MM_I18N` wholesale and the copy is never consulted. Re-run

```bash
node sync_i18n_inline.js
```

after editing `LANGS` or `UI`; the other three datasets are not duplicated.

## Languages

The ChatBot is offered in **English, Malayalam, Hindi and Tamil**, chosen from the
dropdown in its header. English is the default on every load. Switching language
re-renders the whole panel — chrome, starters, panels, the picture caption — and
clears the conversation so a transcript is never half in one language.

`misty_i18n.js` holds four datasets:

* `UI` — every fixed string in the panel.
* `DATA` — the prose parts of `ESTATE` (room names, amenity lists, activities).
  Numbers, phone numbers and opening hours are not duplicated there.
* `REPLY` — all 64 hand-written intent answers, keyed by intent id, with
  `{CALL}`, `{MAIL}`, `{BOOK}`, `{REST}` and `{WHATSAPP}` filled in at render
  time. English is absent on purpose: it reads the KB itself, so the two cannot
  drift apart.
* `TERMS` — native-script vocabulary mapped onto the English tokens the matcher
  already indexes. `normalise()` strips everything outside `[a-z0-9]`, which
  would reduce an Indian-language question to nothing, so the English
  equivalents are appended first and the existing scorer and corpus work
  unchanged. Keys match as substrings, because all three languages inflect by
  suffix.

Beyond that, `t(key, fallback)` falls through the current pack, then the English
pack, then the English authored into the markup itself, and only then to the key —
so a label can never be blanked out or replaced by its own key.

`misty_i18n.js` also holds two datasets keyed on the knowledge base rather than
on English text, so rewording the English can never silently drop a translation:

* `MEDIA` — the 86 photograph captions, keyed by their key in `MM_MEDIA.pics`.
  `picAlt()` resolves a picture back to its key through a `WeakMap` built on
  first use, because `MM_MEDIA.sets` holds the very same objects by reference.
* `PLACES` — the 18 nearby places: `name`, `dist`, `what` and `detail`.
  `q` and `url` are deliberately *not* translated and `localPlace()` re-pins
  them after merging, because they drive the Google Maps lookup — translate the
  query and the pin stops resolving.

Neither is copied into the inline bootstrap. They caption data that lives in
`misty_knowledge_base.js`, so if that file is missing there is nothing to
caption anyway.

**Not translated:** the 1,000-pair corpus, which is English source data. Outside English
the corpus is demoted from competitor to long tail — it answers only where no
intent matched at all, and when it does the answer carries a line saying it came
from the estate's English notes. The page around the panel stays English too.

That is a deliberate stopping point, not an oversight. The corpus is 240,000
characters; the 64 hand-written intents, which are translated, own the questions
guests actually arrive with, and they carry the laid-out panels. Machine-
translating 3,000 answers about refund windows, road distances and where the
rock is unfenced would put unreviewed text in front of guests on exactly the
questions where being wrong costs something. Saying "this came from our English
notes" is the honest answer until someone reviews a translation.

## How the assistant answers

Two layers, arbitrated in `respond()`:

1. **Hand-written intents** (`KB` in the HTML) own small talk and the broad
   "tell me about the rooms" questions, because they carry the laid-out panels.
2. **The 1,000-pair corpus** (`misty_knowledge_qa.js`) owns everything specific.
   It is retrieved with an IDF-weighted inverted index scored on *coverage*
   (how much of the guest's question the entry explains) and *precision* (how
   much of the entry's own question the guest actually asked for).

A decisive keyword hit on layer 1 requires a high-confidence corpus match to
override it; otherwise the corpus wins whenever it is reasonably confident.
Neither layer invents anything: where the estate publishes no answer, the
answer says so and points at the reception number.

## Bookings (Supabase)

### The database

`supabase/migrations/`, applied in order by `npm run db:migrate`:

| File | What it does |
|---|---|
| `001_schema.sql` | `hotels`, `rooms`, `guests`, `reservations`, constraints, indexes. Upgrades the earlier prototype tables in place (removing only their demo rows, by exact key) and stops rather than delete anything else. |
| `002_seed_misty_mountain.sql` | The one hotel and rooms 1–10. Upserts on natural keys, so re-running never duplicates; rates, types and capacity are written only when a room is first created, so dashboard edits survive a re-run. |
| `003_booking_functions.sql` | `get_availability`, `hold_rooms`, `confirm_booking`, `release_hold`, `find_booking`, and the admin functions `admin_availability`, `admin_update_booking_status`, `admin_report`. |
| `004_security.sql` | RLS, grants, the `guest_summaries` view, Realtime publication. |
| `005_guest_accounts.sql` | Guest accounts: `room_board`, `my_bookings`, `cancel_my_booking`, and `inventory_pulse` (the change signal the guest area listens to). `reservations.user_id` (in `001`) links a booking to the account that made it. |

Seeded inventory: rooms 1–6 **Normal at ₹2,500**, rooms 7–10 **Luxury at ₹4,500**,
each sleeping up to 3 (the estate's published maximum). Policy: check-in from
14:00, check-out by 12:00. Money is `numeric`, always INR.

A reservation row is one room for one stay; a booking of two rooms is two rows
sharing a `booking_ref` (`MM-` + six characters from an alphabet without
0/O/1/I/L). Each row keeps the rate it was booked at and a snapshot of the guest's
contact details; `guests` holds one profile per email address, so repeat stays
build a history.

**What blocks a room for a night:** `confirmed` and `checked_in` always; `held`
until its `hold_expires_at`. `checked_out`, `cancelled`, `no_show` and `expired`
never do. Nights are half-open `[check_in, check_out)`, so a guest leaving on the
22nd never blocks one arriving on the 22nd — honest only because check-out (12:00)
is before check-in (14:00), which a constraint on `hotels` enforces.

**No double-booking, by construction.** `hold_rooms` and `confirm_booking` each
run as one transaction: they lock the room rows (in a fixed order, so concurrent
callers queue instead of deadlocking), sweep lapsed holds, check for overlaps and
write. Underneath, an exclusion constraint makes it impossible for a room to carry
two live rows for the same night whatever any code does. `tests/db/` fires ten
simultaneous holds at one room and checks exactly one wins.

### The booking conversation

`server/booking/flow.js` — a slot-filling dialogue that asks only for what it
does not know yet:

```
check-in date → arrival time → check-out date (time follows policy, 12:00)
→ guests and rooms → room type (Normal / Luxury / either, with live rates)
→ live availability: real room numbers, types, rates, stay total
→ "Book This Room" → a 15-minute hold (not a booking)
→ guest name, mobile, email → summary → "Confirm booking" → saved, MM-XXXXXX
```

Every question comes with tappable options — dates (plus a date picker), times,
guest/room combinations, room types, the room list, a short guest form — and the
input box always says what can be typed instead ("Tap a time, or type one…").
Typed answers go through the same validation as taps. One message can answer
several questions ("2 luxury rooms from Oct 20 to 22 for 4 guests, arriving 2pm"
goes straight to availability).

Validation: no past check-in, no arrival time already past today, check-out after
check-in, at most 30 nights and 18 months ahead, guests ≤ rooms × capacity, at least
one guest per room, no more rooms of a type than exist, check-out no later than
policy. The database repeats the checks that matter.

Nothing is written until **Book This Room** (a hold that lapses on its own), and
nothing is booked until **Confirm booking** after the summary has been shown. If
the room goes in between, the guest is told and shown fresh availability. A
second "Confirm" returns the same booking; a confirmation whose reply was lost can
be retried safely.

**Look-ups:** "check my booking" → the reference → the email or mobile it was made
with. The answer is identical whichever part is wrong; three failures end the
look-up, and failed look-ups are rate-limited per address. Contact details are
shown masked.

**Hotels:** "which hotels are available / where can I stay / which hotel do you
support" is answered from the `hotels` table: *Misty Mountain is currently the
only hotel available on this platform.* Another hotel by name gets the same answer;
none is ever invented.

**State:** Netlify Functions keep nothing between requests, so the conversation's
state travels with it as an HMAC-signed token (`server/booking/state.js`), held in
a page variable only — never in storage — and dropped with the transcript. Prices
and availability are always re-read from the database; a hold can only be
confirmed with its token, of which the database keeps only a SHA-256.

**Failures:** if Supabase can't be reached the ChatBot says so — it never shows a
room count it didn't read, and never says "booked" unless the database said so.

### Intent and Jev

Intent (and which hotel is named) comes from Jev when it is configured and
answering, otherwise from the deterministic rules in `server/nlu/classify.js`;
every response says which (`source`). Booking details — dates, times, counts,
room type, contact details — are always extracted by rules
(`server/booking/extract.js`).

Jev is reachable two ways, and the key decides (override with `JEV_PROVIDER`):

| Key | Endpoint | Client |
|---|---|---|
| TypeSafe key | `https://api.typesafe.ai/v1/systemone`, `jev-1.13.0` — calibrated choice questions | `server/jev/client.js` |
| OpenRouter key (`sk-or-v1-…`) | `https://openrouter.ai/api/v1/chat/completions`, `typesafe/jev-router` | `server/jev/openrouter.js` |

**Currently configured: an OpenRouter key → Jev Router.** Jev Router picks an
underlying model per request (seen: OpenAI, DeepSeek, Z.ai GLM, Google Gemini),
so the guest's message is sent to OpenRouter and on to that provider. The adapter
sends the same option descriptions as the TypeSafe client, constrains every answer
to those options with a strict JSON schema, and `classify.js` validates it again —
a model can never introduce an intent or a hotel. Its confidence is the model's own
estimate, not a calibrated probability. Measured on 24 labelled guest messages:
Jev Router 23/24 intents right (the miss was a malformed reply, which falls back to
the rules), the rules alone 19/24; median 2.1 s, slowest 4 s, about $0.0002 a
message — hence `JEV_TIMEOUT_MS=7000`.

To keep bookings quick, a message in the middle of a booking ("2 PM", "20 Oct",
a guest's details) is read by the booking flow directly and never waits for Jev;
Jev is asked only about messages the flow does not recognise. Tapped options never
go to Jev. After an auth failure (bad key, empty balance) Jev is skipped for ten
minutes rather than retried on every message, and any other failure falls back to
the rules for that message.

### The dashboard

Staff sign in with Supabase Auth on the welcome screen, like guests. Only users whose
`app_metadata.hotel_role` is `admin` get the dashboard (everyone else gets the guest area); that field can only be written with
the service-role key, which is what `npm run admin:create -- email` does
(`-- email --revoke` removes it). A user must sign in again after their rights
change. The session lives in `sessionStorage`, so it ends with the tab, and every
guest detail is wiped from the page on sign-out.

| Page | What it does |
|---|---|
| Dashboard | Tonight: total / available / occupied rooms and occupancy rate, arrivals and departures, month-to-date room revenue; a status board for all ten rooms for tonight or any night you pick (a ChatBot booking turns its room to *Booked* as soon as it is confirmed); next-7-day arrivals and departures; 14-night occupancy chart; latest bookings. Updates live through Supabase Realtime (and refreshes every minute regardless). |
| Rooms | Availability check for any dates (the ChatBot's own calculation); one rate for all rooms of a type; per-room type, rate, capacity and bookable switch. Existing bookings keep their booked rate. |
| Reservations | Search (reference, guest, email, phone, room), filter by status, type and dates; a detail panel with check-in, check-out, no-show and cancel (with a reason). Status only moves forward. |
| Guests | Profiles with booking count, total spend, last and next stay, and full booking history. |
| Reports | Room revenue, room-nights sold, occupancy, ADR and RevPAR for any period up to a year, by night and by room type; CSV export and a table view. Computed in the database from actual reservations. |

### Guest accounts

Guests create an account on the welcome screen (full name, email, password,
password again) or sign in. The form checks the name, the email and the password
rules (8+ characters, upper- and lower-case, a number) before anything is sent;
Supabase Auth stores and checks the password. A sign-up for an address that
already has an account is told so and moved to sign-in. With **Confirm email** on
in the Supabase project (Authentication → Sign In / Providers → Email) a new
guest gets a verification link first, and can ask for it again from the sign-in
form; the link brings them back signed in. For that link to come back to the right
place, add the site's address (and `http://localhost:8792` for local work) under
Authentication → URL Configuration → Redirect URLs.

A signed-in guest lands on their own area, not the dashboard:

* **Room availability** for any dates: every room with its type, rate and status —
  *Available*, *Booked*, *Being booked* (a live hold) or *Not offered* — read from
  `room_board()`, so it is the same calculation the ChatBot and the database
  constraint use. Rooms the guest booked themselves are marked *Your booking*.
  Live: Realtime on `inventory_pulse`, plus a re-read the moment the ChatBot in the
  page holds, books or releases a room, plus once a minute.
* **My bookings**, from `my_bookings()`, with **Cancel booking** up to the day before
  check-in (`cancel_my_booking()`); the room is free again at once, everywhere.
* **Book this room** opens the ChatBot already asking for that type and those dates.

Asking questions and checking availability in the ChatBot need no account.
**Holding and confirming a room do**: a signed-out guest is shown *Sign in* and
*Create account*, the conversation keeps its place, and *Continue booking* carries
on once they are signed in. The page sends the session's access token with every
chat request; the server has Supabase Auth check it (`repo.getUser`, cached a
minute per token) and passes the verified user id to `confirm_booking`, which
stores it in `reservations.user_id`. `BOOKING_REQUIRES_SIGN_IN=false` turns the
requirement off (local testing only).

Room types look different everywhere a room is drawn — the guest board, the
dashboard's room board, the ChatBot's room list, chips and legends: Normal rooms
are ivory cards with a blue mark, Luxury rooms are midnight-and-champagne cards
with a ★. A booked room is hatched and labelled *Booked*, never just coloured.

### Security

| Who | Can |
|---|---|
| The public anon key | nothing — no table, view or function (`tests/db/schema.test.js` checks over HTTP) |
| A signed-in guest (non-admin) | no table rows (RLS) and no admin functions; `room_board` (statuses, no guest details), their own bookings through `my_bookings`, cancelling their own through `cancel_my_booking`, and reading `inventory_pulse` (a timestamp) |
| An admin | read the four tables; edit a room's type, rate, capacity, name and bookable flag (column-level grant); change a booking's status only through `admin_update_booking_status` |
| The server (service role) | the guest-facing booking functions |

Secrets live in `.env` locally (git-ignored) and in Netlify environment variables
in production. The page holds none: `GET /api/config` serves only the project URL
and the anon key — public by design — and refuses to serve anything that looks
like a service or secret key. The chat endpoint rejects non-POST, non-JSON and
bodies over 8 KB, rate-limits 30 requests a minute per address, validates every
action's shape, strips control and bidi characters, and never logs what the guest
typed. `netlify.toml` 404s `/.env*`, `/server/`, `/supabase/`, `/scripts/`,
`/tests/`, `/node_modules/`.

### Tests

```bash
npm test          # unit: extraction, state signing, the booking flow, routing, HTTP guards, Jev client
npm run test:db   # live Supabase: schema, seed, RLS, availability, holds, concurrency, admin, look-ups, end-to-end
npm run smoke     # pre-deploy checks on the page itself
```

`test:db` uses June 2027 dates and `@test.invalid` emails only, and deletes every
row it created when it finishes.

To add an intent, describe it in `server/intents/catalog.js` (Jev option text and
a keyword rule) and route it in `server/chat.js`.

## Adding to the knowledge base

Append to `misty_knowledge_qa.js`:

```js
{ q: "The question",
  a: "The answer. <strong>HTML allowed.</strong>",
  c: "category-id",          // must exist in MM_CATEGORIES
  t: "extra search tags",    // widens recall, does not affect ranking
  m: "mediaSetKey",          // optional, from MM_MEDIA.sets
  p: ["placeKey"] }          // optional, from MM_PLACES
```

Photographs come from the resort's own CDN. That CDN ignores `?width=` but
honours `?scale-down-to=`, which is the difference between a 44 KB thumbnail
and a 4.7 MB original — see the note above `var W` in `misty_knowledge_base.js`.

Map links are built from an encoded place-name query rather than pasted URLs,
which is what keeps them resolving to the right pin.

## The Home page

Above the fold: the greeting, then the estate in pictures — one large frame for
the accommodation and three tiles under it for dining, what there is to do and
what is nearby. Every frame is a button and asks its own question, so a
photograph leads into the conversation rather than only decorating the panel.
Pictures come from `MM_MEDIA` in `misty_knowledge_base.js`; the tile row removes
itself if that file is missing, because a caption over an empty box reads as a
bug.

Below it: **the most asked questions**, numbered — the ranking is the point of
the list, so it is drawn rather than implied — and then the estate at a glance.
The six questions are `UI[lang].starters`, sent exactly as written, which is the
same path a guest's own typing takes through `TERMS`.

## One guest at a time

Nothing is written to `localStorage`, `sessionStorage`, IndexedDB or a cookie,
so a transcript has never survived a reload and never leaves the tab. What the
page adds on top of that is the shared device — a lobby tablet, or a phone
passed across the desk. Closing the panel only hides it, so without this the
next person opens it onto someone else's questions.

The transcript is dropped once the panel has been left alone long enough that
whoever touches it next is probably not the last one. Three thresholds, because
the situations differ:

| Constant | Default | When |
|---|---|---|
| `IDLE_CLOSED_MS` | 90 s | closed, then opened again |
| `IDLE_OPEN_MS` | 5 min | open, but untouched |
| `IDLE_HIDDEN_MS` | 5 min | tab hidden — walked away, screen locked |

A guest who closes the panel and reopens it to check one more thing is still the
same guest, so the closed threshold is short in minutes but generous in seconds.

Two things stop it firing on someone who is still there. The timer refuses to
run while `busy` — an answer still rendering is the one moment the guest is
certainly present and certainly not touching anything — and scrolling the
transcript counts as presence, because reading a long answer means scrolling and
touching nothing else. The idle window starts when an answer *finishes*, not
when the question was asked. A wipe only happens when the guest actually said
something: resetting a panel that has shown nothing but the greeting achieves
nothing and would throw someone back to Home while they are still reading it.

## Before shipping

```bash
node smoke_test.js
```

28 checks, no network, exits non-zero on any failure so it can gate a
deploy. Beyond the dashboard's five pages, the pinned and integrity-checked
Supabase library, and a scan proving no key or connection string is in the
page or `hotel_admin.js`, it covers: the data files load and expose their globals; every dataset
(`UI`, `REPLY`, `MEDIA`, `PLACES`, `DATA`, `TERMS`) covers all four languages;
placeholders like `{CALL}` and `{n}` survived translation; no translated label
is still an English sentence; every picture set is non-empty, https and
caption-resolvable; every corpus entry points at a category, media set and
place that exist; every `data-i18n` key in the HTML exists in `UI.en`; the
inline bootstrap has not drifted from the pack; the elements the script wires
up are still there; the data files are still linked in order after the
bootstrap; no stray `console.log`; no unbalanced markup in any answer; that no
storage API is used anywhere (comments stripped first, since the page explains
why it stores nothing); and that the shared-device wipe is still wired, still
refuses to fire mid-answer, and has not been left on test-length thresholds.

It will not catch layout, whether the photograph CDN is reachable, or whether a
translation reads well. Those need eyes.
