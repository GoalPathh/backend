# GoalPath API

API berbasis Express + TypeScript yang didukung oleh Supabase PostgreSQL, Supabase Auth, dan sistem client LLM (Large Language Model) yang _pluggable_.

## 🚀 Tech Stack

| Kategori | Teknologi Utama |
|---|---|
| **Server** | Express 5, Node.js |
| **Bahasa** | TypeScript, Zod (Validasi Schema & DTO) |
| **Database** | Supabase (PostgreSQL), Supabase Auth (JWT) |
| **AI / LLM** | `ai` SDK (Vercel), `@ai-sdk/openai` |
| **Background Jobs**| `node-cron` |
| **Tools Dev** | `tsx` (Watch & Run), ESLint, Prettier |

## 🛠️ Setup

1. Buat project baru di Supabase.
2. Jalankan file migrasi di folder `supabase/migrations/` pada SQL Editor Supabase **secara berurutan**:
   - `001_initial_schema.sql`
   - `002_cooldown_and_indexes.sql` *(proteksi cron untuk `goalMonitor`)*
   - `003_progress_recompute.sql` *(fungsi trigger `recompute_goal_progress`)*
   - `004_goal_milestones.sql` *(tabel + RLS)*
   - `005_milestone_progress_trigger.sql` *(otomatis +2% untuk setiap milestone selesai)*
   - `006_persona_profiles.sql` *(tabel klasifikasi persona user)*
3. Copy `.env.example` menjadi `.env` dan isi nilai Supabase-nya.
   _Publishable key_ aman digunakan untuk Auth; namun _service-role key_ harus dijaga khusus untuk backend saja.
4. (Opsional, khusus dev) Atur `DEFAULT_USER_ID` dengan UUID user Auth Supabase yang ada, agar bisa mem-bypass login saat membuat prototype halaman.
5. Jalankan `npm install` lalu `npm run dev`.

Base URL API: `http://localhost:4000/api/v1`.  
Request yang butuh autentikasi menggunakan header `Authorization: Bearer <supabase_jwt>`. Variabel `DEFAULT_USER_ID` hanya aktif di mode _development_.

## 🗺️ Main Routes (Rute Utama)

| Method | Path | Tujuan |
|---|---|---|
| POST | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/google` | Autentikasi (Email + Google OAuth) |
| GET / POST | `/goals` | Lihat / buat goals |
| GET / PATCH / DELETE | `/goals/:id` | CRUD untuk Goal |
| GET / POST | `/coach/sessions` | List history sesi / Buat sesi chat coach baru |
| PATCH / DELETE | `/coach/sessions/:id` | Rename / hapus history chat |
| GET / POST | `/coach/sessions/:id/messages` | Load history / Kirim chat ke AI assistant |
| POST | `/milestones/suggest` | Rekomendasi milestone dari AI (untuk wizard) |
| PUT | `/goals/:id/milestones` | Simpan milestone dari wizard sekaligus |
| PATCH | `/goals/:id/milestones/:mid` | Toggle milestone (selesai/belum) |
| GET | `/goals/:id/milestones` | Daftar milestone |
| GET | `/progress`, `/progress/dash`, `/progress/goals` | Snapshot progres user |
| GET / POST | `/progress/persona`, `/progress/persona/refresh`| Analisis profil AI Persona + refresh |
| GET | `/today` | Snapshot data hari ini |
| PUT | `/habits/:id/completion` | Tandai kebiasaan selesai (auto-recompute) |
| GET / POST / PATCH | `/me`, `/me/preferences` | Profil & preferensi |

---

## 🤖 Konfigurasi Provider AI

Backend terhubung ke LLM melalui `src/llm-client.ts`. Format komunikasinya menggunakan standar HTTP yang kompatibel dengan OpenAI — semua servis yang mendukung `POST /v1/chat/completions` dengan sistem SSE (Server-Sent Events) atau JSON akan berfungsi.

Terdapat dua _driver_ yang didukung, bisa diganti via `LLM_DRIVER`:

| Driver | Kapan digunakan | Implementasi |
|---|---|---|
| `raw`   (default) | **Local LLM** yang memancarkan potongan SSE yang tidak standar/quirky (seperti LMStudio, Ollama, TokenRouter MiniMax, Gemini-proxy) | `src/llm-client.ts` — menggunakan custom `fetch` Node + parser SSE manual + siklus *tool-calling* manual |
| `vercel` | **API Hosted** yang kompatibel dengan standar OpenAI JSON / SSE (OpenAI.com, together.ai, groq, proxy vLLM, endpoint ofisial Gemini yang kompatibel dengan OpenAI) | `src/llm-dispatcher.ts` — menggunakan `ai@6` SDK + `@ai-sdk/openai@3` dengan fungsi `createOpenAI` + `generateText` |

Ganti driver melalui file `.env`:

```bash
# ─────────────────────────────────────────────────────────────────
# Lokal — TokenRouter MiniMax + Proxy Gemini (gemini-cli-server)
# ─────────────────────────────────────────────────────────────────
LLM_DRIVER=raw
LLM_PROVIDER_URL=http://localhost:20128/v1
LLM_API_KEY=*** 
LLM_MODEL=gc/gemini-3.1-flash-lite-preview

