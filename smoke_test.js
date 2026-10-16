/* ============================================================================
   smoke_test.js — pre-deploy checks for the Misty Mountain ChatBot.

       node smoke_test.js

   Exits 0 when everything passes and 1 on any failure, so it can gate a
   deploy. Nothing here touches the network: it loads the three data files
   the way the browser does and reads the HTML as text.

   What it will not catch: layout, whether a photograph CDN is reachable, and
   whether a translation reads well. Those need eyes. Everything structural —
   a missing key, a dropped placeholder, a picture set pointing at nothing, a
   bootstrap that has drifted from the pack — is caught here.
   ============================================================================ */

const fs = require("fs");

let pass = 0;
const fails = [];

function check(name, fn){
  let problems;
  try { problems = fn() || []; }
  catch (e){ problems = ["threw: " + e.message]; }
  if (problems.length){
    fails.push(name);
    console.log("FAIL  " + name);
    problems.slice(0, 8).forEach(p => console.log("        " + p));
    if (problems.length > 8) console.log("        ...and " + (problems.length - 8) + " more");
  } else {
    pass++;
    console.log("ok    " + name);
  }
}

/* ---- load everything the way the page does ------------------------------ */

global.window = {};
require("./misty_i18n.js");
require("./misty_knowledge_base.js");
require("./misty_knowledge_qa.js");

const I18N   = global.window.MM_I18N;
const MEDIA  = global.window.MM_MEDIA;
const PLACES = global.window.MM_PLACES;
const QA     = global.window.MM_QA;
const CATS   = global.window.MM_CATEGORIES;
const HTML   = fs.readFileSync("index.html", "utf8");

const CODES = I18N.LANGS.map(l => l.code);
const OTHER = CODES.filter(c => c !== "en");

console.log("Misty Mountain — smoke test\n");

/* ---- 1. the data files load and are the shape the page expects ---------- */

check("data files expose their globals", () => {
  const missing = [];
  if (!I18N)   missing.push("MM_I18N");
  if (!MEDIA)  missing.push("MM_MEDIA");
  if (!PLACES) missing.push("MM_PLACES");
  if (!QA)     missing.push("MM_QA");
  if (!CATS)   missing.push("MM_CATEGORIES");
  return missing.map(m => m + " is not defined");
});

check("four languages, English first", () => {
  const p = [];
  if (CODES.length !== 4) p.push("expected 4 languages, found " + CODES.length);
  if (CODES[0] !== "en")  p.push("English must be first, found " + CODES[0]);
  ["ml", "hi", "ta"].forEach(c => { if (!CODES.includes(c)) p.push("missing " + c); });
  I18N.LANGS.forEach(l => {
    if (!l.native) p.push(l.code + " has no native name for the dropdown");
  });
  return p;
});

/* ---- 2. every dataset covers every language ----------------------------- */

function coverage(label, byLang, keys, langs){
  return langs.flatMap(l => {
    const pack = byLang && byLang[l];
    if (!pack) return [label + "." + l + " is missing entirely"];
    return keys.filter(k => pack[k] === undefined || pack[k] === "")
               .map(k => label + "." + l + " missing " + k);
  });
}

check("UI: every English key exists in every language", () =>
  coverage("UI", I18N.UI, Object.keys(I18N.UI.en), OTHER));

check("REPLY: every intent in the page has an answer in every language", () => {
  const ids = [...HTML.matchAll(/\bid:\s*"([a-zA-Z0-9_.-]+)"/g)].map(m => m[1]);
  if (!ids.length) return ["found no intent ids in the HTML — the pattern has moved"];
  return coverage("REPLY", I18N.REPLY, ids, OTHER);
});

check("MEDIA: every photograph has a caption in every language", () =>
  coverage("MEDIA", I18N.MEDIA, Object.keys(MEDIA.pics || {}), OTHER));

