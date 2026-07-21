alter table public.events
  add column if not exists recurrence_until text;
alter table public.events
  add column if not exists recurrence_exceptions jsonb not null default '[]'::jsonb;
