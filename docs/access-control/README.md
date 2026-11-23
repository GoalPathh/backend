# DOKUMENTASI DAN LAPORAN IMPLEMENTASI ROLE-BASED ACCESS CONTROL (RBAC) GOALPATH
**Mata Kuliah**: Praktikum Keamanan Sistem Informasi  
**Aplikasi**: GoalPath (Personalized AI Habit & Goal Platform)  
**Teknologi**: Node.js, Express.js 5, TypeScript, Next.js 15, MySQL, Prisma ORM, JWT (HTTP-Only Cookies)

---

## 1. PENDAHULUAN & TUJUAN
Tujuan dari implementasi ini adalah untuk menerapkan sistem kendali akses berbasis peran (Role-Based Access Control / RBAC) dan perlindungan kepemilikan data (Data Ownership Protection) secara menyeluruh pada aplikasi GoalPath, memastikan bahwa:
1. Setiap request diverifikasi keaslian identitasnya (*Authentication*).
2. Setiap pengguna hanya dapat mengakses endpoint dan fitur yang sesuai dengan peran (*Role Validation*).
3. Pengguna biasa (**USER**) tidak dapat membaca, mengubah, atau menghapus data sensitif pengguna lain (**Ownership Validation**).
4. Administrator (**ADMIN**) memiliki kewenangan pengelolaan sistem tanpa melanggar privasi data personal pengguna (*Principle of Least Privilege*).
5. Pengguna tidak dapat menaikkan hak aksesnya sendiri (*Privilege Escalation Prevention*).

---

## 2. DEFINISI PERAN (ROLES)

| Peran | Deskripsi | Hak Akses Utama | Batasan |
|---|---|---|---|
| **USER** | Pengguna reguler aplikasi GoalPath (Default role saat registrasi) | - Kelola profil & preferensi sendiri<br>- CRUD Goal & Habit sendiri<br>- Catat habit completion & cek progres<br>- Berinteraksi dengan AI Coach & RAG<br>- Kelola pengingat (*reminder*) sendiri | - Dilarang mengakses endpoint administrasi (`/admin/*`)<br>- Dilarang melihat atau memanipulasi data milik pengguna lain<br>- Dilarang mengubah role diri sendiri menjadi ADMIN |
| **ADMIN** | Pengelola sistem dengan kewenangan administratif | - Akses Admin Dashboard (`/admin`)<br>- Melihat statistik sistem global (`/admin/stats`)<br>- Melihat daftar akun pengguna terdaftar (`/admin/users`)<br>- Mengubah kewenangan peran pengguna (`/admin/users/:id/role`) | - Tidak secara otomatis membaca pesan privat AI Coach pengguna<br>- Tidak melewati kepemilikan personal goal/habit pengguna lain<br>- Dibatasi pada fungsi administratif |

---

## 3. ACCESS CONTROL MATRIX (ACM)

| Modul / Fitur | Operasi | Endpoint Backend | USER | ADMIN | Mekanisme Pengamanan |
|---|---|---|:---:|:---:|---|
| **Autentikasi** | Register | `POST /auth/register` | ✅ (User) | ❌ (Publik) | Default role `USER`, input role diabaikan |
| | Login | `POST /auth/login` | ✅ | ✅ | Validasi password via bcrypt, issue JWT |
| | Refresh Token | `POST /auth/refresh` | ✅ | ✅ | Validasi refresh token |
| | Logout | `POST /auth/logout` | ✅ | ✅ | Hapus HTTP-only cookie |
| **Profil & Akun** | Baca Profil Sendiri | `GET /me` | ✅ | ✅ | `requireUser`, query berdasarkan `req.userId` |
| | Update Profil Sendiri | `PATCH /me` | ✅ | ✅ | `requireUser`, role tidak dapat diubah di sini |
| | Preferensi Akun | `GET/PATCH /me/preferences` | ✅ | ✅ | `requireUser`, ownership terikat `req.userId` |
| **Goal Management** | Buat Goal Baru | `POST /goals` | ✅ | ❌ | `requireUser`, simpan dengan `user_id = req.userId` |
| | Lihat Daftar Goal | `GET /goals` | ✅ (Milik Sendiri) | ❌ | Filter query ketat: `where: { user_id }` |
| | Detail Goal | `GET /goals/:id` | ✅ (Milik Sendiri) | ❌ | `requireOwnership("goal")` (404 jika bukan pemilik) |
| | Update Goal | `PATCH /goals/:id` | ✅ (Milik Sendiri) | ❌ | `requireOwnership("goal")` |
| | Hapus Goal | `DELETE /goals/:id` | ✅ (Milik Sendiri) | ❌ | `requireOwnership("goal")` |
| **Habit & Progres** | Selesaikan Habit | `PUT /habits/:id/completion`| ✅ (Milik Sendiri) | ❌ | Validasi kepemilikan habit di DB |
| | Lihat Progres | `GET /progress/*` | ✅ (Milik Sendiri) | ❌ | `requireUser`, hitung agregasi user aktif |
| **AI Coach** | Sesi Percakapan | `GET/POST /coach/sessions` | ✅ (Milik Sendiri) | ❌ | Filter `user_id`, privasi percakapan terlindungi |
| | Kirim Pesan AI | `POST /coach/sessions/:id/messages` | ✅ (Milik Sendiri) | ❌ | Memeriksa kepemilikan sesi sebelum inject prompt |
| **Administrasi** | Statistik Sistem | `GET /admin/stats` | ⛔ (403) | ✅ (200) | `requireUser`, `requireRole("ADMIN")` |
| | Daftar Pengguna | `GET /admin/users` | ⛔ (403) | ✅ (200) | `requireUser`, `requireRole("ADMIN")`, no password hash |
| | Detail Pengguna | `GET /admin/users/:id` | ⛔ (403) | ✅ (200) | `requireUser`, `requireRole("ADMIN")` |
| | Ubah Role Akun | `PATCH /admin/users/:id/role`| ⛔ (403) | ✅ (200) | `requireUser`, `requireRole("ADMIN")`, enum validation |

