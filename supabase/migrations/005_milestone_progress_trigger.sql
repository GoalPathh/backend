-- After milestone changes, recompute goal.progress including milestone contributions.
-- Strategy:
--   base_progress = recalc from habit_completions (via recompute_goal_progress)
--   + each completed milestone contributes +2 percentage points (cap 100)

create or replace function public.trg_milestone_recompute()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_goal_id uuid;
  v_done_count int;
  v_milestone_bonus numeric(5,2);
begin
  if (tg_op = 'DELETE') then
    v_goal_id := old.goal_id;
  else
    v_goal_id := new.goal_id;
  end if;

  perform public.recompute_goal_progress(v_goal_id);

  -- Add per-milestone bonus on top of base progress (cap 100)
  select count(*) into v_done_count from public.goal_milestones where goal_id = v_goal_id and completed_at is not null;
  v_milestone_bonus := v_done_count * 2;

  update public.goals
    set progress = least(100, progress + v_milestone_bonus),
        updated_at = now()
  where id = v_goal_id;

  return null;
end;
$$;

drop trigger if exists trg_goal_milestone_change on public.goal_milestones;
create trigger trg_goal_milestone_change
after insert or update of completed_at or delete on public.goal_milestones
for each row execute function public.trg_milestone_recompute();
