import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 5;

const corsHeadersFor = (origin: string | null) => {
  const allowed = origin === "https://pahadiwedding.in"
    || origin === "https://www.pahadiwedding.in"
    || !!origin && /^https:\/\/pahadi-wedding-2-[a-z0-9-]+\.vercel\.app$/i.test(origin);
  return {
    allowed,
    headers: {
      "Access-Control-Allow-Origin": allowed && origin ? origin : "https://pahadiwedding.in",
      "Access-Control-Allow-Headers": "apikey, x-client-info, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    },
  };
};

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (typeof keys.default === "string") return keys.default;
  } catch { /* handled below */ }
  throw new Error("Supabase server secret is not configured");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, "0")).join("");
}

function validImageSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (mime === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeadersFor(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors.headers });
  if (!cors.allowed) return json({ error: "Origin not allowed" }, 403, cors.headers);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors.headers);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    if (!url) throw new Error("Supabase URL is not configured");
    const admin = createClient(url, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await req.json().catch(() => null);
      if (body?.action !== "inspect" || typeof body?.token !== "string") {
        return json({ error: "Invalid request" }, 400, cors.headers);
      }
      const tokenHash = await sha256(body.token);
      const { data: link, error: linkError } = await admin
        .from("vendor_photo_upload_links")
        .select("vendor_id,expires_at,max_uploads,uploads_count,revoked_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (linkError || !link || link.revoked_at || new Date(link.expires_at).getTime() <= Date.now() || link.uploads_count >= link.max_uploads) {
        return json({ error: "This upload link is invalid, expired, or already used" }, 410, cors.headers);
      }
      const { data: vendor, error: vendorError } = await admin
        .from("vendors")
        .select("business_name,category,location,status,is_active")
        .eq("id", link.vendor_id)
        .maybeSingle();
      if (vendorError || !vendor || vendor.status !== "approved" || vendor.is_active !== true) {
        return json({ error: "This vendor upload link is no longer active" }, 410, cors.headers);
      }
      return json({
        valid: true,
        vendor_name: vendor.business_name,
        category: vendor.category,
        location: vendor.location,
        expires_at: link.expires_at,
        remaining_uploads: link.max_uploads - link.uploads_count,
        max_uploads: link.max_uploads,
      }, 200, cors.headers);
    }

    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "Use a photo upload form" }, 415, cors.headers);
    }

    const form = await req.formData();
    const token = form.get("token");
    const consent = form.get("consent");
    if (typeof token !== "string" || token.length < 40 || consent !== "yes") {
      return json({ error: "Upload link and photo permission confirmation are required" }, 400, cors.headers);
    }

    const photos = form.getAll("photos").filter((value): value is File => value instanceof File && value.size > 0);
    if (!photos.length || photos.length > MAX_FILES_PER_REQUEST) {
      return json({ error: "Choose between 1 and 5 photos per submission" }, 400, cors.headers);
    }

    const tokenHash = await sha256(token);
    const { data: link, error: linkError } = await admin
      .from("vendor_photo_upload_links")
      .select("vendor_id,expires_at,max_uploads,uploads_count,revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (linkError || !link || link.revoked_at || new Date(link.expires_at).getTime() <= Date.now()) {
      return json({ error: "This upload link is invalid or expired" }, 410, cors.headers);
    }
    if (link.uploads_count >= link.max_uploads) {
      return json({ error: "This upload link has reached its photo limit. Contact PahadiWedding for a fresh link." }, 409, cors.headers);
    }

    const { data: vendor, error: vendorError } = await admin
      .from("vendors")
      .select("business_name,status,is_active")
      .eq("id", link.vendor_id)
      .maybeSingle();
    if (vendorError || !vendor || vendor.status !== "approved" || vendor.is_active !== true) {
      return json({ error: "This vendor listing is not active for photo submissions" }, 410, cors.headers);
    }

    const uploaded: string[] = [];
    const failed: string[] = [];
    for (const file of photos) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > MAX_FILE_SIZE) {
        failed.push(file.name + ": JPG, PNG or WebP up to 5 MB only");
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!validImageSignature(bytes, file.type)) {
        failed.push(file.name + ": file content does not match its image type");
        continue;
      }

      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const storagePath = "invite/" + link.vendor_id + "/" + crypto.randomUUID() + "." + extension;
      const { error: uploadError } = await admin.storage
        .from("vendor-photo-review")
        .upload(storagePath, bytes, { contentType: file.type, cacheControl: "3600", upsert: false });
      if (uploadError) {
        failed.push(file.name + ": upload could not be stored");
        continue;
      }

      const { data: consumed, error: consumeError } = await admin.rpc("consume_vendor_photo_upload_link", {
        p_token_hash: tokenHash,
        p_storage_path: storagePath,
        p_original_filename: file.name,
        p_mime_type: file.type,
        p_file_size_bytes: file.size,
      });
      if (consumeError || !consumed?.length) {
        await admin.storage.from("vendor-photo-review").remove([storagePath]);
        failed.push(file.name + ": upload link expired or reached its limit");
        continue;
      }
      uploaded.push(file.name);
    }

    const { data: currentLink } = await admin
      .from("vendor_photo_upload_links")
      .select("max_uploads,uploads_count")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (!uploaded.length) {
      return json({ error: failed[0] || "No photos were accepted", failed }, 400, cors.headers);
    }

    return json({
      success: true,
      vendor_name: vendor.business_name,
      uploaded_count: uploaded.length,
      uploaded,
      failed,
      remaining_uploads: currentLink ? currentLink.max_uploads - currentLink.uploads_count : 0,
    }, 200, cors.headers);
  } catch (error) {
    console.error("submit-vendor-photo-invite failed:", error);
    return json({ error: "Photo upload could not be completed. Please try again or contact PahadiWedding." }, 500, cors.headers);
  }
});
