# Existing Vendor Photo Invite — Deployment and Test Checklist

This feature lets an administrator send a private photo-upload link to an already-approved, active vendor. Vendors do not need a new account or an `owner_id` association.

## What it does

- Admin generates a private link from Admin → Vendor Registrations.
- A new link revokes any earlier active link for the same vendor.
- Link expires after 30 days and accepts up to five photos.
- The token is random, high-entropy and stored only as a SHA-256 hash.
- The vendor page does not require login.
- Only JPG, PNG and WebP files up to 5 MB each are accepted; the server checks the file signature.
- Uploads go into the existing private `vendor-photo-review` bucket.
- Photos create pending rows in `vendor_photo_submissions`.
- Existing Admin → Vendor Photo Review approval flow publishes approved photos to the public vendor gallery.
- Existing vendor status, approval, listing data and owner_id are not changed.

## Deployment order (after review)

1. Apply `supabase/migrations/20261126000100_vendor_photo_invite_links.sql` to the PahadiWedding Supabase project.
2. Deploy the admin-only link issuer with JWT verification enabled:

   ```bash
   supabase functions deploy create-vendor-photo-upload-link
   ```

3. Deploy the public bearer-link upload endpoint with JWT verification disabled. The function validates the high-entropy link token itself:

   ```bash
   supabase functions deploy submit-vendor-photo-invite --no-verify-jwt
   ```

4. Confirm the Edge Functions have the normal Supabase server environment variables available (`SUPABASE_URL` and a server secret key). Never put the service-role/secret key in the browser.
5. Deploy the website branch only after the database migration and both functions are ready.

## Admin test

1. Sign in to the existing PahadiWedding Admin.
2. Open Vendor Registrations.
3. Choose one existing approved and active vendor.
4. Click Generate secure upload link.
5. Confirm that the link is generated and that the WhatsApp message is prefilled. The admin must press Send in WhatsApp; no message is sent automatically.
6. Open the link in a private/incognito browser window. It should show the correct vendor name without requiring login.
7. Upload one test image. It should appear under Admin → Vendor Photo Review with Pending status.
8. Approve it. Confirm it appears on that vendor's public profile and that the original vendor approval status is unchanged.
9. Generate a second link and verify the first link is rejected.
10. Verify expired/revoked links, wrong MIME types, oversized files, non-image file signatures and uploads after the five-photo limit are rejected.

## Safety notes

- Do not publish photos automatically. Admin review remains mandatory.
- Send the link only to the vendor's existing verified contact. Anyone who receives the link can use its remaining upload allowance, so the vendor should not post it publicly.
- Generating a replacement link revokes the previous link.
- This branch contains code and a migration only. It does not apply the migration, deploy Edge Functions or change production data by itself.
