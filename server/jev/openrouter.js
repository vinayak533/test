/* ============================================================================
   server/jev/openrouter.js — Jev through OpenRouter.

   TypeSafe also offers Jev on OpenRouter as "typesafe/jev-router", behind
   OpenRouter's OpenAI-compatible chat-completions API (an OpenRouter key,
   sk-or-v1-…). That is a chat model, not the calibrated choice endpoint in
   client.js, so this adapter turns the same choice questions into a strict
   JSON-schema request and hands back the same shape client.js returns:

     ask(state, questions) → { "<name>": { choice, confidence } }

   The schema limits every choice to the options sent, and classify.js
   validates the answer again, so a model can never introduce an intent or
   a hotel of its own. The confidence is the model's own estimate, not a
   calibrated probability — the thresholds in config.js apply to it all the
   same. Errors use JevError's kinds, so the rules fallback and the auth
   back-off behave exactly as they do for the direct API.

   The router picks the underlying model per request; the model it chose and
   the cost are logged (never the guest's words).
   ============================================================================ */

"use strict";

const { JevError } = require("./client");

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = attempt => Math.min(2000, 250 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);

const SYSTEM = [
  "You classify one message that a guest typed into a hotel website's chatbot.",
  "For every question, choose exactly one option key — the one whose description fits the message best.",
  "Judge only from the message and the descriptions; do not guess beyond them.",
  "Give a confidence between 0 and 1 that your choice is right.",
  "Reply with JSON only, matching the schema."
].join(" ");

function buildRequest(model, state, questions){
  const names = Object.keys(questions);
  const properties = {};
  const shown = {};
  for (const name of names){
    const q = questions[name];
    const keys = Object.keys(q.criteria || {});
    if (q.type !== "choice" || !keys.length) throw new JevError("rejected", `question "${name}" is not a choice question`);
    properties[name] = {
      type: "object", additionalProperties: false, required: ["choice", "confidence"],
      properties: { choice: { type: "string", enum: keys }, confidence: { type: "number" } }
    };
    shown[name] = { instructions: q.instructions, options: q.criteria };
  }
  return {
    model,
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ context: state, questions: shown }) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "classification", strict: true,
                     schema: { type: "object", additionalProperties: false, required: names, properties } }
    }
  };
}

function createOpenRouterJevClient({ apiKey, baseUrl = "https://openrouter.ai/api/v1", model = "typesafe/jev-router",
                                     timeoutMs = 6000, maxRetries = 2, fetchImpl = fetch, log, appName = "Misty Mountain ChatBot" }){
  if (!apiKey) throw new JevError("auth", "JEV_API_KEY is not set");

  async function ask(state, questions){
    const body = JSON.stringify(buildRequest(model, state, questions));
    let attempt = 0;
    for (;;){
      const started = Date.now();
      let res;
      try {
        res = await fetchImpl(baseUrl + "/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", "X-Title": appName },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (e){
        const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
        log && log.warn("jev.request_failed", { via: "openrouter", attempt, ms: Date.now() - started, kind: timedOut ? "timeout" : "network" });
        if (attempt < maxRetries && !timedOut){ attempt++; await sleep(backoff(attempt)); continue; }
        throw new JevError(timedOut ? "timeout" : "network", timedOut ? `Jev did not answer within ${timeoutMs} ms` : "OpenRouter could not be reached");
      }

      const ms = Date.now() - started;
      let payload = null;
      try { payload = await res.json(); } catch { /* handled below */ }

      if (!res.ok){
        const message = (payload && payload.error && payload.error.message) || res.statusText || "error";
        log && log.warn("jev.http_error", { via: "openrouter", status: res.status, ms, attempt });
        if (RETRYABLE.has(res.status) && attempt < maxRetries){ attempt++; await sleep(backoff(attempt)); continue; }
        // A bad key or an empty balance will not fix itself on the next message.
        if (res.status === 401 || res.status === 403 || res.status === 402) throw new JevError("auth", "OpenRouter refused the key: " + message, res.status);
        if (RETRYABLE.has(res.status)) throw new JevError("busy", "OpenRouter is busy: " + message, res.status);
        throw new JevError("rejected", "OpenRouter rejected the request: " + message, res.status);
      }

      // OpenRouter can return 200 with an error from the routed provider.
      const choice = payload && Array.isArray(payload.choices) && payload.choices[0];
      if (!choice || (payload.error && !choice)) throw new JevError("bad_response", "OpenRouter returned no choice", res.status);
      // The router occasionally lands on a model that wraps the JSON in
      // prose or a code fence; take the outermost object and validate it.
      let answers;
      const text = String(choice.message && choice.message.content || "");
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      try { answers = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text); }
      catch { throw new JevError("bad_response", "Jev's answer was not JSON", res.status); }
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new JevError("bad_response", "Jev's answer has no answers object", res.status);

      log && log.info("jev.ok", { via: "openrouter", ms, attempt, routedTo: payload.model || null,
                                  usage: payload.usage ? { input: payload.usage.prompt_tokens, output: payload.usage.completion_tokens, cost: payload.usage.cost } : null });
      return answers;
    }
  }

  return { ask, provider: "openrouter", model };
}

module.exports = { createOpenRouterJevClient, buildRequest };
