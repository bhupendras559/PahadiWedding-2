import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://pahadiwedding.in",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const { data: userData, error: userError } = await caller.auth.getUser(token);
    if (userError || !userData.user?.id || (userData.user.email || "").toLowerCase() !== "bhupendras559@gmail.com") {
      return new Response(JSON.stringify({ error: "Admin authentication required" }), { status: 403, headers: cors });
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: adminRow, error: adminError } = await admin.from("admin_users").select("user_id").eq("user_id", userData.user.id).maybeSingle();
    if (adminError || !adminRow) return new Response(JSON.stringify({ error: "Admin permission denied" }), { status: 403, headers: cors });

    const body = await req.json();
    const vendorId = String(body.vendor_id || "");
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(vendorId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "Valid vendor ID and email are required" }), { status: 400, headers: cors });
    }

    const { data: vendor, error: vendorError } = await admin.from("vendors").select("id,business_name,owner_id,email,status").eq("id", vendorId).single();
    if (vendorError || !vendor) return new Response(JSON.stringify({ error: "Vendor not found" }), { status: 404, headers: cors });
    if (vendor.status !== "approved") return new Response(JSON.stringify({ error: "Approve the vendor listing before creating login access" }), { status: 409, headers: cors });
    if (vendor.owner_id) return new Response(JSON.stringify({ error: "This vendor already has a linked login account" }), { status: 409, headers: cors });

    const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: "https://pahadiwedding.in/vendor-photo-upload.html",
      data: { account_type: "vendor", vendor_id: vendor.id, business_name: vendor.business_name },
    });
    if (inviteError || !inviteData.user) {
      return new Response(JSON.stringify({ error: inviteError?.message || "Invitation could not be created" }), { status: 400, headers: cors });
    }

    const { error: updateError } = await admin.from("vendors").update({ owner_id: inviteData.user.id, email, updated_at: new Date().toISOString() }).eq("id", vendor.id).is("owner_id", null);
    if (updateError) {
      return new Response(JSON.stringify({ error: "Invitation created but vendor linking failed. Admin must reconcile this account before retrying." }), { status: 500, headers: cors });
    }

    return new Response(JSON.stringify({ success: true, business_name: vendor.business_name, email, message: "Invitation sent. Vendor must set a password from the email link." }), { status: 200, headers: cors });
  } catch (_error) {
    return new Response(JSON.stringify({ error: "Unexpected server error" }), { status: 500, headers: cors });
  }
});