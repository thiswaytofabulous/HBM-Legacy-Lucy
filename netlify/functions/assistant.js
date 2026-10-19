// Legacy Lucy — classic (non-streaming) chat endpoint. The page uses the streaming edge function at
// /api/chat (netlify/edge-functions/chat.js); this is its automatic fallback if streaming is
// unavailable. Same prompts, same sanitizer, same one-time-use gate.
import { SYSTEM_PROMPT, UPDATE_PROMPT, sanitizeMessages, hasSummary, callAnthropic } from "../lib/lucy.js";
import { checkGate } from "../lib/gate.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) return json({ error: "No valid messages" }, 400);

  const gate = await checkGate({ key: body.key, accessCode: body.accessCode });
  if (!gate.ok) return json({ locked: true, reason: gate.reason, message: gate.message, updatesLeft: gate.updatesLeft }, 403);

  try {
    const res = await callAnthropic(apiKey, gate.mode === "update" ? UPDATE_PROMPT : SYSTEM_PROMPT, messages, false);
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    if (!reply) throw new Error(data.stop_reason === "refusal" ? "Lucy couldn't answer that one — try rephrasing your message." : "Empty reply");
    return json({ reply, complete: hasSummary(reply), mode: gate.mode, updatesLeft: gate.updatesLeft });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};
