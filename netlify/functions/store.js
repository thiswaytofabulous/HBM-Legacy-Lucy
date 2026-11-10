// Legacy Lucy — persistence (Netlify Blobs), the one-time-use gate, admin access, and the summary
// emails. Built on Brand Bestie's store.js, with the lock added:
//   - "gate"  : every chat request is checked here first (see netlify/lib/gate.js).
//   - "save"  : the page saves after every turn. Once a session has a summary it stays submitted,
//               and its history can only grow — a page can't un-submit itself or wipe the record.
//               When a save carries a NEW summary, Jessi's alert and the client's copy go out (with
//               the branded PDF), and if it came from an update round, one update is used up.
//   - "list"  : admin-only, also used by the TWTF Live Dashboard (submission-dashboard repo).
//   - "resend": admin-only, re-sends both emails for a finished session.
//   - "grant" : admin-only, gives a locked client one more update.
//   - "import": admin-only, loads an unfinished conversation from the old GPT so the client can
//               sign in with their email and finish here.
import { MAX_UPDATES, SUMMARY_START, SUMMARY_END, NOTES_START, NOTES_END } from "../lib/lucy.js";
import { slug, sessionStore, readGate, writeGate, checkGate, consumeUpdate, codeOk, updatesLeft } from "../lib/gate.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BRAND = {
  navy: "#2E4968", rose: "#DBB3B3", slate: "#8A99AB", warm: "#F3F1F0", white: "#FFFFFF",
  font: "'Montserrat', Arial, Helvetica, sans-serif"
};

// Optional blind copy on every client copy, so the team sees exactly what each client received.
const CLIENT_COPY_BCC = process.env.CLIENT_COPY_BCC || "";

// The bot embeds hidden [[STEP:...]] markers for the page to read — they never belong in anything
// a human reads, so strip them (and markdown bold) from the summary and transcript.
function stripMarkers(text) {
  return String(text == null ? "" : text)
    .replace(/\[\[\s*STEP\s*:\s*[A-Za-z]+\s*\]\]/g, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}
function plain(text) { return stripMarkers(text).replace(/\*\*/g, ""); }

function between(text, start, end) {
  const i = text.indexOf(start);
  if (i === -1) return null;
  const j = text.indexOf(end, i + start.length);
  return text.substring(i + start.length, j !== -1 ? j : undefined).trim();
}

// The most recent summary (and its team notes) in the conversation — an update round writes a new
// one, and the newest always wins.
function latestSummary(history) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.includes(SUMMARY_START)) {
      const summary = between(m.content, SUMMARY_START, SUMMARY_END);
      const notes = between(m.content, NOTES_START, NOTES_END);
      return { summary: summary ? plain(summary) : null, notes: notes ? plain(notes) : null };
    }
  }
  return { summary: null, notes: null };
}

function agencyOf(summary) {
  const m = summary && summary.match(/^Agency:\s*(.+)$/im);
  return m ? m[1].trim() : "";
}
function takeawayOf(summary) {
  const m = summary && summary.match(/THE TAKEAWAY\s*\n\s*["“](.+?)["”]?\s*$/im);
  return m ? m[1].trim() : "";
}

// Email-safe (inline-styled) version of the page's summary formatting.
function summaryEmailHTML(raw) {
  const f = `font-family:${BRAND.font};color:${BRAND.navy}`;
  return String(raw || "").split("\n").map(line => {
    const t = line.trim();
    if (!t) return "";
    if (/^LEGACY STORY SUMMARY$/i.test(t)) return `<div style="${f};font-size:16px;font-weight:900;text-transform:uppercase;margin-bottom:2px">${esc(t)}</div>`;
    if (t.includes("|") && !t.includes(":")) return `<div style="${f};font-size:13px;color:${BRAND.slate};margin-bottom:6px">${esc(t)}</div>`;
    const header = t === t.toUpperCase() && /[A-Z]/.test(t) && !t.includes(":") && !/^["“]/.test(t) && t.length < 50;
    if (header) return `<div style="${f};font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin:18px 0 6px;padding-bottom:4px;border-bottom:2px solid ${BRAND.rose}">${esc(t)}</div>`;
    if (/^["“]/.test(t)) return `<div style="${f};font-size:16px;font-style:italic;background:${BRAND.warm};border-left:3px solid ${BRAND.rose};border-radius:6px;padding:10px 12px;margin:4px 0 8px">${esc(t)}</div>`;
    const m = t.match(/^([^:]{2,70}):\s*(.*)$/);
    if (m) return `<div style="${f};font-size:14px;line-height:1.55;margin:0 0 6px"><span style="color:${BRAND.slate};font-weight:700">${esc(m[1])}:</span> ${esc(m[2])}</div>`;
    return `<div style="${f};font-size:14px;line-height:1.55;margin:0 0 6px">${esc(t)}</div>`;
  }).join("");
}

async function sendViaResend(payload) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify(payload)
  });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { /* leave raw */ }
  return { ok: res.ok, status: res.status, body: parsed || raw };
}

