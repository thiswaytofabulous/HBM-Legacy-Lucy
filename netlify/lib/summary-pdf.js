// Legacy Lucy — the Legacy Story Summary as a real, branded PDF (HBM: Montserrat, navy + dusty rose
// lead, warm white fills). Used two ways: attached to Jessi's alert and the client's copy
// (store.js), and downloaded from the page's "Download PDF" button (functions/pdf.js).
//
// Input is the plain-text summary between ---BEGIN SUMMARY--- and ---END SUMMARY--- (never the
// team notes). Layout: navy cover band → one clearly headed section per part of the story (labels
// above values so it scans easily) → the takeaway as a rose callout → navy "what happens next" box
// → footer with page numbers on every page.
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const C = { navy: "#2E4968", rose: "#DBB3B3", slate: "#8A99AB", warm: "#F3F1F0", white: "#FFFFFF", rule: "#E4E1DF" };

// Montserrat ships in netlify/lib/fonts (SIL OFL). Look in a few places so it's found both
// locally and inside the bundled Netlify function; fall back to Helvetica if it isn't.
function fontDir() {
  const here = (() => { try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return ""; } })();
  const candidates = [
    here && path.join(here, "fonts"),
    here && path.join(here, "../lib/fonts"),
    path.join(process.cwd(), "netlify/lib/fonts"),
    "/var/task/netlify/lib/fonts"
  ].filter(Boolean);
  return candidates.find(d => { try { return fs.existsSync(path.join(d, "montserrat-latin-400-normal.woff")); } catch { return false; } }) || null;
}

function registerFonts(doc) {
  const dir = fontDir();
  const f = { reg: "Helvetica", ital: "Helvetica-Oblique", med: "Helvetica-Oblique", bold: "Helvetica-Bold", xbold: "Helvetica-Bold", black: "Helvetica-Bold" };
  if (!dir) return f;
  const map = { reg: "400-normal", ital: "400-italic", med: "500-italic", bold: "700-normal", xbold: "800-normal", black: "900-normal" };
  for (const [k, file] of Object.entries(map)) {
    try { doc.registerFont("M-" + k, path.join(dir, `montserrat-latin-${file}.woff`)); f[k] = "M-" + k; } catch { /* keep fallback */ }
  }
  return f;
}

