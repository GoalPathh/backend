-- Cooldown table: prevents same user from receiving multiple proactive interventions within 24h
create table if not exists public.ai_intervention_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid references public.goals(id) on delete cascade,
  intervention_type text not null default 'stagnant_reminder',
  created_at timestamptz not null default now()
);

-- Simple composite index for cooldown lookups (no IMMUTABLE requirement)
create index if not exists intervention_log_user_created_idx
  on public.ai_intervention_log(user_id, created_at desc);

alter table public.ai_intervention_log enable row level security;

-- Service role bypasses RLS so admin client can write.
drop policy if exists "intervention_log_admin_only" on public.ai_intervention_log;
drop policy if exists "intervention_log_no_user_access" on public.ai_intervention_log;
create policy "intervention_log_no_user_access" on public.ai_intervention_log
  for all using (false) with check (false);
