// Legacy Lucy — file upload (the paperclip). Clients can share photos of a space they want to film in,
// logos, or inspiration — this lets them attach files right in the chat
// instead of being told to email them separately. Files are stored raw in their own Netlify Blobs
// store (kept separate from the session-history store so big base64 payloads never bloat/slow down
// every regular save() call), keyed so they can be pulled back per-session for the admin view.
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function slug(key) {
  return String(key || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  const { sessionKey, filename, contentType, dataBase64 } = body;
  if (!sessionKey || !filename || !dataBase64) return json({ error: "Missing sessionKey, filename, or file data" }, 400);

  // Netlify function request bodies cap out around 6MB, and base64 inflates the raw file size by
  // ~33% — so anything much past ~4MB of actual file will fail before it even reaches this check.
  // This is a secondary guard in case a larger payload somehow gets through.
  const approxBytes = Math.floor(dataBase64.length * 0.75);
  if (approxBytes > 8 * 1024 * 1024) return json({ error: "File too large — please keep uploads under 8MB." }, 413);

  try {
    const store = getStore("lucy-uploads");
    const id = `${slug(sessionKey)}_${Date.now()}_${slug(filename)}`;
    const buffer = Buffer.from(dataBase64, "base64");
    await store.set(id, buffer, {
      metadata: {
        filename,
        contentType: contentType || "application/octet-stream",
        sessionKey,
        uploadedAt: new Date().toISOString()
      }
    });
    return json({ success: true, id, filename });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};
