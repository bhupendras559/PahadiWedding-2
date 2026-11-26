import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeadersFor = (origin: string | null) => {
  const allowed = origin === "https://pahadiwedding.in"
    || origin === "https://www.pahadiwedding.in"
    || !!origin && /^https:\/\/pahadi-wedding-2-[a-z0-9-]+\.vercel\.app$/i.test(origin);
  return {
    allowed,
    headers: {
      "Access-Control-Allow-Origin": allowed && origin ? origin : "https://pahadiwedding.in",
      "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
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

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, "0")).join("");
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

    const authorization = req.headers.get("authorization") || "";
    const accessToken = authorization.replace(/^Bearer\s+/i, "");
    if (!accessToken) return json({ error: "Admin sign-in required" }, 401, cors.headers);

    const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
    if (authError || !authData.user) return json({ error: "Admin session is invalid" }, 401, cors.headers);

    const { data: adminRow, error: adminError } = await admin
      .from("admin_users")
      .select("user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (adminError || !adminRow) return json({ error: "Administrator permission required" }, 403, cors.headers);

    const body = await req.json().catch(() => null);
    const vendorId = typeof body?.vendor_id === "string" ? body.vendor_id : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(vendorId)) {
      return json({ error: "A valid vendor ID is required" }, 400, cors.headers);
    }

    const { data: vendor, error: vendorError } = await admin
      .from("vendors")
      .select("id,business_name,phone,status,is_active")
      .eq("id", vendorId)
      .maybeSingle();
    if (vendorError || !vendor) return json({ error: "Vendor record not found" }, 404, cors.headers);
    if (vendor.status !== "approved" || vendor.is_active !== true) {
      return json({ error: "Upload links can only be created for approved active vendors" }, 409, cors.headers);
    }
    if (!vendor.phone || !String(vendor.phone).trim()) {
      return json({ error: "Vendor phone number is missing; verify contact details first" }, 409, cors.headers);
    }

    const token = randomToken();
    const tokenHash = await sha256(token);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { error: insertError } = await admin.from("vendor_photo_upload_links").insert({
      vendor_id: vendor.id,
      token_hash: tokenHash,
      created_by: authData.user.id,
      expires_at: expiresAt,
      max_uploads: 5,
      uploads_count: 0,
    });
    if (insertError) throw insertError;

    // A freshly generated link replaces any earlier link for this vendor.
    const { error: revokeError } = await admin
      .from("vendor_photo_upload_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("vendor_id", vendor.id)
      .neq("token_hash", tokenHash)
      .is("revoked_at", null);
    if (revokeError) {
      await admin.from("vendor_photo_upload_links").update({ revoked_at: new Date().toISOString() }).eq("token_hash", tokenHash);
      throw revokeError;
    }

    const siteOrigin = origin || "https://pahadiwedding.in";
    const uploadUrl = siteOrigin + "/vendor-photo-invite.html#" + token;
    return json({
      success: true,
      vendor_name: vendor.business_name,
      upload_url: uploadUrl,
      expires_at: expiresAt,
      max_uploads: 5,
    }, 200, cors.headers);
  } catch (error) {
    console.error("create-vendor-photo-upload-link failed:", error);
    return json({ error: "Could not create the secure upload link" }, 500, cors.headers);
  }
});
