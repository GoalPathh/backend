-- Auto-recompute goals.progress when habit_completions change
-- Progress = (actual_completions / expected_completions) * 100
-- where expected_completions = habits_count * days_since_start_date

create or replace function public.recompute_goal_progress(p_goal_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_start_date timestamptz;
  v_start_day date;
  v_today date;
  v_total_habits int;
  v_eligible_days int;
  v_expected_completions int;
  v_actual_completions int;
  v_new_progress numeric(5,2);
begin
  -- Find owning user + start_date
  select user_id, start_date
    into v_user_id, v_start_date
    from public.goals
    where id = p_goal_id;

  if v_user_id is null then return; end if;

  -- Count habits for this goal
  select count(*) into v_total_habits from public.habits where goal_id = p_goal_id;
  if v_total_habits = 0 then
    update public.goals set progress = 0, updated_at = now() where id = p_goal_id;
    return;
  end if;

  -- Compute eligible days from start_date up to today (min 1)
  v_start_day := v_start_date::date;
  v_today := current_date;
  v_eligible_days := (v_today - v_start_day) + 1;
  if v_eligible_days < 1 then v_eligible_days := 1; end if;

  -- Actual completions in eligible window
  select count(*) into v_actual_completions
    from public.habit_completions hc
    join public.habits h on h.id = hc.habit_id
    where h.goal_id = p_goal_id
      and hc.completed = true
      and hc.completion_date >= v_start_day
      and hc.completion_date <= v_today;

  v_expected_completions := v_total_habits * v_eligible_days;
  if v_expected_completions = 0 then v_new_progress := 0;
  else v_new_progress := least(100, round(100.0 * v_actual_completions / v_expected_completions, 2));
  end if;

  update public.goals
     set progress = v_new_progress,
         updated_at = now()
   where id = p_goal_id;
end;
$$;

create or replace function public.trg_habit_completion_recompute()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_goal_id uuid;
begin
  if (tg_op = 'DELETE') then
    select goal_id into v_goal_id from public.habits where id = old.habit_id;
  else
    select goal_id into v_goal_id from public.habits where id = new.habit_id;
  end if;

  if v_goal_id is not null then
    perform public.recompute_goal_progress(v_goal_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_habit_completion_update on public.habit_completions;
create trigger trg_habit_completion_update
after insert or update or delete on public.habit_completions
for each row execute function public.trg_habit_completion_recompute();
