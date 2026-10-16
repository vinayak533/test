/* ============================================================================
   server/intents/catalog.js — the intents the backend knows about.

   Each entry gives Jev the option description it chooses against, and the
   keyword rule the deterministic classifier uses when Jev is unavailable.
   The rules are tried in this order and the first match wins, so the more
   specific requests come first.

   server/chat.js decides what each intent does. Intents it does not answer
   itself (cancellation policy, room service, everything general) go back to
   the page's own knowledge base.
   ============================================================================ */

"use strict";

// Things a guest "books" that are not a room.
const NOT_A_ROOM = "(?:table|tour|campfire|barbecue|bbq|jeep|safari|cab|taxi|car|spa|massage|treatment|trek|hike|activity|activities|class|session|meal|dinner|lunch|breakfast)";

const INTENTS = [
  {
    name: "list_hotels",
    jev: "asks which hotels or properties are available, where they can stay, or which hotels this chatbot or platform supports",
    rule: new RegExp([
      "\\b(?:which|what|other|another|any other|list(?: of)?|how many|all(?: the)?)\\s+(?:hotels?|propert(?:y|ies)|resorts?|places to stay)\\b",
      "\\bwhere (?:can|could|should|do) (?:i|we) stay\\b",
      "\\bhotels? (?:do|does|can) (?:you|this|the) (?:bot |chatbot |platform |site )?(?:support|cover|have|offer|book)",
      "\\b(?:do|does) (?:you|this|the (?:bot|chatbot|platform|site)) (?:support|cover|work with|book) (?:any |other |more )?(?:hotels?|propert(?:y|ies))",
      "\\bavailable hotels?\\b",
      "\\bhotels? (?:are )?available\\b"
    ].join("|"))
  },
  {
    name: "cancel_reservation",
    jev: "wants to cancel or change an existing booking, or asks about the cancellation or refund policy",
    rule: /\b(?:cancel\w*|refund\w*|change (?:my|the) (?:booking|reservation|dates))\b/
  },
  {
    name: "guest_details",
    jev: "asks about their own existing booking, such as looking it up with a booking reference, or checking its details or status",
    rule: /\b(?:my (?:booking|reservation)(?! (?:a|for|of))|booking (?:ref\w*|number|id|details|status)|check (?:on )?(?:my|a|an existing) (?:booking|reservation)|look ?up (?:my |a )?(?:booking|reservation)|existing (?:booking|reservation)|mm-[a-z0-9]{6})\b/
  },
  {
    name: "check_room_availability",
    jev: "asks whether rooms are free, vacant or available, how many rooms are available, or whether the hotel is full or booked up, for some night or dates",
    rule: /\b(?:availab\w*|vacan\w*|fully booked|booked (?:up|out)|sold out|any rooms?|rooms? (?:free|left|open|spare)|free rooms?|have (?:a |any )?(?:room|rooms)\b|get a room|room for (?:tonight|tomorrow|the night)|how many rooms (?:are|do you have) (?:free|left|open|available))/
  },
  {
    name: "make_reservation",
    jev: "wants to book or reserve a room or a stay, or asks how to make a room booking",
    rule: new RegExp([
      `\\b(?:book|reserve)\\s+(?:me\\s+|us\\s+)?(?:a\\s+|an\\s+|the\\s+|one\\s+|two\\s+|three\\s+|\\d+\\s+)?(?:(?:normal|luxury|standard|deluxe|double|single|twin|family)\\s+)?(?:rooms?|stay|accommodation|nights?)\\b`,
      `\\bi(?:'d| would)? (?:like|want|wish) to (?:book|reserve|make a (?:booking|reservation))\\b(?!\\s+(?:a|an|the)?\\s*${NOT_A_ROOM})`,
      `\\bmake a (?:room )?(?:booking|reservation)\\b`,
      `\\b(?:how|where) (?:do|can) (?:i|we) (?:book|reserve)\\b(?!\\s+(?:a|an|the)?\\s*${NOT_A_ROOM})`,
      `\\b(?:can|could|may) (?:i|we) (?:book|reserve)\\b(?!\\s+(?:a|an|the)?\\s*${NOT_A_ROOM})`,
      `\\b(?:room )?booking for\\b`,
      `\\bbook (?:me|us) in\\b`,
      `^\\s*(?:book(?:ing)?|reserve|reservation)\\s*[.!?]?\\s*$`
    ].join("|"))
  },
  {
    // The rooms themselves — how many, which types, what they cost. Answered
    // from the rooms table, so the count and rates are always the live ones.
    name: "room_info",
    jev: "asks about the rooms themselves: how many rooms the hotel has in total, which room types there are, what the rooms are like, or how much a room costs, without asking about free dates",
    rule: new RegExp([
      "\\bhow many (?:rooms|bedrooms)\\b(?! (?:are |is )?(?:there )?(?:free|left|open|available|vacant))",
      "\\b(?:tell me |talk |info\\w* |details )?about (?:the |your )?rooms\\b",
      "\\bwhat (?:kinds?|types?|sorts?) of rooms?\\b",
      "\\b(?:room types?|types? of rooms?|room categor\\w+)\\b",
      "\\b(?:what|which) rooms (?:do you have|are there|does (?:the hotel|it) have)\\b",
      "\\b(?:luxury|normal) (?:vs\\.?|versus|or) (?:luxury|normal)\\b",
      "\\bdifference between (?:the )?(?:rooms|luxury|normal)\\b",
      "\\broom (?:rates?|prices?|tariffs?|charges?)\\b",
      "\\b(?:price|cost|rate|tariff) (?:of|for) (?:a |the )?(?:normal |luxury )?rooms?\\b",
      "\\bhow much (?:is|does|for) (?:a |the )?(?:normal |luxury )?room\\b"
    ].join("|"))
  },
  {
    name: "room_service",
    jev: "is a current guest asking for something in their room: food delivered, towels, housekeeping, repairs",
    rule: /\b(?:room service|housekeeping|(?:extra|more|fresh) (?:towels?|pillows?|blankets?)|send (?:up|to my room))\b/
  },
  {
    name: "general_question",
    jev: "anything else: greetings, amenities, food, activities, directions, photos, policies, or questions unrelated to the hotel",
    rule: null
  }
];

const BY_NAME = new Map(INTENTS.map(i => [i.name, i]));

module.exports = { INTENTS, BY_NAME };