# ─────────────────────────────────────────────────────────────────
# Hosted OpenAI
# ─────────────────────────────────────────────────────────────────
LLM_DRIVER=vercel
LLM_PROVIDER_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# ─────────────────────────────────────────────────────────────────
# Together.ai
# ─────────────────────────────────────────────────────────────────
LLM_DRIVER=vercel
LLM_PROVIDER_URL=https://api.together.xyz/v1
LLM_API_KEY=*** 
LLM_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
```

### Mengapa ada dua driver?

Berdasarkan pengujian pada Sprint 4, parser *streaming* bawaan Vercel AI SDK v6 gagal membaca potongan SSE yang tidak lengkap dari TokenRouter MiniMax. Karena itu, kami kembali menggunakan custom `fetch` dari Node + parser SSE manual yang jauh lebih kebal terhadap _quirk_ dari LLM lokal. 

Driver Vercel tetap dipertahankan sebagai opsi paralel untuk lingkungan _hosted_ yang sepenuhnya menaati spesifikasi OpenAI. Tidak butuh perubahan kode untuk menggantinya — cukup ganti `LLM_DRIVER` di `.env`.

### Tool Calling (Pemanggilan Alat)

Backend menyediakan spesifikasi _tool_ berikut ke LLM (lihat `src/llm-client.ts` di bagian `TOOL_DEFS`):

- `createGoal` — langsung membuat goal ketika LLM sudah memiliki semua informasi yang dibutuhkan.
- `updateGoal` — mengatur ulang progres atau memperpanjang tenggat waktu.
- `requestHabitParameters` — *(Dicadangkan)*.
- `start_goal_wizard` — memulai wizard multi-langkah (soft-start) ketika LLM hanya memiliki *sebagian* detail goal (ini kasus yang paling sering). Fungsi ini mengembalikan `{ _ui: "wizard_intent", prefill }` dan pesan asisten akan diberikan akhiran:
  ```
  [wizard_started] <json-prefill>
  ```
  Frontend lalu mem-parsing string tersebut dan merender `WizardIntentBubble` interaktif ("Mulai wizard" / "Batalkan"). Setelah user setuju, wizard akan menuntun dari Durasi → Kebiasaan → Jadwal → Milestone AI → Review. Di akhir konfirmasi, payload akan dikirim ulang bersama `[goal_finalized] <full-payload>` ke `POST /coach/sessions/:id/messages` untuk disimpan ke database.

### Analisis AI Persona

Setiap profil pengguna (konsistensi, rebound/pemulihan streak, penyelesaian milestone) akan dikalkulasi tanpa LLM secara deterministik (`PersonaRepository`), lalu hasilnya akan di-_inject_ ke sistem Prompt untuk _Coach Chat_. Hasilnya, AI akan memberikan jawaban dan mengatur *tone* bicara sesuai profil khusus si pengguna, sekaligus memberikan rekomendasi kesulitan dan _habits_ yang terukur.

### Milestones (Tonggak Pencapaian)

Ketika pengguna sampai di langkah ke-4 pada wizard, frontend memanggil `POST /milestones/suggest` yang berisi `{ goalTitle, category, duration, habits }`. Backend lalu menjalankan `agentSuggestMilestones()` (yang sadar akan `LLM_DRIVER`), mengembalikan maksimal 5 checkpoint progresif. Jika LLM offline, *template fallback deterministik* akan dikembalikan agar UI tidak pernah kosong. Setelah dipilih, milestones disimpan ke `public.goal_milestones` dan akan memicu `005_milestone_progress_trigger.sql` (+2% progres per milestone yang dikerjakan, maksimal 100%).

### Cron Job (Pekerjaan Terjadwal)

`src/jobs/goalMonitor.ts` berjalan setiap jam untuk mengirimkan pesan intervensi proaktif ke goal yang sudah mulai basi/ditinggalkan. Fitur ini dibatasi (batch-capped) pada `MAX_INTERVENTIONS_PER_TICK = 10`, menerapkan cooldown per-user setiap 24 jam (melalui tabel `public.ai_intervention_log`), dan menelan *error* `ECONNREFUSED` tanpa ribut agar *cron* tidak pernah membuat server *crash*.

---

## 🔍 Development (Pengembangan)

```bash
npm run dev         # watch server menggunakan tsx pada src/server.ts
npm run typecheck   # uji tipe data tanpa emit
npm run db:check    # cek koneksi Supabase sekali jalan
```

Uji coba *whitebox* tersedia di file `src/testAiIntegration.ts` dan berbagai file `*.ts` dengan prefiks `_test`; jalankan menggunakan perintah `npx tsx <path>`.

## Lisensi

Disediakan secara as-is (apa adanya) untuk keperluan pengembangan dan _prototyping_.
