# Misty Mountain — ChatBot

A prototype landing page for Misty Mountain Plantation Resort with an embedded
concierge assistant (the ChatBot).

## Files

| File | What it is |
|---|---|
| `index.html` | The page and the assistant. Self-contained apart from the data files below. |
| `misty_i18n.js` | The language pack: English, Malayalam, Hindi and Tamil. |
| `sync_i18n_inline.js` | Copies `LANGS` and `UI` from the pack into the HTML. Run it after editing either. |
| `smoke_test.js` | Pre-deploy checks. Run it before shipping. |
| `misty_knowledge_base.js` | The verified photo library, the nearby-places data and the Google Maps URL builders. |
| `misty_knowledge_qa.js` | 1,000 question-and-answer pairs. |
| `misty_mountain_details.md` / `.json` | The source research the answers are grounded in. |

## Running it

The three data files are loaded as classic `<script src>` tags, so they must sit
in the same folder as the HTML. Serve the folder over HTTP:

```bash
python -m http.server 8777
```

Then open <http://localhost:8777/>.

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

24 checks, no network, exits non-zero on the first failure so it can gate a
deploy. It covers: the data files load and expose their globals; every dataset
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
