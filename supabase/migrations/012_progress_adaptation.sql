CREATE TABLE IF NOT EXISTS public.habit_adaptation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  goal_id uuid REFERENCES public.goals(id) ON DELETE SET NULL,
  habit_id uuid REFERENCES public.habits(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL,
  recommendation jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS habit_adaptation_history_user_created_idx
  ON public.habit_adaptation_history(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS habit_adaptation_history_user_goal_idx
  ON public.habit_adaptation_history(user_id, goal_id, created_at DESC);

ALTER TABLE public.habit_adaptation_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "habit_adaptation_history_owner" ON public.habit_adaptation_history;
CREATE POLICY "habit_adaptation_history_owner"
  ON public.habit_adaptation_history
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