check("PLACES: every nearby place is translated in every language", () => {
  const keys = Object.keys(PLACES || {});
  const p = [];
  for (const l of OTHER){
    const pack = I18N.PLACES && I18N.PLACES[l];
    if (!pack){ p.push("PLACES." + l + " is missing entirely"); continue; }
    for (const k of keys){
      const tr = pack[k];
      if (!tr){ p.push("PLACES." + l + " missing " + k); continue; }
      for (const f of ["name", "dist", "what", "detail"]){
        if (PLACES[k][f] && !tr[f]) p.push("PLACES." + l + "." + k + " missing " + f);
      }
      // q and url drive the map pin: a translation must never override them
      if (tr.q || tr.url) p.push("PLACES." + l + "." + k + " overrides q/url, the map pin would move");
    }
  }
  return p;
});

check("DATA: localised estate prose present for every non-English language", () =>
  OTHER.filter(l => !I18N.DATA || !I18N.DATA[l]).map(l => "DATA." + l + " is missing"));

check("TERMS: native vocabulary present for every non-English language", () =>
  OTHER.filter(l => !I18N.TERMS || !I18N.TERMS[l] || !Object.keys(I18N.TERMS[l]).length)
       .map(l => "TERMS." + l + " is empty"));

/* ---- 3. placeholders survived translation ------------------------------- */

check("placeholders match English in every translated string", () => {
  const marks = s => (String(s).match(/\{[A-Za-z]+\}/g) || []).sort().join(",");
  const p = [];
  for (const l of OTHER){
    for (const k of Object.keys(I18N.UI.en)){
      const en = I18N.UI.en[k], tr = I18N.UI[l][k];
      if (typeof en !== "string" || typeof tr !== "string") continue;
      if (marks(en) !== marks(tr)){
        p.push("UI." + l + "." + k + ": English has [" + marks(en) +
               "], translation has [" + marks(tr) + "]");
      }
    }
  }
  // An intent answer with an unknown placeholder renders the braces raw.
  const KNOWN = /^\{(CALL|MAIL|BOOK|REST|WHATSAPP|n|total|count)\}$/;
  for (const l of Object.keys(I18N.REPLY || {})){
    for (const [k, v] of Object.entries(I18N.REPLY[l])){
      for (const m of String(v).match(/\{[A-Za-z]+\}/g) || []){
        if (!KNOWN.test(m)) p.push("REPLY." + l + "." + k + " has unknown placeholder " + m);
      }
    }
  }
  return p;
});

check("no untranslated English sentence left in a translated label", () => {
  // Proper nouns, codes and units are expected; a run of English words is not.
  const ALLOW = /^(COK|IXM|LED|TV|UV|WiFi|Misty|Mountain|Teyla|Elam|Google|Maps|WhatsApp|km|kms|PO|AC)$/i;
  const p = [];
  for (const l of OTHER){
    for (const [k, v] of Object.entries(I18N.UI[l])){
      if (typeof v !== "string") continue;
      const words = (v.match(/[A-Za-z][A-Za-z-]{2,}/g) || []).filter(w => !ALLOW.test(w));
      if (words.length >= 3){
        p.push("UI." + l + "." + k + " still reads as English: " + words.slice(0, 5).join(" "));
      }
    }
  }
  return p;
});

/* ---- 4. the knowledge base refers only to things that exist ------------- */

