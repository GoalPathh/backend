-- Tambahkan kolom tracking kuota untuk AI Coach Chat
alter table public.user_preferences 
add column if not exists coach_quota_used integer not null default 0,
add column if not exists coach_quota_reset_at timestamptz;
