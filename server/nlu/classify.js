/* ============================================================================
   server/nlu/classify.js — intent and hotel, from Jev or from rules.

   classify() always returns the same shape, whichever source answered:

     { source: "jev" | "rules",
       intent: { name, confidence },
       hotel:  { kind: "known" | "none" | "other", id, confidence } }

   Jev's answers are validated before use: the choice must be one of the
   options sent, the confidence a number in [0, 1], and a hotel id must be one
   of the active hotels read from Supabase. Anything else is treated as a Jev
   failure, never passed through.
   ============================================================================ */

"use strict";

const { INTENTS, BY_NAME } = require("../intents/catalog");
const { JevError } = require("../jev/client");

const NO_HOTEL = "none";
const OTHER_HOTEL = "other_hotel";

/* ---- Jev ----------------------------------------------------------------- */

function buildQuestions(hotels){
  const hotelOptions = {};
  for (const h of hotels){
    const names = [h.name, ...(h.aliases || [])].filter(Boolean);
    hotelOptions[h.id] = "the guest names " + names.join(" / ");
  }
  hotelOptions[NO_HOTEL] = "the guest does not name any hotel or property (\"you\", \"your hotel\", \"here\" count as no name)";
  hotelOptions[OTHER_HOTEL] = "the guest names a hotel or property that is not one of the others listed";

  return {
    intent: {
      type: "choice",
      instructions: "Which request is the guest making to a hotel's website concierge chatbot?",
      criteria: Object.fromEntries(INTENTS.map(i => [i.name, i.jev]))
    },
    hotel: {
      type: "choice",
      instructions: "Which hotel does the guest's message name?",
      criteria: hotelOptions
    }
  };
}

function readChoice(answer, options, name){
  if (!answer || typeof answer !== "object") throw new JevError("bad_response", `Jev left "${name}" unanswered`);
  const choice = String(answer.choice ?? "");
  if (!options.includes(choice)) throw new JevError("bad_response", `Jev chose "${choice.slice(0, 40)}" for "${name}", which is not an option`);
  let confidence = Number(answer.confidence ?? (answer.probabilities && answer.probabilities[choice]));
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1){
    throw new JevError("bad_response", `Jev gave no usable confidence for "${name}"`);
  }
  return { choice, confidence };
}

async function classifyWithJev(message, hotels, jev){
  const questions = buildQuestions(hotels);
  const answers = await jev.ask({ channel: "hotel website concierge chat", guest_message: message }, questions);

  const intent = readChoice(answers.intent, Object.keys(questions.intent.criteria), "intent");
  const hotel  = readChoice(answers.hotel, Object.keys(questions.hotel.criteria), "hotel");

  return {
    source: "jev",
    intent: { name: intent.choice, confidence: intent.confidence },
    hotel: hotel.choice === NO_HOTEL    ? { kind: "none",  id: null, confidence: hotel.confidence }
         : hotel.choice === OTHER_HOTEL ? { kind: "other", id: null, confidence: hotel.confidence }
         :                                { kind: "known", id: hotel.choice, confidence: hotel.confidence }
  };
}

/* ---- deterministic fallback ---------------------------------------------- */

// Words that sit next to "hotel"/"resort" without naming one.
const NOT_A_NAME = new Set(("the a an any your you this that our my their his her its which what one good nice cheap " +
  "best in at for of to near by from with and or any other another same is are was do does have has " +
  "tonight today tomorrow rooms room available availability booked full open free stay staying " +
  "luxury boutique mountain hill plantation estate nearby local cheaper budget").split(" "));
// "...the resort's restaurant", "resort fully booked": a following verb or
// adverb, not a name.
const NOT_A_NAME_TAIL = /^(?:'s|s|ly)$|ly$/;
// Two separate passes: as one alternation, "at hotel" would consume "hotel"
// and "hotel blue" would never be seen.
const PLACE_WORD = "(?:hotel|resort|inn|lodge|homestay|villa|retreat)";
const NAME_AFTER  = new RegExp(`\\b${PLACE_WORD}\\s+([a-z][a-z'-]+)`, "g");
const NAME_BEFORE = new RegExp(`\\b([a-z][a-z'-]+)\\s+(?=${PLACE_WORD}\\b)`, "g");

function classifyWithRules(message, hotels){
  const s = message.toLowerCase();

  let intent = { name: "general_question", confidence: 0.5 };
  for (const i of INTENTS){
    if (i.rule && i.rule.test(s)){ intent = { name: i.name, confidence: 0.9 }; break; }
  }

  let hotel = { kind: "none", id: null, confidence: 0.8 };
  const known = hotels.find(h => [h.name, ...(h.aliases || [])].some(a => a && s.includes(a.toLowerCase())));
  if (known){
    hotel = { kind: "known", id: known.id, confidence: 0.95 };
  } else {
    const words = [...s.matchAll(NAME_AFTER), ...s.matchAll(NAME_BEFORE)].map(m => m[1]);
    if (words.some(w => !NOT_A_NAME.has(w) && !NOT_A_NAME_TAIL.test(w))){
      hotel = { kind: "other", id: null, confidence: 0.85 };
    }
  }
  return { source: "rules", intent, hotel };
}

/* ---- entry point --------------------------------------------------------- */

/* A rejected key will be rejected again on the next message, so after an
   auth failure Jev is skipped for a while instead of costing every turn a
   round trip. Other failures (timeouts, overload) are retried normally. */
const AUTH_BACKOFF_MS = 10 * 60 * 1000;
const skipUntil = new WeakMap();                  // per Jev client
function resetJevBackoff(jev){ skipUntil.delete(jev); }

async function classify(message, hotels, { jev, fallback = "rules", log, now = Date.now } = {}){
  if (jev && now() >= (skipUntil.get(jev) || 0)){
    const started = Date.now();
    try {
      const out = await classifyWithJev(message, hotels, jev);
      log && log.info("nlu.classified", { source: "jev", ms: Date.now() - started, intent: out.intent, hotel: out.hotel });
      return out;
    } catch (e){
      if (!(e instanceof JevError)) throw e;
      if (e.kind === "auth") skipUntil.set(jev, now() + AUTH_BACKOFF_MS);
      log && log.warn("nlu.jev_failed", { kind: e.kind, status: e.status, message: e.message, ms: Date.now() - started, skipping: e.kind === "auth" });
      if (fallback !== "rules") throw e;
    }
  } else if (fallback !== "rules"){
    throw new JevError("auth", "Jev is not configured and the rules fallback is off");
  }
  const out = classifyWithRules(message, hotels);
  log && log.info("nlu.classified", { source: "rules", intent: out.intent, hotel: out.hotel });
  return out;
}

module.exports = { classify, classifyWithRules, classifyWithJev, buildQuestions, resetJevBackoff, BY_NAME };
