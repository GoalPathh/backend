import { supabaseAdmin } from "./supabase.js";

const tables = ["profiles", "user_preferences", "goals", "habits", "habit_completions", "coach_sessions", "coach_messages"];
let failed = false;

for (const table of tables) {
  const { error } = await supabaseAdmin.from(table).select("*", { head: true, count: "exact" }).limit(1);
  if (error) {
    failed = true;
    console.error(`${table}: ${error.message}`);
  } else {
    console.log(`${table}: ok`);
  }
}

if (failed) process.exitCode = 1;
