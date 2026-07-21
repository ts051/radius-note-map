alter table public.radius_note_places
add column if not exists color text not null default '#e87b52'
check (color ~ '^#[0-9a-fA-F]{6}$');
