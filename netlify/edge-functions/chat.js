// Legacy Lucy — streaming chat endpoint (Netlify Edge Function, served at /api/chat).
// The full summary takes longer to write than a regular Netlify function is allowed to run, so this
// edge function pipes Claude's reply to the page as it's written (same approach as Brand Bestie).
//
// Before anything reaches Claude, the session is checked against the one-time-use lock via
// store.js's "gate" action (see netlify/lib/gate.js). Interview mode gets the full flow prompt;
// update mode gets the narrow "revise your summary" prompt; a locked session gets nothing.
//
// Response is newline-delimited JSON, one event per line:
//   {"t":"text chunk"}                         — append to the reply
//   {"done":true,"complete":bool,"mode":...}   — finished; complete = the reply has a full summary
//   {"error":"message"}                        — something failed mid-stream
//   {"locked":true,"reason":...,"message":...} — the gate refused the request (no stream follows)
import { SYSTEM_PROMPT, UPDATE_PROMPT, sanitizeMessages, hasSummary, callAnthropic } from "../lib/lucy.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function envGet(name) {
  if (globalThis.Netlify && globalThis.Netlify.env) return globalThis.Netlify.env.get(name);
  if (globalThis.Deno && globalThis.Deno.env) return globalThis.Deno.env.get(name);
  return globalThis.process ? globalThis.process.env[name] : undefined;
}

const LAST_TURN_NOTE = "This is the client's last message in this update round. If you can tell what they want changed, apply it now and return the full revised summary. If you can't, say warmly in one line that you couldn't apply it and that they can reply to their summary email for help.";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const apiKey = envGet("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) return json({ error: "No valid messages" }, 400);

  // The gate lives in a regular function (it needs Netlify Blobs); call it on this same site.
  let gate;
  try {
    const res = await fetch(new URL("/.netlify/functions/store", req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "gate", key: body.key, accessCode: body.accessCode })
    });
    gate = await res.json();
  } catch (e) {
    return json({ error: "Couldn't check your session just now — give it a moment and try again." }, 503);
  }
  if (!gate || !gate.ok) return json({ locked: true, reason: gate && gate.reason, message: gate && gate.message, updatesLeft: gate && gate.updatesLeft }, 403);

  const system = gate.mode === "update" ? UPDATE_PROMPT : SYSTEM_PROMPT;
  if (gate.mode === "update" && gate.lastTurn) messages.push({ role: "system", content: LAST_TURN_NOTE });

  const upstream = await callAnthropic(apiKey, system, messages, true);
  if (!upstream.ok || !upstream.body) {
    const err = await upstream.text().catch(() => "");
    return json({ error: `Anthropic API ${upstream.status}: ${err}` }, 502);
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = "", full = "", refused = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // Anthropic sends server-sent events; each payload sits on a "data: {...}" line.
          // Thinking deltas and fallback blocks are skipped — only the visible reply is forwarded.
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            let ev;
            try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
              full += ev.delta.text;
              send({ t: ev.delta.text });
            } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason === "refusal") {
              refused = true;
            } else if (ev.type === "error") {
              throw new Error((ev.error && ev.error.message) || "Anthropic stream error");
            }
          }
        }
        const reply = full.trim();
        if (refused && !reply) throw new Error("Lucy couldn't answer that one — try rephrasing your message.");
        send({ done: true, complete: hasSummary(reply), mode: gate.mode, updatesLeft: gate.updatesLeft });
      } catch (e) {
        send({ error: String((e && e.message) || e) });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" }
  });
};

export const config = { path: "/api/chat" };
