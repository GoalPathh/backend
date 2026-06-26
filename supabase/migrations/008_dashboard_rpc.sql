-- Create an RPC function to offload dashboard progress queries to the database
CREATE OR REPLACE FUNCTION get_dashboard_progress(target_user_id UUID, seven_days_ago DATE, today DATE)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    result json;
BEGIN
    SELECT json_build_object(
        'completedLast7', (
            SELECT count(*) 
            FROM public.habit_completions 
            WHERE user_id = target_user_id AND completed = true AND completion_date >= seven_days_ago
        ),
        'missedLast7', (
            SELECT count(*) 
            FROM public.habit_completions 
            WHERE user_id = target_user_id AND completed = false AND completion_date >= seven_days_ago
        ),
        'totalCompletions', (
            SELECT count(*) 
            FROM public.habit_completions 
            WHERE user_id = target_user_id AND completed = true
        ),
        'activeGoals', (
            SELECT count(*) 
            FROM public.goals 
            WHERE user_id = target_user_id
        ),
        'streakRows', COALESCE((
            SELECT json_agg(completion_date) 
            FROM (
                SELECT DISTINCT completion_date 
                FROM public.habit_completions 
                WHERE user_id = target_user_id AND completed = true AND completion_date <= today
                ORDER BY completion_date DESC 
                LIMIT 60
            ) as streak_dates
        ), '[]'::json),
        'profile', (
            SELECT row_to_json(p) 
            FROM (
                SELECT xp, streak_days, level 
                FROM public.profiles 
                WHERE id = target_user_id
            ) p
        )
    ) INTO result;
    
    RETURN result;
END;
$$;
