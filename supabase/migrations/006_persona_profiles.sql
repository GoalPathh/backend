-- AI persona: per-user personality profile aggregated from habit patterns.
-- Deterministic scoring + adjustment advice consumed by /progress + coach system prompt.

create table if not exists public.persona_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  archetype text not null,
  traits jsonb not null,
  evidence jsonb not null,
  window_days int not null default 14,
  computed_at timestamptz not null default now()
);

create index if not exists persona_profiles_archetype_idx
  on public.persona_profiles(archetype);

alter table public.persona_profiles enable row level security;

drop policy if exists "persona_own" on public.persona_profiles;
create policy "persona_own" on public.persona_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
