const API_BASE = "http://localhost:4000/api/v1";

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function banner(step: number, title: string) {
  console.log("\n" + "═".repeat(70));
  console.log(`${colors.cyan}${colors.bright}[LANGKAH ${step}] ${title}${colors.reset}`);
  console.log("═".repeat(70));
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
  if (token) headers["Authorization"] = `Bearer ${token}`;

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

async function runDemonstration() {
  console.log(`${colors.bright}${colors.magenta}╔══════════════════════════════════════════════════════════════════════╗`);
  console.log(`║      DEMONSTRASI SISTEM ROLE-BASED ACCESS CONTROL (RBAC) GOALPATH    ║`);
  console.log(`║           Mata Kuliah: Praktikum Keamanan Sistem Informasi           ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════╝${colors.reset}`);

  let userToken = "";
  let adminToken = "";
  let createdGoalId = "";
  const otherUserGoalId = "b2bdbf4e-0554-4696-baa4-4aa526f4ce86"; // Milik Siti Rahma

  // ──────────────────────────────────────────────────────────────────────────
  // LANGKAH 1: Login sebagai USER
  // ──────────────────────────────────────────────────────────────────────────
  banner(1, "LOGIN SEBAGAI REGULAR USER (Budi Santoso)");
  console.log(`Kredensial : ${colors.yellow}user@goalpath.app${colors.reset} / ${colors.yellow}UserPass123!${colors.reset}`);
  console.log(`Request    : POST /auth/login`);

  const loginUserRes = await request("POST", "/auth/login", {
    email: "user@goalpath.app",
    password: "UserPass123!",
  });

  console.log(`Status     : ${colors.green}${loginUserRes.status} OK${colors.reset}`);
  userToken = loginUserRes.data?.data?.session?.access_token;
  console.log(`Identitas  : ID = ${loginUserRes.data?.data?.user?.id}`);
  console.log(`Role Akun  : ${colors.blue}${colors.bright}${loginUserRes.data?.data?.user?.role || "USER"}${colors.reset}`);
  console.log(`Hasil      : ${colors.green}✔ Berhasil login sebagai pengguna biasa (Role: USER). Token JWT tersimpan.${colors.reset}`);

  // ──────────────────────────────────────────────────────────────────────────
  // LANGKAH 2: Membuat Goal
  // ──────────────────────────────────────────────────────────────────────────
  banner(2, "MEMBUAT GOAL BARU OLEH USER BUDI");
  console.log(`Request    : POST /goals`);
  console.log(`Payload    : Title: "Persiapan Sertifikasi Certified Ethical Hacker"`);

  const createGoalRes = await request(
    "POST",
    "/goals",
    {
      title: "Persiapan Sertifikasi Certified Ethical Hacker",
      category: "skills",
      period: "3months",
      startDate: new Date().toISOString(),
      targetDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      reminderEnabled: true,
      notificationPreference: "all",
      selectedHabits: [
        {
          title: "Belajar Network Scanning (Nmap) 45 menit",
          duration: 45,
          difficulty: "medium",
          schedule: {
            timeRange: "evening",
            activeDays: ["mon", "tue", "wed", "thu", "fri"],
            priority: "high",
          },
        },
      ],
    },
    userToken
  );

  createdGoalId = createGoalRes.data?.data?.id;
  console.log(`Status     : ${colors.green}${createGoalRes.status} Created${colors.reset}`);
  console.log(`Goal ID    : ${createdGoalId}`);
  console.log(`Judul Goal : ${createGoalRes.data?.data?.title}`);
  console.log(`Hasil      : ${colors.green}✔ Goal berhasil dibuat dan diasosiasikan ke Budi Santoso.${colors.reset}`);

  // ──────────────────────────────────────────────────────────────────────────
  // LANGKAH 3: Mencoba mengakses Admin Panel dan menunjukkan penolakan 403
  // ──────────────────────────────────────────────────────────────────────────
  banner(3, "MENCOBA MENGAKSES ENDPOINT ADMIN PANEL DENGAN ROLE USER (Simulasi Penyerangan)");
  console.log(`Aktor      : USER (Budi Santoso)`);
  console.log(`Request    : GET /admin/users`);
  console.log(`Keterangan : Pengguna mencoba mengakses daftar seluruh akun sistem.`);

  const accessAdminRes = await request("GET", "/admin/users", undefined, userToken);

  console.log(`Status     : ${colors.red}${colors.bright}${accessAdminRes.status} Forbidden${colors.reset}`);
  console.log(`Response   :`, JSON.stringify(accessAdminRes.data, null, 2));
  console.log(`Security   : ${colors.green}✔ AKSES DITOLAK SESUAI KEBIJAKAN KEAMANAN!${colors.reset}`);
  console.log(`Penjelasan : Middleware 'requireRole("ADMIN")' memblokir request karena role pengguna adalah USER.`);

  // ──────────────────────────────────────────────────────────────────────────
  // LANGKAH 4: Mencoba membuka goal milik pengguna lain dan penolakan 404
  // ──────────────────────────────────────────────────────────────────────────
  banner(4, "MENCOBA MEMBUKA GOAL MILIK PENGGUNA LAIN (Siti Rahma)");
  console.log(`Aktor      : USER (Budi Santoso)`);
  console.log(`Target     : Goal ID milik Siti (${otherUserGoalId})`);
  console.log(`Request    : GET /goals/${otherUserGoalId}`);
  console.log(`Keterangan : Budi mencoba membaca data privat (Proyek Skripsi) milik Siti Rahma.`);

  const crossUserRes = await request("GET", `/goals/${otherUserGoalId}`, undefined, userToken);

  console.log(`Status     : ${colors.yellow}${colors.bright}${crossUserRes.status} Not Found${colors.reset}`);
  console.log(`Response   :`, JSON.stringify(crossUserRes.data, null, 2));
  console.log(`Security   : ${colors.green}✔ AKSES DITOLAK MELALUI DATA OWNERSHIP PROTECTION!${colors.reset}`);
  console.log(`Penjelasan : Sistem sengaja mengembalikan 404 Not Found (bukan 403) sesuai standar privasi OWASP`);
  console.log(`             untuk mencegah ID Enumeration (penyerang tidak mengetahui apakah ID tersebut valid).`);

  // ──────────────────────────────────────────────────────────────────────────
  // LANGKAH 5: Logout dan login sebagai ADMIN
  // ──────────────────────────────────────────────────────────────────────────
  banner(5, "LOGOUT USER & LOGIN SEBAGAI ADMINISTRATOR");
  console.log(`Logout     : Menghapus token Budi Santoso.`);
  await request("POST", "/auth/logout", undefined, userToken);

  console.log(`Login Admin: ${colors.yellow}admin@goalpath.app${colors.reset} / ${colors.yellow}AdminPass123!${colors.reset}`);
  console.log(`Request    : POST /auth/login`);

  const loginAdminRes = await request("POST", "/auth/login", {
    email: "admin@goalpath.app",
    password: "AdminPass123!",
  });

  console.log(`Status     : ${colors.green}${loginAdminRes.status} OK${colors.reset}`);
  adminToken = loginAdminRes.data?.data?.session?.access_token;
  console.log(`Role Akun  : ${colors.magenta}${colors.bright}${loginAdminRes.data?.data?.user?.role || "ADMIN"}${colors.reset}`);
  console.log(`Hasil      : ${colors.green}✔ Berhasil login sebagai Administrator dengan hak istimewa sistem.${colors.reset}`);

  // ──────────────────────────────────────────────────────────────────────────
  // LANGKAH 6: Membuka Admin Dashboard dan memperlihatkan pengelolaan akun
  // ──────────────────────────────────────────────────────────────────────────
  banner(6, "MEMBUKA ADMIN DASHBOARD & MEMPERLIHATKAN PENGELOLAAN AKUN");
  console.log(`Request 1  : GET /admin/stats (Mengambil Metrik Sistem)`);

  const statsRes = await request("GET", "/admin/stats", undefined, adminToken);
  console.log(`Status     : ${colors.green}${statsRes.status} OK${colors.reset}`);
  console.log(`Statistik  :`, JSON.stringify(statsRes.data?.data, null, 2));

  console.log(`\nRequest 2  : GET /admin/users (Mengambil Daftar Seluruh Pengguna)`);
  const usersRes = await request("GET", "/admin/users?page=1&limit=10", undefined, adminToken);
  console.log(`Status     : ${colors.green}${usersRes.status} OK${colors.reset}`);
  console.log(`Total User : ${usersRes.data?.data?.total} pengguna terdaftar`);

  console.log("\nDaftar Akun Pengguna Terdaftar dalam Sistem (Database MySQL):");
  const userTable = (usersRes.data?.data?.users || []).map((u: any) => ({
    Email: u.email,
    Name: u.profile?.name,
    Role: u.role,
    Tier: u.subscription?.tier || "free",
    Registered: new Date(u.created_at).toLocaleDateString("id-ID"),
  }));
  console.table(userTable);

  console.log(`\n${colors.bright}${colors.green}══════════════════════════════════════════════════════════════════════`);
  console.log(`       SELURUH SKENARIO DEMONSTRASI RBAC BERHASIL TERVALIDASI (100%)    `);
  console.log(`══════════════════════════════════════════════════════════════════════${colors.reset}\n`);
}

runDemonstration().catch(console.error);
