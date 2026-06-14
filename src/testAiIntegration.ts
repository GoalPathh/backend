// Vercel AI SDK has been uninstalled in favor of custom llm-client
import { DashboardRepository } from "./repositories.js";
import { config } from "./config.js";

async function runTest() {
  console.log("=== White-box Test: AI Integration ===");
  const testUserId = "841ed7c6-ca3c-4e4c-b007-3742cfacff46";
  
  try {
    const dashRepo = new DashboardRepository();
    const context = await dashRepo.getUserContextSnapshot(testUserId);
    console.log("[Test 1] RAG Database connection OK.");

    const systemPrompt = `You are a proactive AI Coach for GoalPath.
Current User Data:
${JSON.stringify(context, null, 2)}
Rules:
- Give a brief, encouraging reply.`;

    console.log("\n[Test 2] Calling LLM...");
    
    // Testing the new llm-client architecture
    const { agentChat } = await import('./llm-client.js');
    const aiText = await agentChat(systemPrompt, [{ role: 'user', content: 'Can you review my progress?' }], testUserId);
    
    console.log("LLM Response: " + aiText);
    
    console.log("\n\n=== White-box Test Completed Successfully! ===");
  } catch (err: any) {
    console.error("\n[Error in Test Execution]:", err.message || err);
  }
}

runTest();
