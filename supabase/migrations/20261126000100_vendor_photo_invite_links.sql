-- Secure, one-time-style upload links for existing approved vendors.
-- Tokens are stored only as SHA-256 hashes. Public clients cannot read or write this table.

create table if not exists public.vendor_photo_upload_links (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uploads integer not null default 5 check (max_uploads between 1 and 10),
  uploads_count integer not null default 0 check (uploads_count >= 0),
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint vendor_photo_upload_count_limit check (uploads_count <= max_uploads)
);

create index if not exists vendor_photo_upload_links_vendor_active_idx
  on public.vendor_photo_upload_links (vendor_id, expires_at)
  where revoked_at is null;

alter table public.vendor_photo_upload_links enable row level security;
revoke all on table public.vendor_photo_upload_links from public, anon, authenticated;
grant all on table public.vendor_photo_upload_links to service_role;

-- Called only by the server-side Edge Function using the service_role key.
-- SECURITY INVOKER is intentional: no privilege escalation is introduced.
create or replace function public.consume_vendor_photo_upload_link(
  p_token_hash text,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_file_size_bytes bigint
)
returns table (
  vendor_id uuid,
  business_name text,
  uploads_count integer,
  max_uploads integer
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_link record;
  v_new_count integer;
begin
  if p_token_hash is null or length(p_token_hash) <> 64 then
    raise exception 'invalid_or_expired_link';
  end if;

  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
     or p_file_size_bytes is null
     or p_file_size_bytes <= 0
     or p_file_size_bytes > 5242880 then
    raise exception 'invalid_photo_file';
  end if;

  select
    l.id,
    l.vendor_id,
    l.expires_at,
    l.max_uploads,
    l.uploads_count,
    l.revoked_at,
    v.business_name,
    v.status,
    v.is_active
  into v_link
  from public.vendor_photo_upload_links l
  join public.vendors v on v.id = l.vendor_id
  where l.token_hash = p_token_hash
  for update of l;

  if not found
     or v_link.revoked_at is not null
     or v_link.expires_at <= now()
     or v_link.status <> 'approved'
     or v_link.is_active is not true
     or v_link.uploads_count >= v_link.max_uploads then
    raise exception 'invalid_or_expired_link';
  end if;

  if p_storage_path is null
     or p_storage_path not like 'invite/' || v_link.vendor_id::text || '/%' then
    raise exception 'invalid_photo_path';
  end if;

  insert into public.vendor_photo_submissions (
    vendor_id,
    storage_path,
    original_filename,
    mime_type,
    file_size_bytes,
    status
  ) values (
    v_link.vendor_id,
    p_storage_path,
    left(coalesce(p_original_filename, 'vendor-photo'), 200),
    p_mime_type,
    p_file_size_bytes,
    'pending'
  );

  v_new_count := v_link.uploads_count + 1;

  update public.vendor_photo_upload_links
  set uploads_count = v_new_count,
      last_used_at = now()
  where id = v_link.id;

  return query
  select v_link.vendor_id, v_link.business_name, v_new_count, v_link.max_uploads;
end;
$$;

revoke all on function public.consume_vendor_photo_upload_link(text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.consume_vendor_photo_upload_link(text, text, text, text, bigint)
  to service_role;
