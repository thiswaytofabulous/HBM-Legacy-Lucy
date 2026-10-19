// Legacy Lucy — serves back a file uploaded via the paperclip, so chat bubbles and the admin
// view can link straight to it (e.g. /.netlify/functions/download?id=...).
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400, headers: CORS });

  try {
    const store = getStore("lucy-uploads");
    const result = await store.getWithMetadata(id, { type: "arrayBuffer" });
    if (!result) return new Response("Not found", { status: 404, headers: CORS });
    const { data, metadata } = result;
    const filename = (metadata && metadata.filename) || "file";
    const contentType = (metadata && metadata.contentType) || "application/octet-stream";
    return new Response(data, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"`
      }
    });
  } catch (e) {
    return new Response("Error: " + String(e.message || e), { status: 500, headers: CORS });
  }
};
