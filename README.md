# Kuttikkanam Hotel Agency — agency dashboard and booking ChatBot

A hotel management agency platform, backed by Supabase, for three client
hotels in Kuttikkanam, Kerala — **Misty Mountain**, **Royal Hotel** and **Taj
Hotel**, ten rooms each, each with its own inventory, prices and bookings.
Receptionists take phone enquiries with the **Desk assistant** (say or type what
the caller wants, read live availability and prices, book on request), guests
check availability and book through the ChatBot, and staff run the front desk
from the dashboard. Royal Hotel and Taj Hotel, switched off by
`007_misty_mountain_only.sql`, are live again from `008_three_hotels.sql`.

The agency is the parent organisation (`agencies`) and every hotel is one of
its clients (`hotels.agency_id`). Rooms, guests and reservations were already
keyed by `hotel_id`; who may see which hotel is decided in the database
(`staff_hotel_ids()`), so adding a fourth client is a seed file, not a rebuild.

## Files

| File | What it is |
|---|---|
| `index.html` | The welcome screen with sign-in / sign-up, the guest area, the dashboard markup and the ChatBot. |
| `hotel_admin.js` / `hotel_admin.css` | Supabase Auth sign-in and sign-up for everyone, then the staff dashboard: live data, edits, reports. The stylesheet covers the guest area too. |
| `hotel_guest.js` | The signed-in guest's area: live room board for any dates, their own bookings, cancelling. |
| `hotel_desk.js` / `hotel_desk.css` | The Desk assistant page of the staff dashboard, for receptionists on the phone (see "The Desk assistant"). |
| `server/` | The backend for `POST /api/chat`, `GET /api/config` and `GET /api/hotels` (see below). |
| `netlify/functions/` | Thin adapters from Netlify Functions to `server/app.js`. |
| `supabase/migrations/` | Schema, seed, booking functions, security. Idempotent; run in order. |
| `scripts/` | `migrate.js`, `create_admin.js`, `inspect_schema.js`, `dev_server.js`, `setup_whisper.js`. |
| `server/stt/` | English speech to text for the ChatBot's microphone (see "Voice input"). |
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
npm run admin:create -- you@example.com   # once: an agency administrator login (prints a temporary password)
npm run admin:create -- desk@example.com --hotel royal_kuttikkanam   # optional: a manager for one hotel only
npm run whisper:setup       # once: the English voice model, inside this folder (see "Voice input")
npm run serve               # http://localhost:8792 — page, /api/chat, /api/config, /api/hotels, /api/transcribe
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
| `001_schema.sql` | `agencies` (with the agency's own row), `hotels` (each with `agency_id`), `hotel_staff`, `rooms`, `guests`, `reservations`, constraints, indexes. Upgrades the earlier prototype tables in place (removing only their demo rows, by exact key) and stops rather than delete anything else. Existing hotels are attached to the agency when `agency_id` is first added. |
| `002_seed_misty_mountain.sql` | Misty Mountain and its rooms 1–10. Upserts on natural keys, so re-running never duplicates; rates, types and capacity are written only when a room is first created, so dashboard edits survive a re-run. |
| `003_booking_functions.sql` | `get_availability`, `hold_rooms`, `confirm_booking`, `release_hold`, `find_booking`; the staff checks `staff_hotel_ids()` and `can_manage_hotel()`; the dashboard functions `admin_availability`, `admin_update_booking_status`, `admin_report`, and `agency_overview` (every client's figures in one call). |
| `004_security.sql` | RLS scoped to the hotels each user may manage, grants (including a hotel's editable contact details), the `guest_summaries` view, Realtime publication. |
| `005_guest_accounts.sql` | Guest accounts: `room_board`, `my_bookings`, `cancel_my_booking`, and `inventory_pulse` (the change signal the guest area listens to). `reservations.user_id` (in `001`) links a booking to the account that made it. |
| `006_seed_kuttikkanam_hotels.sql` | Royal Hotel (`royal_kuttikkanam`) and Taj Hotel (`taj_kuttikkanam`), rooms 1–10 each. Same re-run rules as `002`. Contact details are left empty for the admin to fill in. |
| `007_misty_mountain_only.sql` | Switched Royal Hotel and Taj Hotel off (`is_active = false`), rooms and history kept. Superseded by 008. |
| `008_three_hotels.sql` | Switches Royal Hotel and Taj Hotel back on, so all three client hotels are live. It runs after 007 on every migrate, so the end state is always all three. |

Seeded inventory, ten rooms per hotel, each sleeping up to 3:

| Hotel | Normal | Luxury |
|---|---|---|
| Misty Mountain | rooms 1–6, ₹2,500 | rooms 7–10, ₹4,500 |
| Royal Hotel | rooms 1–6, ₹3,000 | rooms 7–10, ₹5,500 |
| Taj Hotel | rooms 1–5, ₹4,000 | rooms 6–10, ₹7,500 |

Policy at all three: check-in from 14:00, check-out by 12:00. Money is `numeric`,
always INR. Every room, guest profile and reservation carries its `hotel_id`; the
double-booking constraint is per room, so a booking at one hotel can never affect
another's availability. Booking references (`MM-XXXXXX`) are unique across all
hotels.

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
support" is answered from the `hotels` table, with a "Book at …" button for each.
A hotel that is not in the table is never invented. Which hotel a turn is about:

1. a booking in progress stays at its own hotel;
2. a hotel named in the message ("rooms at Royal Hotel?") — mid-booking this is
   offered as a switch, never done silently;
3. the hotel chosen in the panel's picker (sent as `hotelId`);
4. the site's own hotel, `DEFAULT_HOTEL_ID` (Misty Mountain).

Every reply carries `hotel: { id, name }` and the page's pickers follow it.
Changing hotel on the page mid-conversation sends a `switch` action, which stops
the booking there and releases its hold at once. The page's knowledge base
describes Misty Mountain only, so for Royal Hotel and Taj Hotel anything outside
rooms, rates, availability, bookings and look-ups gets a plain "I don't have other
details about … yet" rather than Misty Mountain's answer. `GET /api/hotels` lists
the active hotels (ids, names, towns — nothing private) for the pickers.

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

Staff sign in with Supabase Auth on the welcome screen, like guests. Two kinds
of staff, both set only with the service-role key by `npm run admin:create`;
everyone else gets the guest area:

| Who | How | Sees |
|---|---|---|
| Agency administrator | `admin:create -- email` → `app_metadata.hotel_role = "admin"` | The agency overview and every client hotel |
| Hotel manager | `admin:create -- email --hotel <hotel id>` → a row in `hotel_staff` and `hotel_role = "manager"` | Their hotel(s) only. No agency overview, no picker unless they manage more than one |

`--revoke` removes either (`--hotel <id> --revoke` removes one hotel). A change
of role needs a fresh sign-in; taking a hotel away from a manager takes effect
on their next request, because the database reads `hotel_staff` every time. The
session lives in `sessionStorage`, so it ends with the tab, and every guest
detail is wiped from the page on sign-out.

| Page | What it does |
|---|---|
| Agency → Overview | Administrators only; where they land. Agency-wide total rooms, occupied / available / held tonight, occupancy, arrivals today, check-ins in the next 7 days, upcoming bookings and this month's room revenue; a card per client with its own figures and quick links (Open dashboard, Reservations, Rooms, Reports); and the clients compared in one table. All from `agency_overview()`, computed in the database from the rooms and reservations with the same rules as the hotel dashboard. Live: Realtime on `inventory_pulse` (any client's change), plus once a minute. |
| Client hotel | The sidebar's picker chooses which hotel every Front desk page is about (the active hotels this account may manage — the database returns no others). Switching re-reads everything for that hotel and re-subscribes Realtime to it; the choice is kept for the tab. |
| Desk assistant | Where a hotel manager (the front desk) lands. See "The Desk assistant" below. |
| Dashboard | Tonight: total / available / occupied rooms and occupancy rate, arrivals and departures, month-to-date room revenue; a status board for all ten rooms for tonight or any night you pick (a ChatBot booking turns its room to *Booked* as soon as it is confirmed); next-7-day arrivals and departures; 14-night occupancy chart; latest bookings. Updates live through Supabase Realtime (and refreshes every minute regardless). |
| Rooms | Availability check for any dates (the ChatBot's own calculation); one rate for all rooms of a type; per-room type, rate, capacity and bookable switch. Existing bookings keep their booked rate. |
| Reservations | Search (reference, guest, email, phone, room), filter by status, type and dates; a detail panel with check-in, check-out, no-show and cancel (with a reason). Status only moves forward. |
| Guests | Profiles with booking count, total spend, last and next stay, and full booking history. |
| Hotel profile | The hotel's phone, email, address and description — what the ChatBot gives guests for that hotel (it says "call the hotel on …" once a phone is set) — editable; and its configuration (agency, id, rooms, check-in/out, hold time, longest stay), read-only because the booking rules depend on it. The name stays with the seed, because the ChatBot matches guests' words to it. |
| Reports | Room revenue, room-nights sold, occupancy, ADR and RevPAR for any period up to a year, by night and by room type; CSV export and a table view. Computed in the database from actual reservations. |

### The Desk assistant

The staff dashboard's first page, for a receptionist on the phone with a
caller. They type or speak what the caller wants and read the answer off the
screen; nothing is spoken to the caller and nothing is sent or booked on its
own. It works on the selected **Client hotel** only — changing hotel ends the
call on screen and gives back any room it was holding.

```
"Check luxury rooms for three adults from today for two nights"
  → check-in today, check-out in 2 nights, 3 adults, Luxury, 1 room (from the party)
  → live availability from Supabase: matching rooms, prices, the stay total,
    and a strip of every room for those nights (matches / free / booked)
  → tick rooms → Book (a 15-minute hold) → caller's name, mobile, email,
    optional arrival time → summary → Confirm booking → MM-XXXXXX to read out
```

It is `POST /api/chat` with `mode: "desk"` (`handleDesk` in `server/chat.js`),
running the same booking flow, extraction rules, Supabase functions and
double-booking protection as the ChatBot. What differs:

* **Who:** a signed-in staff account that manages that hotel (every hotel for an
  agency administrator, its `hotel_staff` rows for a manager), checked on every
  turn with the service-role key. Anyone else gets `desk_forbidden` before
  anything is read.
* **Only what is missing is asked.** A check-in date is the one thing
  availability can't be shown without. One night is assumed (and shown as
  *assumed*) until a stay length is given; rooms follow from the party (shown
  as *suggested*); no party shows every free room; the arrival time is never
  asked (it is an optional field on the form). The party is asked only when
  rooms are booked before it is known.
* **Details add up across messages,** typed or spoken: "today", then "for 4
  adults and 1 child", then "make it 3 nights", then "luxury only" is one
  request. Each reply carries `request` — what has been understood — drawn as
  chips above the results; the main ones clear with one tap.
* **Nothing matches:** it says what there is (by type), offers the other type,
  and looks a day or two either side for the same stay that would fit.
* **Rates** ("What is the price of a luxury room?") come from the rooms table,
  and a search in progress is kept.
* **Booking:** only the *Confirm booking* button books; a typed or spoken "yes"
  never does. The booking is not linked to the receptionist's account
  (`user_id` stays empty) and is labelled `source = 'admin'` — *Front desk* on
  the Reservations page.
* **Never across hotels:** a conversation from another hotel is closed and its
  hold released; naming another hotel only says to switch in the menu; no
  action can move the desk to another hotel.
* **No Jev, no knowledge base:** intent comes from the deterministic rules
  only (no round trip while a caller waits); anything that is not rooms, rates,
  availability or a booking gets a short pointer. An existing booking is
  opened with the dashboard's own Reservations search.

**Voice:** the microphone puts the receptionist's words into the text box —
Whisper on this server where `/api/transcribe` runs, the browser's recognition
otherwise — after anything already typed. The full transcript wraps in the box
to be read and corrected, and goes nowhere until **Check** (or Enter) is
pressed. Tap to start and stop, or hold while speaking; Escape cancels.
Progress ("Understanding the request → Checking live availability → Matching
rooms to the request") is shown as the server reaches each step.

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
| A signed-in guest (no staff role) | no table rows (RLS) and no admin functions; `room_board` (statuses, no guest details), their own bookings through `my_bookings`, cancelling their own through `cancel_my_booking`, and reading `inventory_pulse` (a timestamp) |
| Staff (agency administrator or hotel manager) | for the hotels in `staff_hotel_ids()` only: read the four tables; edit a room's type, rate, capacity, name and bookable flag and the hotel's contact details (column-level grants); change a booking's status only through `admin_update_booking_status`; `admin_report`, `admin_availability`, `agency_overview` |
| The server (service role) | the guest-facing booking functions |

Every policy and staff function checks `staff_hotel_ids()`, so the isolation
holds for any request, not just the page's: a Royal Hotel manager asking the
database directly for Misty Mountain's rooms, guests or bookings gets none, a
report for another hotel is `forbidden`, another hotel's booking reference reads
as `not_found`, and an update to another hotel's room touches nothing
(`tests/db/agency.test.js`).

Secrets live in `.env` locally (git-ignored) and in Netlify environment variables
in production. The page holds none: `GET /api/config` serves only the project URL
and the anon key — public by design — and refuses to serve anything that looks
like a service or secret key. The chat endpoint rejects non-POST, non-JSON and
bodies over 8 KB, rate-limits 30 requests a minute per address, validates every
action's shape, strips control and bidi characters, and never logs what the guest
typed. `netlify.toml` 404s `/.env*`, `/server/`, `/supabase/`, `/scripts/`,
`/tests/`, `/node_modules/`, `/models/`, `/vendor/`.

### Tests

```bash
npm test          # unit: extraction, state signing, the booking flow, the Desk assistant, routing, HTTP guards, Jev client
npm run test:db   # live Supabase: schema, seed, RLS, availability, holds, concurrency, admin, look-ups, end-to-end,
                  # the agency overview, hotel managers kept to their own hotel, the Desk assistant over HTTP
npm run smoke     # pre-deploy checks on the page itself
npm run test:stt  # the real Whisper model: loads once, non-speech comes back empty, bursts are refused
```

`test:db` uses June 2027 dates and `@test.invalid` emails only, and deletes every
row it created when it finishes.

To add an intent, describe it in `server/intents/catalog.js` (Jev option text and
a keyword rule) and route it in `server/chat.js`.

## Voice input

The microphone in the ChatBot's composer turns speech into text in the
question field. The guest reads it, corrects it if needed and presses send
themselves; it then goes through `POST /api/chat` exactly like typing, so voice
cannot skip the hotel choice, availability look-ups, date checks, guest
details or booking confirmation.

**English** is transcribed on this server by [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
with **`models/ggml-small.en-q5_0.bin`**, Whisper *small*, English-only, 5-bit
quantised. **Malayalam, Hindi and Tamil** use the browser's own speech
recognition, as before, because that model only knows English. English falls
back to the browser too wherever `/api/transcribe` is not served.

### Setting it up

```bash
npm run whisper:setup     # once per machine; safe to re-run, downloads nothing if present
npm run serve             # loads the model at start-up and serves /api/transcribe
```

Everything is stored inside this folder, and all of it is git-ignored:

| Path | What it is |
|---|---|
| `models/ggml-small.en-q5_0.bin` | The Whisper model, 175 MB. |
| `models/ggml-silero-v6.2.0.bin` | Silero voice-activity detection, 1 MB. Without it Whisper invents words for silence or background noise ("you", "I'll be waiting for you", or even its own prompt). |
| `vendor/whisper.cpp/bin/` | `whisper-server` and `whisper-quantize`, release `b5454`. |

whisper.cpp publishes `small.en` as f16, `q5_1` and `q8_0`, but not as `q5_0`.
So the setup script downloads the official f16 file from the whisper.cpp model
repository, checks its SHA-256, quantises it with whisper.cpp's own
`whisper-quantize`, checks the result's SHA-256 (quantising is deterministic)
and deletes the f16 file. On Windows x64 it downloads the pinned CPU release
build, also checked by SHA-256. On Linux and macOS it builds the same release
from source, which needs CMake and a C++ compiler; that path has not been run
yet. Partial downloads go to `models/_download/` and `vendor/whisper.cpp/_download/`
and are removed once used. Nothing is written to the home folder, a global
cache or a system model directory: the app loads the model by a path relative
to `server/stt/whisper.js`, and whisper.cpp keeps no cache of its own. Delete
the project folder and the model goes with it.

### How it runs

* The page records with `MediaRecorder`, decodes and resamples to 16 kHz mono
  in the browser (`OfflineAudioContext`), and posts a WAV of at most 30 s. A
  recording with nothing above -40 dBFS is not sent at all.
* `server/stt/whisper.js` starts one `whisper-server` beside Node, on
  `127.0.0.1` and a free port. It loads the model once (about 1 s) and keeps it
  in memory (about 360 MB resident). Requests go to it one at a time. Up to
  four may wait; any more get `503 stt_busy`. If the process dies, it is
  restarted on the next request.
* Whisper always encodes a 30 s window. Each request asks it to encode only
  the length of the clip plus a second (`audio_ctx`), which gives the same
  words several times faster. Measured on a 12-thread laptop CPU with 8
  threads: a 4 s question took 1.1 s (6.4 s without it), a 6 s booking request
  1.4 s, and a 20 s enquiry 4.3 s.
* `/api/transcribe` accepts only 16 kHz mono 16-bit WAV of 0.3–30 s, at most
  12 a minute per address. It stores neither the audio nor the text, and logs
  only lengths and timings.
* `WHISPER=off` turns it off. `WHISPER_THREADS` and `WHISPER_PROMPT` override
  the thread count and the spelling hint, which names the three hotels and
  Kuttikkanam.

### On Netlify

Netlify Functions cannot hold a 175 MB model or a long-lived process, so there
is no `/api/transcribe` there. The deployed page asks for it, gets a 404 and
keeps using the browser's recognition. To use Whisper in production, run
`scripts/dev_server.js` (or the same `server/app.js` handlers) on a host with
a long-lived Node process, at least about 1 GB of free memory and a few CPU
cores. `netlify.toml` returns a hard 404 for `/models/*` and `/vendor/*` in
case a local `netlify deploy` ever uploads them.

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
deploy. Beyond the dashboard's pages (the agency overview and six hotel pages,
with the agency-only links starting hidden), the pinned and integrity-checked
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
