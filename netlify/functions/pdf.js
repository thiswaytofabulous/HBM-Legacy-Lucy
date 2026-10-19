// Legacy Lucy — "Download PDF". The page posts the summary text it's showing and gets back the same
// branded PDF that's attached to the summary emails (built in netlify/lib/summary-pdf.js).
import { buildSummaryPDF, pdfFilename } from "../lib/summary-pdf.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  let body;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const summary = String(body.summary || "");
  if (!summary.trim() || summary.length > 60000) return new Response("Missing or oversized summary", { status: 400 });
  try {
    const buf = await buildSummaryPDF({ summary, name: body.name });
    return new Response(buf, { headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFilename(body.name)}"`,
      "Cache-Control": "no-store"
    } });
  } catch (e) {
    return new Response("Could not build PDF: " + String(e && e.message || e), { status: 500 });
  }
};
