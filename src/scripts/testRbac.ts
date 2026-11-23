import fs from "fs";
import path from "path";

const API_BASE = "http://localhost:4000/api/v1";

interface TestResult {
  id: string;
  name: string;
  actor: string;
  method: string;
  endpoint: string;
  expectedStatus: number;
  actualStatus: number;
  status: "PASS" | "FAIL";
  responseExcerpt: string;
}

async function request(
  method: string,
  endpoint: string,
  body?: any,
  token?: string
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, data };
}

async function runTests() {
  console.log("=== STARTING GOALPATH RBAC & ACCESS CONTROL TEST SUITE ===");
  const results: TestResult[] = [];
  const timestamp = Date.now();

  const userAEmail = `user_a_${timestamp}@test.com`;
  const userBEmail = `user_b_${timestamp}@test.com`;
  const adminEmail = "admin@goalpath.app";
  const password = "Password123!";
  const adminPassword = "AdminPass123!";

  // 1. Setup: Register User A
  console.log("Registering User A...");
  const regARes = await request("POST", "/auth/register", {
    email: userAEmail,
    password,
    name: "User Alice",
  });
  const tokenA = regARes.data?.data?.session?.access_token;
  const userAId = regARes.data?.data?.user?.id;

  // 2. Setup: Register User B
  console.log("Registering User B...");
  const regBRes = await request("POST", "/auth/register", {
    email: userBEmail,
    password,
    name: "User Bob",
  });
  const tokenB = regBRes.data?.data?.session?.access_token;
  const userBId = regBRes.data?.data?.user?.id;

  // 3. Setup: Login Admin
  console.log("Logging in as Admin...");
  const adminLoginRes = await request("POST", "/auth/login", {
    email: adminEmail,
    password: adminPassword,
  });
  const adminToken = adminLoginRes.data?.data?.session?.access_token;

  let goalAId = "";

  // ─── TC01: User A creates Goal (Expects 201) ───
  console.log("Running TC01: User A creates Goal...");
  const now = new Date();
  const target = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const tc01Res = await request(
    "POST",
    "/goals",
    {
      title: "Belajar Keamanan Jaringan",
      category: "skills",
      period: "1month",
      startDate: now.toISOString(),
      targetDate: target.toISOString(),
      reminderEnabled: true,
      notificationPreference: "all",
      selectedHabits: [
        {
          title: "Baca RFC 1 jam",
          duration: 60,
          difficulty: "medium",
          schedule: {
            timeRange: "evening",
            activeDays: ["mon", "wed", "fri"],
            priority: "high",
          },
        },
      ],
    },
    tokenA
  );
  goalAId = tc01Res.data?.data?.id;
  results.push({
    id: "TC01",
    name: "User creates their own goal",
    actor: "USER (Alice)",
    method: "POST",
    endpoint: "/goals",
    expectedStatus: 201,
    actualStatus: tc01Res.status,
    status: tc01Res.status === 201 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc01Res.data).slice(0, 150),
  });

  // ─── TC02: User A updates own Goal (Expects 200) ───
  console.log("Running TC02: User A updates own Goal...");
  const tc02Res = await request(
    "PATCH",
    `/goals/${goalAId}`,
    {
      title: "Belajar Keamanan Jaringan & RBAC (Updated)",
      progress: 25,
    },
    tokenA
  );
  results.push({
    id: "TC02",
    name: "User updates their own goal",
    actor: "USER (Alice)",
    method: "PATCH",
    endpoint: `/goals/${goalAId}`,
    expectedStatus: 200,
    actualStatus: tc02Res.status,
    status: tc02Res.status === 200 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc02Res.data).slice(0, 150),
  });

  // ─── TC03: User A attempts to access Admin Users list (Expects 403 Forbidden) ───
  console.log("Running TC03: User A attempts to access /admin/users...");
  const tc03Res = await request("GET", "/admin/users", undefined, tokenA);
  results.push({
    id: "TC03",
    name: "Non-admin user blocked from admin endpoint",
    actor: "USER (Alice)",
    method: "GET",
    endpoint: "/admin/users",
    expectedStatus: 403,
    actualStatus: tc03Res.status,
    status: tc03Res.status === 403 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc03Res.data).slice(0, 150),
  });

  // ─── TC04: User B attempts to access Goal A of User A (Expects 404 Ownership Protection) ───
  console.log("Running TC04: User B attempts to access Goal A...");
  const tc04Res = await request("GET", `/goals/${goalAId}`, undefined, tokenB);
  results.push({
    id: "TC04",
    name: "User B denied access to User A's goal (Ownership check)",
    actor: "USER (Bob)",
    method: "GET",
    endpoint: `/goals/${goalAId}`,
    expectedStatus: 404,
    actualStatus: tc04Res.status,
    status: tc04Res.status === 404 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc04Res.data).slice(0, 150),
  });

  // ─── TC05: Admin accesses /admin/users (Expects 200 OK) ───
  console.log("Running TC05: Admin accesses /admin/users...");
  const tc05Res = await request("GET", "/admin/users", undefined, adminToken);
  results.push({
    id: "TC05",
    name: "Admin accesses admin user management list",
    actor: "ADMIN",
    method: "GET",
    endpoint: "/admin/users",
    expectedStatus: 200,
    actualStatus: tc05Res.status,
    status: tc05Res.status === 200 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc05Res.data).slice(0, 150),
  });

  // ─── TC06: Unauthenticated request to /goals (Expects 401 Unauthorized) ───
  console.log("Running TC06: Unauthenticated request to /goals...");
  const tc06Res = await request("GET", "/goals", undefined, undefined);
  results.push({
    id: "TC06",
    name: "Unauthenticated request rejected",
    actor: "ANONYMOUS",
    method: "GET",
    endpoint: "/goals",
    expectedStatus: 401,
    actualStatus: tc06Res.status,
    status: tc06Res.status === 401 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc06Res.data).slice(0, 150),
  });

  // ─── TC07: User A attempts privilege escalation via role update (Expects 403 Forbidden) ───
  console.log("Running TC07: User A attempts privilege escalation...");
  const tc07Res = await request(
    "PATCH",
    `/admin/users/${userAId}/role`,
    { role: "ADMIN" },
    tokenA
  );
  results.push({
    id: "TC07",
    name: "Non-admin blocked from self-escalating role",
    actor: "USER (Alice)",
    method: "PATCH",
    endpoint: `/admin/users/${userAId}/role`,
    expectedStatus: 403,
    actualStatus: tc07Res.status,
    status: tc07Res.status === 403 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc07Res.data).slice(0, 150),
  });

  // ─── TC08: Invalid/Expired JWT Token rejected (Expects 401 Unauthorized) ───
  console.log("Running TC08: Invalid JWT Token rejected...");
  const tc08Res = await request("GET", "/goals", undefined, "invalid.bearer.token");
  results.push({
    id: "TC08",
    name: "Forged or expired JWT rejected",
    actor: "ATTACKER (Invalid Token)",
    method: "GET",
    endpoint: "/goals",
    expectedStatus: 401,
    actualStatus: tc08Res.status,
    status: tc08Res.status === 401 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc08Res.data).slice(0, 150),
  });

  // ─── TC09: Admin accesses system stats (Expects 200 OK) ───
  console.log("Running TC09: Admin accesses system stats...");
  const tc09Res = await request("GET", "/admin/stats", undefined, adminToken);
  results.push({
    id: "TC09",
    name: "Admin accesses system administrative statistics",
    actor: "ADMIN",
    method: "GET",
    endpoint: "/admin/stats",
    expectedStatus: 200,
    actualStatus: tc09Res.status,
    status: tc09Res.status === 200 ? "PASS" : "FAIL",
    responseExcerpt: JSON.stringify(tc09Res.data).slice(0, 150),
  });

  console.log("\n=== TEST EXECUTION SUMMARY ===");
  console.table(results.map(r => ({ ID: r.id, Test: r.name, Actor: r.actor, Expected: r.expectedStatus, Actual: r.actualStatus, Status: r.status })));

  // Write results to markdown
  const docsDir = path.resolve(process.cwd(), "docs/access-control");
  const testResultsPath = path.join(docsDir, "test-results.md");

  let mdContent = `# HASIL PENGUJIAN ROLE-BASED ACCESS CONTROL (RBAC) GOALPATH\n\n`;
  mdContent += `**Waktu Eksekusi**: ${new Date().toISOString()}\n`;
  mdContent += `**Lingkungan**: Development (Node.js + Express 5 + MySQL/Prisma + JWT)\n\n`;
  mdContent += `| Test ID | Skenario Pengujian | Aktor | Method | Endpoint | Expected | Actual | Hasil |\n`;
  mdContent += `|---|---|---|---|---|---|---|---|\n`;

  for (const r of results) {
    mdContent += `| ${r.id} | ${r.name} | ${r.actor} | ${r.method} | \`${r.endpoint}\` | ${r.expectedStatus} | ${r.actualStatus} | **${r.status}** |\n`;
  }

  mdContent += `\n## Detail Respons HTTP Setiap Test Case\n\n`;
  for (const r of results) {
    mdContent += `### [${r.id}] ${r.name}\n`;
    mdContent += `- **Aktor**: ${r.actor}\n`;
    mdContent += `- **Request**: \`${r.method} ${r.endpoint}\`\n`;
    mdContent += `- **Status**: \`${r.actualStatus}\` (Expected: \`${r.expectedStatus}\`) -> **${r.status}**\n`;
    mdContent += `- **Response Snippet**:\n\`\`\`json\n${r.responseExcerpt}\n\`\`\`\n\n`;
  }

  fs.writeFileSync(testResultsPath, mdContent);
  console.log(`\nTest results written to: ${testResultsPath}`);
}

runTests().catch(console.error);