---

## 4. IMPLEMENTASI KEAMANAN (BACKEND)

### A. Skema Basis Data (Prisma ORM & MySQL)
Atribut `role` diimplementasikan dengan `enum Role` pada model `User`:
```prisma
enum Role {
  USER
  ADMIN
}

model User {
  id                  String               @id @default(uuid())
  email               String               @unique
  password_hash       String
  role                Role                 @default(USER)
  created_at          DateTime             @default(now())
  updated_at          DateTime             @updatedAt
  // relasi...
}
```

### B. Middleware Autentikasi & Otorisasi (`src/middleware.ts`)
1. **`resolveUser`**: Membaca JWT dari HTTP-only cookie atau header `Authorization: Bearer <token>`. Mengambil identitas user dan role langsung dari basis data MySQL yang terpercaya (`prisma.user.findUnique`), lalu menetapkan `req.userId` dan `req.userRole`.
2. **`requireUser`**: Memastikan request terautentikasi (mengembalikan HTTP `401 Unauthorized` jika tidak ada token valid).
3. **`requireRole(role)`**: Memastikan role pengguna cocok (mengembalikan HTTP `403 Forbidden` jika pengguna login tetapi tidak memiliki kewenangan).
4. **`requireOwnership(model, paramKey)`**: Memeriksa apakah `req.userId` adalah pemilik sah dari resource di database. Jika resource dimiliki user lain, sistem mengembalikan HTTP `404 Not Found` guna mencegah kebocoran informasi keberadaan ID (*ID Enumeration / Information Disclosure Defense*).

### C. Pencegahan Eskalasi Hak Akses (Anti-Privilege Escalation)
- Skema validasi Zod (`registerSchema` dan `profileSchema`) tidak menyertakan atribut `role`.
- Pembaruan role hanya dapat dilakukan melalui endpoint khusus `PATCH /admin/users/:id/role` yang dilindungi oleh `requireRole("ADMIN")`.
- Pembuatan akun Admin awal dilakukan melalui skrip seeder aman: `src/scripts/seedAdmin.ts`.

---

## 5. IMPLEMENTASI FRONTEND (NEXT.JS)

1. **Role Guard (`frontend/app/admin/layout.tsx`)**:
   - Memeriksa role pengguna melalui `userService.getOverview()`.
   - Menolak akses jika role bukan `ADMIN` dengan menampilkan pesan penolakan HTTP 403 dan tombol redirect ke `/today`.
2. **Admin Console (`frontend/app/admin/page.tsx`)**:
   - Menampilkan metrik statistik sistem (Total Users, Goals, Habits, AI Sessions, Premium Members).
   - Menampilkan tabel akun pengguna beserta role badge dan tombol aksi perubahan role.
3. **Penyembunyian Navigasi (`frontend/components/app-sidebar.tsx`)**:
   - Tautan navigasi "Admin Panel" hanya dirender pada sidebar jika akun memiliki `profile?.role === "ADMIN"`. Pengguna biasa tidak melihat menu administrasi.

---

## 6. HASIL PENGUJIAN OTORISASI (TEST SUITE)

Seluruh test case (TC01 s/d TC09) telah dieksekusi secara nyata terhadap server lokal `http://localhost:4000/api/v1` menggunakan skrip otomatis `src/scripts/testRbac.ts`.

| ID | Skenario | Aktor | Method & Endpoint | Expected | Status Code | Hasil |
|:---:|---|:---:|---|:---:|:---:|:---:|
| **TC01** | User membuat Goal milik sendiri | USER | `POST /goals` | 201 | 201 | **PASS** |
| **TC02** | User memperbarui Goal milik sendiri | USER | `PATCH /goals/:id` | 200 | 200 | **PASS** |
| **TC03** | User mencoba mengakses daftar Admin | USER | `GET /admin/users` | 403 | 403 | **PASS** |
| **TC04** | User B mencoba mengakses Goal User A | USER | `GET /goals/:goalIdOfUserA` | 404 | 404 | **PASS** |
| **TC05** | Admin mengakses daftar Admin Users | ADMIN | `GET /admin/users` | 200 | 200 | **PASS** |
| **TC06** | Request tanpa token ke endpoint terproteksi | ANONYMOUS | `GET /goals` | 401 | 401 | **PASS** |
| **TC07** | User mencoba menaikkan role sendiri | USER | `PATCH /admin/users/:id/role` | 403 | 403 | **PASS** |
| **TC08** | Request dengan token JWT palsu / kedaluwarsa | ATTACKER | `GET /goals` | 401 | 401 | **PASS** |
| **TC09** | Admin mengakses statistik administratif sistem | ADMIN | `GET /admin/stats` | 200 | 200 | **PASS** |

Dokumentasi lengkap log respons JSON dari masing-masing test case dapat dilihat pada berkas `test-results.md`.
