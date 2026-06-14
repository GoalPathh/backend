import { app } from "./app.js"; import { config } from "./config.js";
import { initGoalMonitorJob } from "./jobs/goalMonitor.js";

initGoalMonitorJob();

app.listen(config.port,()=>console.log(`GoalPath API listening on http://localhost:${config.port}`));