// Montserrat has no emoji; strip them (and stray markup) so nothing renders as empty boxes.
function clean(s) {
  return String(s || "")
    .replace(/\*\*/g, "")
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isHeader(t) {
  return t === t.toUpperCase() && /[A-Z]/.test(t) && !t.includes(":") && !/^["“]/.test(t) && t.length < 50;
}

// Turn the plain-text summary into a simple structure.
export function parseSummary(raw) {
  const out = { sub: "", sections: [] };
  let cur = null;
  String(raw || "").split("\n").map(clean).forEach(t => {
    if (!t) return;
    if (/^LEGACY STORY SUMMARY$/i.test(t)) return;
    if (!out.sections.length && !cur && t.includes("|") && !out.sub) { out.sub = t; return; }
    if (isHeader(t)) { cur = { title: t, items: [] }; out.sections.push(cur); return; }
    if (!cur) { cur = { title: "", items: [] }; out.sections.push(cur); }
    if (/^["“]/.test(t)) { cur.items.push({ quote: t.replace(/^["“]|["”]$/g, "") }); return; }
    const m = t.match(/^([^:]{2,70}):\s*(.*)$/);
    if (m) { cur.items.push({ label: m[1].trim(), value: m[2] }); return; }
    cur.items.push({ text: t });
  });
  return out;
}

export async function buildSummaryPDF({ summary, name }) {
  const s = parseSummary(summary);
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 60, left: 54, right: 54 }, bufferPages: true, info: { Title: `${clean(name) || "Legacy Lucy"} — Legacy Story Summary`, Author: "Haven Built Media" } });
  const F = registerFonts(doc);
  const chunks = [];
  doc.on("data", c => chunks.push(c));
  const done = new Promise(res => doc.on("end", () => res(Buffer.concat(chunks))));

  const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  // ---- cover band ----
  const bandH = 132;
  doc.rect(0, 0, doc.page.width, bandH).fill(C.navy);
  doc.font(F.xbold).fontSize(8.5).fillColor(C.rose).text("HAVEN BUILT MEDIA  ·  LEGACY STORY SUMMARY", L, 38, { characterSpacing: 1.6 });
  doc.font(F.black).fontSize(26).fillColor(C.white).text(clean(name || "Your Story").toUpperCase(), L, 56, { width: W, lineGap: -2 });
  // "Name | Agency" line: drop the name part, it's already the headline.
  const parts = s.sub ? s.sub.split("|").map(x => x.trim()) : [];
  const sub = parts.length > 1 && clean(name) && parts[0].toLowerCase() === clean(name).toLowerCase() ? parts.slice(1).join("  ·  ") : parts.join("  ·  ");
  if (sub) doc.font(F.reg).fontSize(10.5).fillColor(C.warm).text(sub, L, doc.y + 4, { width: W });
  doc.y = bandH + 28;

  const sectionHeader = (title) => {
    ensure(70);
    doc.moveDown(0.6);
    const y = doc.y;
    doc.font(F.xbold).fontSize(12).fillColor(C.navy).text(title.toUpperCase(), L, y, { width: W, characterSpacing: 0.8 });
    const ly = doc.y + 4;
    doc.moveTo(L, ly).lineTo(L + W, ly).lineWidth(2).strokeColor(C.rose).stroke();
    doc.y = ly + 10;
  };

  for (const sec of s.sections) {
    if (sec.title) sectionHeader(sec.title);
    for (const it of sec.items) {
      if (it.quote) {
        doc.font(F.med).fontSize(15);
        const h = doc.heightOfString(it.quote, { width: W - 36, lineGap: 3 }) + 28;
        ensure(h + 8);
        const y = doc.y;
        doc.roundedRect(L, y, W, h, 8).fill(C.warm);
        doc.rect(L, y, 4, h).fill(C.rose);
        doc.font(F.med).fontSize(15).fillColor(C.navy).text(it.quote, L + 20, y + 14, { width: W - 36, lineGap: 3 });
        doc.y = y + h + 12;
        continue;
      }
      if (it.label) {
        doc.font(F.reg).fontSize(10.5);
        ensure(doc.heightOfString(it.value || "—", { width: W, lineGap: 2 }) + 22);
        doc.font(F.bold).fontSize(7.5).fillColor(C.slate).text(it.label.toUpperCase(), L, doc.y, { width: W, characterSpacing: 0.9 });
        doc.moveDown(0.15);
        doc.font(F.reg).fontSize(10.5).fillColor(C.navy).text(it.value || "—", L, doc.y, { width: W, lineGap: 2 });
        doc.moveDown(0.55);
        continue;
      }
      doc.font(F.reg).fontSize(10.5);
      ensure(doc.heightOfString(it.text, { width: W, lineGap: 2 }) + 10);
      doc.font(F.reg).fontSize(10.5).fillColor(C.navy).text(it.text, L, doc.y, { width: W, lineGap: 2 });
      doc.moveDown(0.55);
    }
  }

  // ---- what happens next ----
  const boxH = 86;
  ensure(boxH + 24);
  doc.moveDown(0.8);
  const by = doc.y;
  doc.roundedRect(L, by, W, boxH, 10).fill(C.navy);
  doc.font(F.xbold).fontSize(9).fillColor(C.rose).text("WHAT HAPPENS NEXT", L + 20, by + 16, { characterSpacing: 1.4 });
  doc.font(F.reg).fontSize(11).fillColor(C.white).text("The Haven Built team uses this to map out your interview and shoot plan. We'll follow up to finalize logistics, people on camera, props, and locations. No script, no memorizing. Just show up as you.", L + 20, by + 32, { width: W - 40, lineGap: 2 });

  // ---- footer on every page ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // let the footer sit below the text area without forcing a new page
    const fy = doc.page.height - 36;
    doc.moveTo(L, fy - 8).lineTo(L + W, fy - 8).lineWidth(0.5).strokeColor(C.rule).stroke();
    doc.font(F.bold).fontSize(7.5).fillColor(C.slate).text("HAVEN BUILT MEDIA  ·  LEGACY LUCY", L, fy, { characterSpacing: 1, lineBreak: false });
    doc.font(F.reg).fontSize(7.5).fillColor(C.slate).text(`${i + 1} / ${range.count}`, L, fy, { width: W, align: "right", lineBreak: false });
  }

  doc.end();
  return done;
}

export function pdfFilename(name) {
  const base = clean(name || "Legacy Lucy").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") || "Legacy";
  return `${base}-Legacy-Story-Summary.pdf`;
}