const fromAddress = () => process.env.NOTIFY_FROM || "Haven Built Media <noreply@havenbuiltmedia.com>";

function header(kicker, title) {
  return `<div style="background:${BRAND.navy};color:${BRAND.white};padding:22px;border-radius:6px 6px 0 0">
      <div style="font-family:${BRAND.font};font-size:12px;letter-spacing:.14em;font-weight:800;color:${BRAND.rose}">${esc(kicker)}</div>
      <h2 style="font-family:${BRAND.font};margin:6px 0 0;font-size:22px;font-weight:900;text-transform:uppercase">${esc(title)}</h2>
    </div>`;
}

// The client's own copy of their summary — the deliverable they keep. Replies go to Jessi
// (NOTIFY_EMAIL) so "can we change X?" lands in her inbox.
async function sendClientCopy(data, summary, attachment, isUpdate) {
  const to = data && data.email;
  if (!process.env.RESEND_API_KEY) return { attempted: false, ok: false, reason: "RESEND_API_KEY missing" };
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { attempted: false, ok: false, reason: "no valid client email" };
  if (!summary) return { attempted: false, ok: false, reason: "no summary" };
  const first = String(data.name || "").split(" ")[0] || "there";

  const intro = isUpdate
    ? `Hi ${esc(first)}, here's your updated Legacy Story Summary. Your PDF copy is attached too, and the Haven Built team has the new version.`
    : `Hi ${esc(first)}, thank you for sharing your story with us. Here's everything we captured today, all in one place (your PDF copy is attached too). This is what we'll use to shape your interview and map out your shoot.`;
  const html = `<div style="font-family:${BRAND.font};color:${BRAND.navy};max-width:640px;margin:0 auto">
    ${header("HAVEN BUILT MEDIA", isUpdate ? "Your updated story summary" : "Your Legacy Story Summary")}
    <div style="border:1px solid ${BRAND.warm};border-top:none;border-radius:0 0 6px 6px;padding:22px;background:${BRAND.white}">
      <p style="font-family:${BRAND.font};font-size:15px;line-height:1.6;margin:0 0 18px">${intro}</p>
      ${summaryEmailHTML(summary)}
      <div style="margin-top:22px;padding:16px;background:${BRAND.navy};border-radius:8px;font-family:${BRAND.font};font-size:14px;line-height:1.6;color:${BRAND.white}">
        <span style="color:${BRAND.rose};font-weight:800">WHAT HAPPENS NEXT:</span> We'll follow up to finalize logistics, people on camera, props, and locations. No script, no memorizing. Just show up as you.
        <div style="margin-top:10px;font-size:12px;opacity:.85">Want to change something? Just reply to this email.</div>
      </div>
    </div>
  </div>`;
  const text = `${isUpdate ? "Here's your updated Legacy Story Summary." : `Hi ${first}, here's your Legacy Story Summary.`}\n\n${summary}\n\nWHAT HAPPENS NEXT: We'll follow up to finalize logistics, people on camera, props, and locations.\n\nWant to change something? Just reply to this email.`;

  try {
    const payload = { from: fromAddress(), to, subject: isUpdate ? "Your updated Legacy Story Summary" : "Your Legacy Story Summary", html, text };
    if (attachment) payload.attachments = [attachment];
    if (process.env.NOTIFY_EMAIL) payload.reply_to = process.env.NOTIFY_EMAIL;
    if (CLIENT_COPY_BCC && CLIENT_COPY_BCC.toLowerCase() !== String(to).toLowerCase()) payload.bcc = CLIENT_COPY_BCC;
    const r = await sendViaResend(payload);
    if (r.ok) console.log("[client-copy] SUCCESS ->", to);
    else console.error("[client-copy] RESEND REJECTED. status:", r.status, "body:", JSON.stringify(r.body));
    return { attempted: true, ...r };
  } catch (e) {
    console.error("[client-copy] NETWORK/THROW:", String(e && e.message || e));
    return { attempted: true, ok: false, error: String(e && e.message || e) };
  }
}

function transcriptHTML(history, clientName) {
  const rows = (history || []).filter(m => !m.hidden).map(m => {
    const isLucy = m.role === "assistant";
    const who = isLucy ? "LUCY" : (clientName || "CLIENT").toUpperCase();
    // The summary turn is already shown in full above — keep the transcript readable.
    let content = m.display || m.content;
    if (isLucy && content.includes(SUMMARY_START)) content = content.slice(0, content.indexOf(SUMMARY_START)) + "\n(Story summary — shown above.)";
    const body = esc(plain(content)).replace(/\n/g, "<br>");
    const bg = isLucy ? BRAND.warm : BRAND.white;
    const bar = isLucy ? BRAND.rose : BRAND.navy;
    return `<div style="margin:0 0 12px;padding:12px 14px;background:${bg};border-left:3px solid ${bar};border-radius:4px">
      <div style="font-family:${BRAND.font};font-size:11px;letter-spacing:.08em;font-weight:800;color:${BRAND.navy};margin-bottom:4px">${esc(who)}</div>
      <div style="font-family:${BRAND.font};font-size:14px;line-height:1.55;color:${BRAND.navy}">${body}</div>
    </div>`;
  });
  return rows.join("") || `<p style="font-family:${BRAND.font};color:${BRAND.navy};opacity:.6">(No conversation captured.)</p>`;
}

// Build the branded summary PDF once per send and attach it to both emails. If it fails for any
// reason, the emails still go out without it. Loaded lazily so a PDF problem can never break
// ordinary saves, which also run through this function.
async function summaryAttachment(data, summary) {
  if (!summary) return null;
  try {
    const { buildSummaryPDF, pdfFilename } = await import("../lib/summary-pdf.js");
    const buf = await buildSummaryPDF({ summary, name: data.name });
    return { filename: pdfFilename(data.name), content: buf.toString("base64") };
  } catch (e) {
    console.error("[pdf] could not build summary PDF:", String(e && e.message || e));
    return null;
  }
}

// Jessi's alert: the summary, the internal team notes (interview guide + shotlist), and the full
// conversation.
async function notifyCompletion(data, isUpdate, summary, notes, attachment, gateInfo) {
  const name = data.name || "A client";
  const email = data.email || "(no email)";
  const agency = agencyOf(summary);
  const when = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const badge = isUpdate ? "🔄 UPDATED" : "🆕 NEW";
  const to = process.env.NOTIFY_EMAIL;

  if (!process.env.RESEND_API_KEY) return { attempted: false, ok: false, reason: "RESEND_API_KEY missing" };
  if (!to) return { attempted: false, ok: false, reason: "NOTIFY_EMAIL missing" };

  const takeaway = takeawayOf(summary);
  const notesHtml = notes
    ? `<div style="margin-bottom:20px;padding:16px;background:${BRAND.navy};border-radius:8px">
        <div style="font-family:${BRAND.font};font-size:12px;letter-spacing:.1em;font-weight:800;color:${BRAND.rose};margin-bottom:8px">TEAM NOTES (INTERNAL — NOT SENT TO CLIENT)</div>
        <div style="background:${BRAND.white};border-radius:6px;padding:14px 16px">${summaryEmailHTML(notes)}</div>
      </div>` : "";

  const html = `<div style="font-family:${BRAND.font};color:${BRAND.navy};max-width:640px;margin:0 auto">
    ${header(badge, `Legacy Lucy ${isUpdate ? "update" : "completion"}`)}
    <div style="border:1px solid ${BRAND.warm};border-top:none;border-radius:0 0 6px 6px;padding:20px;background:${BRAND.white}">
      <table style="font-family:${BRAND.font};font-size:14px;line-height:1.6;margin-bottom:16px">
        <tr><td style="color:${BRAND.slate};font-weight:700;padding-right:12px">Name</td><td style="font-weight:700">${esc(name)}</td></tr>
        <tr><td style="color:${BRAND.slate};font-weight:700;padding-right:12px">Agency</td><td style="font-weight:700">${esc(agency || "—")}</td></tr>
        <tr><td style="color:${BRAND.slate};font-weight:700;padding-right:12px">Email</td><td>${esc(email)}</td></tr>
        <tr><td style="color:${BRAND.slate};font-weight:700;padding-right:12px">${isUpdate ? "Updated" : "Completed"}</td><td>${esc(when)} CT</td></tr>
        <tr><td style="color:${BRAND.slate};font-weight:700;padding-right:12px">Updates left</td><td>${gateInfo ? updatesLeft(gateInfo) : MAX_UPDATES}</td></tr>
      </table>
      ${takeaway ? `<div style="margin-bottom:16px;padding:16px;background:${BRAND.warm};border-left:4px solid ${BRAND.rose};border-radius:8px">
        <div style="font-family:${BRAND.font};font-size:12px;letter-spacing:.1em;font-weight:800;color:${BRAND.slate};margin-bottom:6px">THE TAKEAWAY</div>
        <div style="font-family:${BRAND.font};font-size:16px;line-height:1.5;font-weight:700">&ldquo;${esc(takeaway)}&rdquo;</div>
      </div>` : ""}
      <div style="margin-bottom:20px;padding:16px;background:${BRAND.warm};border-radius:8px">
        <div style="background:${BRAND.white};border-radius:6px;padding:14px 16px">${summaryEmailHTML(summary)}</div>
      </div>
      ${notesHtml}
      <hr style="border:none;border-top:1px solid ${BRAND.warm};margin:16px 0">
      <div style="font-family:${BRAND.font};font-size:12px;letter-spacing:.1em;font-weight:800;color:${BRAND.slate};margin-bottom:12px">FULL CONVERSATION</div>
      ${transcriptHTML(data.history, name)}
    </div>
  </div>`;
  const convoText = (data.history || []).filter(m => !m.hidden).map(m => `${m.role === "assistant" ? "LUCY" : (name || "CLIENT").toUpperCase()}: ${plain(m.display || m.content)}`).join("\n\n");
  const text = `${badge} Legacy Lucy — ${name}${agency ? " (" + agency + ")" : ""} <${email}>\n\n--- SUMMARY ---\n\n${summary}\n\n${notes ? "--- TEAM NOTES ---\n\n" + notes + "\n\n" : ""}--- FULL CONVERSATION ---\n\n${convoText}`;

  try {
    const payload = { from: fromAddress(), to, subject: `${badge} Legacy Lucy — ${name}${agency ? " (" + agency + ")" : ""}`, html, text };
    if (attachment) payload.attachments = [attachment];
    if (data.email) payload.reply_to = data.email;
    const r = await sendViaResend(payload);
    if (r.ok) console.log("[notify] SUCCESS ->", to);
    else console.error("[notify] RESEND REJECTED. status:", r.status, "body:", JSON.stringify(r.body));
    return { attempted: true, ...r };
  } catch (e) {
    console.error("[notify] NETWORK/THROW:", String(e && e.message || e));
    return { attempted: true, ok: false, error: String(e && e.message || e) };
  }
}

const brief = (r) => r.ok ? { ok: true } : { ok: false, why: r.reason || (r.status ? `Resend ${r.status}: ${JSON.stringify(r.error || r.body || "").slice(0, 200)}` : String(r.error || "unknown")) };

async function sendBoth(record, isUpdate, gateInfo) {
  const { summary, notes } = latestSummary(record.history);
  const pdf = await summaryAttachment(record, summary);
  const notify = await notifyCompletion(record, isUpdate, summary, notes, pdf, gateInfo);
  const clientCopy = await sendClientCopy(record, summary, pdf, isUpdate);
  return { at: new Date().toISOString(), alert: brief(notify), client: brief(clientCopy) };
}

function isAdmin(code) {
  const expected = process.env.ADMIN_CODE;
  return !!expected && code === expected;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const { action, key, data, adminCode, accessCode } = body;
  const store = sessionStore();

  try {
    if (action === "config") {
      return json({ codeRequired: !!process.env.CLIENT_CODE, maxUpdates: MAX_UPDATES });
    }

    if (action === "gate") {
      return json(await checkGate({ key, accessCode }));
    }

    if (action === "save") {
      if (!key) return json({ error: "Missing key" }, 400);
      if (!codeOk(accessCode)) return json({ error: "Unauthorized" }, 401);

      let prior = null;
      try { prior = await store.get(slug(key), { type: "json" }); } catch (e) { /* no prior */ }

      const incoming = { ...(data || {}) };
      const history = Array.isArray(incoming.history) ? incoming.history : [];
      // Once a story is finished, its record only moves forward: it stays submitted, and a save
      // that would shorten the conversation is ignored.
      if (prior && prior.submitted && history.length < (prior.history || []).length) {
        return json({ ok: true, saved: false, reason: "history can't shrink after completion" });
      }
      const { summary } = latestSummary(history);
      const record = {
        name: incoming.name || (prior && prior.name) || "",
        email: incoming.email || (prior && prior.email) || "",
        history,
        step: incoming.step || 0,
        submitted: !!(prior && prior.submitted) || !!summary,
        agency: agencyOf(summary) || (prior && prior.agency) || "",
        takeaway: takeawayOf(summary) || (prior && prior.takeaway) || "",
        completedAt: (prior && prior.completedAt) || (summary ? new Date().toISOString() : null),
        lastSummary: (prior && prior.lastSummary) || null,
        lastEmail: (prior && prior.lastEmail) || null,
        createdAt: (prior && prior.createdAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // A new summary (first one, or a changed one from an update round) sends the emails once.
      let lastEmail = null, gateInfo = null;
      if (summary && summary !== record.lastSummary) {
        const isUpdate = !!(prior && prior.submitted);
        gateInfo = isUpdate ? await consumeUpdate(key) : await readGate(key);
        record.lastSummary = summary;
        if (isUpdate) record.updatedSummaryAt = new Date().toISOString();
        await store.setJSON(slug(key), record);
        lastEmail = await sendBoth(record, isUpdate, gateInfo);
        record.lastEmail = lastEmail;
      }
      await store.setJSON(slug(key), record);
      const g = gateInfo || await readGate(key);
      return json({ ok: true, saved: true, submitted: record.submitted, updatesLeft: updatesLeft(g), lastEmail });
    }

    if (action === "load") {
      if (!key) return json({ error: "Missing key" }, 400);
      if (!codeOk(accessCode)) return json({ error: "Unauthorized" }, 401);
      const d = await store.get(slug(key), { type: "json" });
      const g = await readGate(key);
      return json({ data: d || null, updatesLeft: updatesLeft(g) });
    }

    if (action === "list") {
      if (!isAdmin(adminCode)) return json({ error: "Unauthorized" }, 401);
      const { blobs } = await store.list();
      const sessions = [];
      for (const b of blobs) {
        const d = await store.get(b.key, { type: "json" });
        if (!d) continue;
        const g = await readGate(d.email || b.key);
        sessions.push({ ...d, updatesUsed: g.updatesUsed, updatesLeft: updatesLeft(g) });
      }
      sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return json({ sessions });
    }

    if (action === "resend") {
      if (!isAdmin(adminCode)) return json({ error: "Unauthorized" }, 401);
      if (!key) return json({ error: "Missing key" }, 400);
      const record = await store.get(slug(key), { type: "json" });
      if (!record) return json({ error: "Session not found" }, 404);
      if (!latestSummary(record.history).summary) return json({ error: "This session has no summary yet, so there's nothing to send." }, 400);
      record.lastEmail = { ...(await sendBoth(record, false, await readGate(key))), resent: true };
      await store.setJSON(slug(key), record);
      return json({ ok: true, lastEmail: record.lastEmail });
    }

    // Admin-only: load a conversation a client started somewhere else (the old Legacy Lucy GPT) so
    // they can sign in with their email and finish here. End the imported history with a hidden
    // user note starting "[RESUME" and Lucy picks up on her own the moment the client signs in.
    // It never overwrites a finished story, and it sends no emails.
    if (action === "import") {
      if (!isAdmin(adminCode)) return json({ error: "Unauthorized" }, 401);
      const d = data || {};
      const email = String(d.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "The import needs the client's email." }, 400);
      const history = Array.isArray(d.history) ? d.history.filter(m =>
        m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length) : [];
      if (history.length < 2) return json({ error: "The import needs a conversation (a history list with at least two messages)." }, 400);
      if (latestSummary(history).summary) return json({ error: "This conversation already has a summary. Import only unfinished sessions." }, 400);

      let prior = null;
      try { prior = await store.get(slug(email), { type: "json" }); } catch (e) { /* none */ }
      if (prior && prior.submitted) return json({ error: "That client already finished their story here, so the import was skipped." }, 409);

      const step = Math.max(0, Math.min(10, Number(d.step) || 0));
      const record = {
        name: String(d.name || (prior && prior.name) || ""),
        email,
        history,
        step,
        submitted: false,
        agency: String(d.agency || ""),
        takeaway: "",
        completedAt: null,
        lastSummary: null,
        lastEmail: null,
        imported: { at: new Date().toISOString(), from: String(d.source || "Legacy Lucy GPT"), replaced: !!prior },
        createdAt: d.createdAt || (prior && prior.createdAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await store.setJSON(slug(email), record);
      const answers = history.filter(m => m.role === "user" && !m.hidden).length;
      return json({ ok: true, email, answers, replaced: !!prior });
    }

    if (action === "grant") {
      if (!isAdmin(adminCode)) return json({ error: "Unauthorized" }, 401);
      if (!key) return json({ error: "Missing key" }, 400);
      const g = await readGate(key);
      g.extraUpdates = (Number(g.extraUpdates) || 0) + 1;
      g.roundTurns = 0;
      await writeGate(key, g);
      return json({ ok: true, updatesLeft: updatesLeft(g) });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};
