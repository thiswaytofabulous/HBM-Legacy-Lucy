// Legacy Lucy — the one-time-use lock, enforced server-side.
//
// Lucy is shoot prep, not an open chat. Every chat request passes through checkGate() before it
// reaches Claude (the edge function calls it through store.js's "gate" action; the classic
// assistant function calls it directly). It decides:
//   - interview mode: the session has no summary yet. Allowed up to MAX_INTERVIEW_TURNS messages.
//   - update mode:    a summary exists. Allowed only while updatesUsed < MAX_UPDATES. Each update
//                     round gets MAX_UPDATE_TURNS messages; a round that runs out without producing
//                     a new summary still counts as one update, so the update space can't become a
//                     back door to an open chat.
//   - locked:         a summary exists and every update is used up. Nothing reaches Claude.
//
// The counters live in their own Blobs store ("legacy-lucy-gate"), separate from the session record
// the page saves, so a page save can never overwrite or reset them. Whether a session is finished
// is read from the session record, where store.js makes it sticky (a page can't un-submit itself).
import { getStore } from "@netlify/blobs";
import { MAX_UPDATES, MAX_INTERVIEW_TURNS, MAX_UPDATE_TURNS } from "./lucy.js";

export function slug(key) {
  return String(key || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const sessionStore = () => getStore("legacy-lucy-intake");
export const gateStore = () => getStore("legacy-lucy-gate");

const EMPTY = { interviewTurns: 0, updatesUsed: 0, roundTurns: 0, extraUpdates: 0 };

export async function readGate(key) {
  try {
    const g = await gateStore().get(slug(key), { type: "json" });
    return { ...EMPTY, ...(g || {}) };
  } catch (e) {
    return { ...EMPTY };
  }
}

export async function writeGate(key, g) {
  await gateStore().setJSON(slug(key), { ...g, updatedAt: new Date().toISOString() });
}

export function updatesAllowed(g) {
  return MAX_UPDATES + (Number(g.extraUpdates) || 0);
}

export function updatesLeft(g) {
  return Math.max(0, updatesAllowed(g) - (Number(g.updatesUsed) || 0));
}

// Optional extra lock: when CLIENT_CODE is set on the site, every session needs it (Jessi sends it
// to booked clients), so the link can't be passed around and used by anyone with an email address.
export function codeOk(code) {
  const expected = process.env.CLIENT_CODE;
  if (!expected) return true;
  return String(code || "").trim().toLowerCase() === String(expected).trim().toLowerCase();
}

export async function checkGate({ key, accessCode }) {
  if (!key) return { ok: false, reason: "missing_key", message: "Missing session — refresh the page and enter your email again." };
  if (!codeOk(accessCode)) return { ok: false, reason: "code", message: "That shoot code doesn't match. Check the email from the Haven Built team." };

  let record = null;
  try { record = await sessionStore().get(slug(key), { type: "json" }); } catch (e) { /* new session */ }
  const g = await readGate(key);

  if (!(record && record.submitted)) {
    if (g.interviewTurns >= MAX_INTERVIEW_TURNS) {
      return { ok: false, reason: "turn_limit", message: "We've hit the limit for this session. Jessi has everything you've shared so far and will reach out to wrap it up with you." };
    }
    g.interviewTurns += 1;
    await writeGate(key, g);
    return { ok: true, mode: "interview" };
  }

  // A round that ran out of messages without a new summary still uses up an update.
  if (g.roundTurns >= MAX_UPDATE_TURNS) {
    g.updatesUsed += 1;
    g.roundTurns = 0;
  }
  if (updatesLeft(g) <= 0) {
    await writeGate(key, g);
    return { ok: false, reason: "locked", updatesLeft: 0, message: "Your story summary is locked in, and all of your updates have been used. Need another change? Just reply to your summary email and the Haven Built team will take care of it." };
  }
  g.roundTurns += 1;
  await writeGate(key, g);
  return { ok: true, mode: "update", lastTurn: g.roundTurns >= MAX_UPDATE_TURNS, updatesLeft: updatesLeft(g) };
}

// Called by store.js when a save carries a brand-new summary from an update round.
export async function consumeUpdate(key) {
  const g = await readGate(key);
  g.updatesUsed += 1;
  g.roundTurns = 0;
  await writeGate(key, g);
  return g;
}
