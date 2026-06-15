-- Goal milestones: AI-generated checkpoints user can mark done to drive goal.progress
create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) >= 3 and length(title) <= 200),
  target_date timestamptz,
  sort_order integer not null default 0 check (sort_order >= 0 and sort_order <= 50),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists goal_milestones_goal_idx on public.goal_milestones(goal_id, sort_order);
create index if not exists goal_milestones_user_idx on public.goal_milestones(user_id);

alter table public.goal_milestones enable row level security;

drop policy if exists "goal_milestones_owner" on public.goal_milestones;
create policy "goal_milestones_owner" on public.goal_milestones
  for all
  using (auth.uid()=user_id)
  with check (auth.uid()=user_id);
