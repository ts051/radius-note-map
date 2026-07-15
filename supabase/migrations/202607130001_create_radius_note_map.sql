create extension if not exists pgcrypto with schema extensions;

create table if not exists public.radius_note_places (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  name text not null check (char_length(name) between 1 and 60),
  show_name boolean not null default true,
  radius integer not null check (radius between 10 and 50000),
  memo text not null default '' check (char_length(memo) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.radius_note_places enable row level security;

create table if not exists public.radius_note_settings (
  singleton boolean primary key default true check (singleton),
  password_hash text not null,
  auth_version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.radius_note_settings enable row level security;

insert into public.radius_note_settings (singleton, password_hash)
values (true, extensions.crypt('test', extensions.gen_salt('bf')))
on conflict (singleton) do nothing;

create table if not exists public.radius_note_login_attempts (
  client_key text primary key,
  failures integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.radius_note_login_attempts enable row level security;

create or replace function public.radius_note_verify_password(candidate text)
returns table (valid boolean, version integer)
language sql
security definer
set search_path = public, extensions
as $$
  select
    password_hash = extensions.crypt(candidate, password_hash),
    auth_version
  from public.radius_note_settings
  where singleton = true;
$$;

create or replace function public.radius_note_change_password(new_password text)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  next_version integer;
begin
  if char_length(new_password) < 4 or char_length(new_password) > 128 then
    raise exception 'Password must contain 4 to 128 characters';
  end if;

  update public.radius_note_settings
  set password_hash = extensions.crypt(new_password, extensions.gen_salt('bf')),
      auth_version = auth_version + 1,
      updated_at = now()
  where singleton = true
  returning auth_version into next_version;

  return next_version;
end;
$$;

revoke all on table public.radius_note_places from anon, authenticated;
revoke all on table public.radius_note_settings from anon, authenticated;
revoke all on table public.radius_note_login_attempts from anon, authenticated;
revoke execute on function public.radius_note_verify_password(text) from public, anon, authenticated;
revoke execute on function public.radius_note_change_password(text) from public, anon, authenticated;
grant execute on function public.radius_note_verify_password(text) to service_role;
grant execute on function public.radius_note_change_password(text) to service_role;

