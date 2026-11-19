ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS privacy jsonb NOT NULL
  DEFAULT '{"personalizedCoach": true}'::jsonb;

UPDATE public.user_preferences
SET privacy = '{"personalizedCoach": true}'::jsonb
WHERE privacy IS NULL;