check("picture sets are non-empty and every picture has a source", () => {
  const p = [];
  for (const [k, set] of Object.entries(MEDIA.sets || {})){
    if (!set.length){ p.push("set " + k + " is empty"); continue; }
    set.forEach((pic, i) => {
      const at = "set " + k + "[" + i + "]";
      if (!pic || !pic.src) p.push(at + " has no src");
      else if (!/^https:\/\//.test(pic.src)) p.push(at + " is not https");
      if (pic && !pic.alt) p.push(at + " has no alt text");
    });
  }
  return p;
});

check("every picture in a set is also in pics, so captions resolve", () => {
  const byRef = new Set(Object.values(MEDIA.pics || {}));
  const p = [];
  for (const [k, set] of Object.entries(MEDIA.sets || {})){
    set.forEach((pic, i) => {
      if (!byRef.has(pic)){
        p.push("set " + k + "[" + i + "] is not the same object as any MM_MEDIA.pics entry");
      }
    });
  }
  return p;
});

check("corpus entries point at categories, media and places that exist", () => {
  const p = [];
  const sets = new Set(Object.keys(MEDIA.sets || {}));
  const places = new Set(Object.keys(PLACES || {}));
  const cats = new Set(Object.keys(CATS || {}));
  QA.forEach((e, i) => {
    const at = "QA[" + i + "]";
    if (!e.q || !e.a) p.push(at + " has no question or no answer");
    if (e.c && !cats.has(e.c))  p.push(at + " category " + e.c + " does not exist");
    if (e.m && !sets.has(e.m))  p.push(at + " media set " + e.m + " does not exist");
    (e.p || []).forEach(k => { if (!places.has(k)) p.push(at + " place " + k + " does not exist"); });
  });
  return p;
});

check("the page maps of media and places point at real entries", () => {
  const grab = name => {
    const m = HTML.match(new RegExp("const " + name + " = \\{([\\s\\S]*?)\\n\\};"));
    return m ? m[1] : null;
  };
  const media = grab("KB_MEDIA"), place = grab("KB_PLACES");
  if (!media) return ["KB_MEDIA not found in the HTML"];
  if (!place) return ["KB_PLACES not found in the HTML"];
  const p = [];
  for (const m of media.matchAll(/:\s*"([A-Za-z0-9]+)"/g)){
    if (!MEDIA.sets[m[1]]) p.push("KB_MEDIA points at missing set " + m[1]);
  }
  const INTENTS = /^(location|distance|transfer|nearby)$/;
  for (const m of place.matchAll(/"([A-Za-z]+)"/g)){
    if (!PLACES[m[1]] && !INTENTS.test(m[1])) p.push("KB_PLACES points at missing place " + m[1]);
  }
  return p;
});

check("every place resolves to a map query", () =>
  Object.entries(PLACES || {})
        .filter(([, v]) => !v.q && !v.url)
        .map(([k]) => k + " has neither q nor url, so the pin cannot resolve"));

/* ---- 5. the page and the pack agree ------------------------------------- */

check("every data-i18n key in the HTML exists in the English pack", () => {
  const attrs = ["data-i18n", "data-i18n-html", "data-i18n-aria", "data-i18n-title", "data-i18n-ph"];
  const p = [];
  for (const a of attrs){
    for (const m of HTML.matchAll(new RegExp(a + '="([A-Za-z0-9_]+)"', "g"))){
      if (I18N.UI.en[m[1]] === undefined) p.push(a + " " + m[1] + " has no entry in UI.en");
    }
  }
  return p;
});

check("the inline bootstrap is in step with the pack", () => {
  const BEGIN = "<!-- BEGIN i18n bootstrap";
  const END   = "<!-- END i18n bootstrap -->";
  const i = HTML.indexOf(BEGIN), j = HTML.indexOf(END);
  if (i === -1 || j === -1) return ["the bootstrap markers are gone, run: node sync_i18n_inline.js"];
  const block = HTML.slice(i, j);
  const p = [];
  for (const l of CODES){
    for (const [k, v] of Object.entries(I18N.UI[l])){
      if (typeof v !== "string" || !v) continue;
      if (!block.includes(JSON.stringify(v).slice(1, -1))){
        p.push("bootstrap is missing UI." + l + "." + k + ", run: node sync_i18n_inline.js");
        break;                              // one line per language is enough
      }
    }
  }
  CODES.forEach(c => {
    if (!block.includes('"code": "' + c + '"')) p.push("bootstrap does not offer " + c);
  });
  return p;
});

check("the page still has the elements the script wires up", () => {
  const ids = ["dock", "scrim", "launch", "log", "ask", "send", "dockLang", "dockClear",
               "dockClose", "dockTitle", "pgHome", "pgChat", "pgContact", "tabHome",
               "tabChat", "tabContact", "homeEnq", "homeStart", "homeHero", "homeHeroBtn",
               "homeHeroImg", "homeTiles", "enqList", "deskLink"];
  return ids.filter(id => !HTML.includes('id="' + id + '"')).map(id => "#" + id + " is gone");
});

check("the three data files are still linked, in order, after the bootstrap", () => {
  const want = ["misty_i18n.js", "misty_knowledge_base.js", "misty_knowledge_qa.js"];
  const at = want.map(f => HTML.indexOf('<script src="' + f + '">'));
  const p = [];
  want.forEach((f, i) => { if (at[i] === -1) p.push(f + " is not linked"); });
  if (at.every(x => x !== -1) && !(at[0] < at[1] && at[1] < at[2])){
    p.push("the data files are linked out of order");
  }
  const boot = HTML.indexOf("<!-- BEGIN i18n bootstrap");
  if (boot !== -1 && at[0] !== -1 && boot > at[0]){
    p.push("the bootstrap must come before misty_i18n.js, or the pack cannot replace it");
  }
  return p;
});

check("the transcript is never persisted anywhere", () => {
  // One guest must not leave a transcript for the next. Nothing may be
  // written to storage, so nothing can survive a reload or a new visitor.
  // Comments are stripped first: the page explains why it stores nothing,
  // and naming an API in prose is not using it.
  const code = HTML
    .replace(/<!--[\s\S]*?-->/g, " ")          // HTML comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")        // block comments
    .replace(/^[ 	]*\/\/.*$/gm, " ");         // whole-line comments
  const banned = [
    [/\blocalStorage\b/,   "localStorage"],
    [/\bsessionStorage\b/, "sessionStorage"],
    [/\bindexedDB\b/,      "indexedDB"],
    [/document\s*\.\s*cookie/, "document.cookie"]
  ];
  return banned.filter(([re]) => re.test(code))
               .map(([, name]) => name + " is used in the page, so a transcript could outlive its guest");
});

check("a shared device drops the transcript when it changes hands", () => {
  const p = [];
  const wants = [
    ["IDLE_OPEN_MS",   "the idle-while-open threshold"],
    ["IDLE_CLOSED_MS", "the closed-then-reopened threshold"],
    ["IDLE_HIDDEN_MS", "the hidden-tab threshold"],
    ["function forget()", "the wipe itself"],
    ["visibilitychange", "the hidden-tab listener"]
  ];
  wants.forEach(([needle, what]) => {
    if (!HTML.includes(needle)) p.push(what + " is gone (" + needle + ")");
  });
  // A wipe mid-answer would delete what the guest is still reading.
  if (!/if \(busy \|\| Date\.now\(\) - lastTouch < IDLE_OPEN_MS\) return armIdle\(\);/.test(HTML)){
    p.push("the idle timer no longer refuses to fire mid-answer");
  }
  if (!/log\.addEventListener\("scroll", touched/.test(HTML)){
    p.push("scrolling the transcript no longer counts as someone reading it");
  }
  // Thresholds in the minute range, not seconds: a test build left behind
  // would wipe a guest mid-conversation.
  for (const m of HTML.matchAll(/const (IDLE_\w+)\s*=\s*([^;]+);/g)){
    const ms = Function("return (" + m[2] + ")")();
    if (ms < 30000) p.push(m[1] + " is only " + ms + "ms — a test value left in?");
  }
  return p;
});

check("no leftover debugging in the page", () =>
  [...HTML.matchAll(/console\.(log|debug)\s*\(/g)].map(m => "a stray console." + m[1] + " is still in the page"));

/* ---- 6. the corpus is intact -------------------------------------------- */

check("corpus is the full thousand and carries no duplicate questions", () => {
  const p = [];
  if (QA.length < 1000) p.push("expected 1000 pairs, found " + QA.length);
  const seen = new Map();
  QA.forEach((e, i) => {
    const k = String(e.q).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(k)) p.push("QA[" + i + "] repeats QA[" + seen.get(k) + "]: " + e.q);
    else seen.set(k, i);
  });
  return p;
});

check("answers carry no unbalanced markup", () => {
  const p = [];
  const scan = (label, html) => {
    const s = String(html);
    const open  = (s.match(/<(strong|em|b|i|ul|li|p)\b/g) || []).length;
    const close = (s.match(/<\/(strong|em|b|i|ul|li|p)>/g) || []).length;
    if (open !== close){
      p.push(label + " has unbalanced tags (" + open + " open, " + close + " close)");
    }
  };
  QA.forEach((e, i) => scan("QA[" + i + "]", e.a));
  for (const l of Object.keys(I18N.REPLY || {})){
    for (const [k, v] of Object.entries(I18N.REPLY[l])) scan("REPLY." + l + "." + k, v);
  }
  return p;
});

/* ---- the dashboard and the booking front end --------------------------- */

const ADMIN_JS = fs.readFileSync("hotel_admin.js", "utf8");

check("the dashboard has its five pages and the sign-in gate", () => {
  const p = [];
  for (const v of ["dashboard", "rooms", "reservations", "guests", "reports"]){
    if (!HTML.includes('data-view-panel="' + v + '"')) p.push("page " + v + " is gone");
    if (!HTML.includes('data-view="' + v + '"')) p.push("nav link to " + v + " is gone");
  }
  ["mmGate", "mmApp", "mmSignin", "kpis", "roomBoard", "roomsTable", "resTable", "guestTable", "reportKpis", "drawer"]
    .forEach(id => { if (!HTML.includes('id="' + id + '"')) p.push("#" + id + " is gone"); });
  if (!HTML.includes('class="mm-app" id="mmApp" hidden')) p.push("the admin app must start hidden until sign-in");
  return p;
});

check("the Supabase library is pinned, integrity-checked and loaded before the dashboard", () => {
  const lib = HTML.match(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@(\d+\.\d+\.\d+)\/dist\/umd\/supabase\.js" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"><\/script>/);
  if (!lib) return ["supabase-js must be an exact version with an integrity hash"];
  return HTML.indexOf(lib[0]) < HTML.indexOf('<script src="hotel_admin.js">') ? [] : ["supabase-js must load before hotel_admin.js"];
});

check("no secret ever reaches the browser", () => {
  const p = [];
  for (const [name, text] of [["index.html", HTML], ["hotel_admin.js", ADMIN_JS]]){
    if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)) p.push(name + " contains a JWT-shaped key");
    if (/sb_(secret|publishable)_/.test(text)) p.push(name + " contains a Supabase key");
    if (/service_role|SERVICE_ROLE|JEV_API_KEY|postgres(?:ql)?:\/\//.test(text)) p.push(name + " mentions a server-only credential");
  }
  return p;
});

check("the booking client keeps its state in memory only and offers typing beside every option", () => {
  const p = [];
  if (!/let chatState = null;/.test(HTML)) p.push("the booking state variable is gone");
  if (!/chatState = null;\s*\n\s*hintFor\(null\);/.test(HTML)) p.push("clearing the chat no longer drops the booking state");
  if (!/function bkOptions\(/.test(HTML) || !/function bkDate\(/.test(HTML) || !/function bkForm\(/.test(HTML)) p.push("a booking widget renderer is gone");
  if (!/function hintFor\(/.test(HTML)) p.push("the typing hint is gone");
  return p;
});

/* ---- verdict ------------------------------------------------------------ */

console.log("\n" + pass + " passed, " + fails.length + " failed");
if (fails.length){
  console.log("\nNot ready to ship:");
  fails.forEach(f => console.log("  - " + f));
  process.exit(1);
}
console.log("Ready to ship.");
