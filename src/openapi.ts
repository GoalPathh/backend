const jsonBody = (schema: string, required = true) => ({
  required,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/" + schema },
    },
  },
});

const dataResponse = (description = "Berhasil.") => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { data: { description: "Data respons endpoint." } },
        required: ["data"],
      },
    },
  },
});

const errorResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorResponse" },
    },
  },
});

type OperationOptions = {
  auth?: boolean;
  premium?: boolean;
  body?: string;
  bodyOptional?: boolean;
  pathParams?: string[];
  queryParams?: Array<Record<string, unknown>>;
  status?: number;
  description?: string;
};

const operation = (tag: string, summary: string, options: OperationOptions = {}) => ({
  tags: [tag],
  summary,
  ...(options.description ? { description: options.description } : {}),
  ...(options.auth
    ? { security: [{ bearerAuth: [] }, { cookieAuth: [] }] }
    : {}),
  ...(options.pathParams ? {
    parameters: options.pathParams.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    })),
  } : {}),
  ...(options.queryParams ? { parameters: options.queryParams } : {}),
  ...(options.body ? { requestBody: jsonBody(options.body, !options.bodyOptional) } : {}),
  responses: {
    [options.status ?? 200]: options.status === 204
      ? { description: "Berhasil; tidak ada isi respons." }
      : dataResponse(),
    ...(options.auth ? { 401: errorResponse("Autentikasi diperlukan.") } : {}),
    ...(options.premium ? { 402: errorResponse("Fitur memerlukan Premium.") } : {}),
    400: errorResponse("Format request tidak valid."),
    500: errorResponse("Kesalahan pada server."),
  },
});

const rangeParameter = {
  name: "range",
  in: "query",
  required: false,
  description: "Rentang data progres.",
  schema: {
    type: "string",
    enum: ["last-7-days", "last-30-days", "last-3-months", "last-6-months", "last-year", "custom"],
    default: "last-7-days",
  },
};

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "GoalPath API",
    version: "0.1.0",
    description:
      "Dokumentasi REST API GoalPath. Endpoint memakai prefix /api/v1. Respons sukses umumnya berbentuk { data }, sedangkan error berbentuk { error: { message, details } }. Endpoint privat menerima Authorization: Bearer <token> atau cookie goalpath_access_token yang dibuat saat login/register.",
  },
  servers: [{ url: "/api/v1", description: "Server GoalPath API" }],
  tags: [
    { name: "Health", description: "Status layanan." },
    { name: "Auth", description: "Registrasi, login, dan pengelolaan sesi." },
    { name: "Goals", description: "Goal dan milestone." },
    { name: "Habits", description: "Aktivitas kebiasaan." },
    { name: "Profile", description: "Profil dan preferensi pengguna." },
    { name: "Progress", description: "Ringkasan progres dan persona." },
    { name: "Notifications", description: "Notifikasi pengguna." },
    { name: "Coach", description: "Sesi dan pesan AI Coach." },
    { name: "Subscription", description: "Status langganan, trial, dan pembayaran." },
  ],
  paths: {
    "/health": { get: operation("Health", "Cek status API") },
    "/auth/register": { post: operation("Auth", "Daftarkan akun", {
      body: "RegisterRequest", status: 201,
      description: "Membuat akun dan mengatur cookie sesi HttpOnly.",
    }) },
    "/auth/login": { post: operation("Auth", "Login", {
      body: "Credentials",
      description: "Login dan mengatur cookie sesi HttpOnly.",
    }) },
    "/auth/refresh": { post: operation("Auth", "Perbarui sesi", {
      body: "RefreshRequest", bodyOptional: true,
      description: "Token refresh dapat dikirim pada body atau melalui cookie goalpath_refresh_token.",
    }) },
    "/auth/google": { post: operation("Auth", "Mulai login Google", { body: "GoogleAuthRequest" }) },
    "/auth/logout": { post: operation("Auth", "Logout", {
      description: "Menghapus cookie sesi akses dan refresh.",
    }) },
    "/auth/forgot-password": { post: operation("Auth", "Minta reset password", { body: "ForgotPasswordRequest" }) },
    "/auth/password": { post: operation("Auth", "Ganti password", { auth: true, body: "PasswordRequest" }) },
    "/goals": {
      get: operation("Goals", "Daftar goal pengguna", { auth: true }),
      post: operation("Goals", "Buat goal", { auth: true, body: "GoalRequest", status: 201 }),
    },
    "/goals/dashboard": { get: operation("Goals", "Ringkasan goal dashboard", { auth: true }) },
    "/goals/{id}": {
      get: operation("Goals", "Ambil detail goal", { auth: true, pathParams: ["id"] }),
      patch: operation("Goals", "Perbarui goal", { auth: true, pathParams: ["id"], body: "GoalUpdateRequest" }),
      delete: operation("Goals", "Hapus goal", { auth: true, pathParams: ["id"], status: 204 }),
    },
    "/goals/{id}/milestones": {
      get: operation("Goals", "Daftar milestone goal", { auth: true, pathParams: ["id"] }),
      put: operation("Goals", "Ganti daftar milestone goal", { auth: true, pathParams: ["id"], body: "MilestonesRequest" }),
    },
    "/goals/{id}/milestones/{milestoneId}": {
      patch: operation("Goals", "Ubah status milestone", {
        auth: true, pathParams: ["id", "milestoneId"], body: "MilestoneCompletionRequest",
      }),
    },
    "/milestones/suggest": { post: operation("Goals", "Buat saran milestone", {
      auth: true, body: "MilestoneSuggestionRequest",
    }) },
    "/today": { get: operation("Habits", "Ambil ringkasan aktivitas hari ini", {
      auth: true,
      queryParams: [{
        name: "tzOffset", in: "query", required: false,
        description: "Offset zona waktu dalam menit.", schema: { type: "integer" },
      }],
    }) },
    "/habits/{id}/completion": { put: operation("Habits", "Catat status kebiasaan", {
      auth: true, pathParams: ["id"], body: "CompletionRequest",
    }) },
    "/habits/adaptive/preview": { post: operation("Habits", "Pratinjau saran adaptasi kebiasaan", {
      auth: true, premium: true, body: "AdaptivePreviewRequest",
    }) },
    "/me/overview": { get: operation("Profile", "Ambil ringkasan akun", { auth: true }) },
    "/me": {
      get: operation("Profile", "Ambil profil pengguna", { auth: true }),
      patch: operation("Profile", "Perbarui profil pengguna", { auth: true, body: "ProfileUpdateRequest" }),
    },
    "/me/avatar/signature": { post: operation("Profile", "Buat tanda tangan upload avatar", { auth: true }) },
    "/me/preferences": {
      get: operation("Profile", "Ambil preferensi pengguna", { auth: true }),
      patch: operation("Profile", "Perbarui preferensi pengguna", { auth: true, body: "PreferencesUpdateRequest" }),
    },
    "/progress": { get: operation("Progress", "Ambil snapshot progres pengguna", { auth: true }) },
    "/progress/overview": { get: operation("Progress", "Ambil ringkasan progres", {
      auth: true, queryParams: [rangeParameter],
    }) },
    "/progress/dash": { get: operation("Progress", "Ambil data dashboard progres", { auth: true }) },
    "/progress/goals": { get: operation("Progress", "Ambil performa goal", { auth: true }) },
    "/progress/adaptation": { get: operation("Progress", "Ambil rekomendasi adaptasi", {
      auth: true,
      queryParams: [rangeParameter, {
        name: "goalId", in: "query", required: false, schema: { type: "string", format: "uuid" },
      }],
    }) },
    "/progress/adaptation/{id}/apply": { post: operation("Progress", "Terapkan rekomendasi adaptasi", {
      auth: true, pathParams: ["id"], body: "AdaptationChangesRequest", bodyOptional: true,
    }) },
    "/progress/adaptation/{id}/dismiss": { post: operation("Progress", "Tolak rekomendasi adaptasi", {
      auth: true, pathParams: ["id"],
    }) },
    "/progress/recompute/{goalId}": { post: operation("Progress", "Hitung ulang progres goal", {
      auth: true, pathParams: ["goalId"],
    }) },
    "/progress/persona": { get: operation("Progress", "Ambil analisis persona", {
      auth: true,
      queryParams: [{
        name: "windowDays", in: "query", required: false,
        schema: { type: "integer", enum: [7, 14, 30], default: 14 },
      }],
    }) },
    "/progress/persona/refresh": { post: operation("Progress", "Perbarui analisis persona", {
      auth: true, body: "PersonaRefreshRequest", bodyOptional: true,
      queryParams: [{
        name: "windowDays", in: "query", required: false,
        schema: { type: "integer", enum: [7, 14, 30], default: 14 },
      }],
    }) },
    "/progress/future-self": { get: operation("Progress", "Buat proyeksi Future Self", {
      auth: true, premium: true,
      queryParams: [{
        name: "days", in: "query", required: false,
        schema: { type: "integer", minimum: 7, maximum: 180, default: 30 },
      }],
    }) },
    "/notifications": { get: operation("Notifications", "Daftar notifikasi", { auth: true }) },
    "/notifications/read-all": { patch: operation("Notifications", "Tandai semua notifikasi sudah dibaca", {
      auth: true,
    }) },
    "/coach/sessions": {
      get: operation("Coach", "Daftar sesi Coach", { auth: true }),
      post: operation("Coach", "Buat sesi Coach", {
        auth: true, body: "CoachSessionCreateRequest", bodyOptional: true, status: 201,
      }),
    },
    "/coach/sessions/{id}": {
      get: operation("Coach", "Ambil detail sesi Coach", { auth: true, pathParams: ["id"] }),
      patch: operation("Coach", "Ubah judul sesi Coach", {
        auth: true, pathParams: ["id"], body: "CoachSessionUpdateRequest",
      }),
      delete: operation("Coach", "Hapus sesi Coach", { auth: true, pathParams: ["id"], status: 204 }),
    },
    "/coach/sessions/{id}/messages": {
      get: operation("Coach", "Ambil pesan sesi Coach", { auth: true, pathParams: ["id"] }),
      post: operation("Coach", "Kirim pesan ke Coach", {
        auth: true, pathParams: ["id"], body: "CoachMessageRequest", status: 201,
      }),
    },
    "/coach/quota": { get: operation("Coach", "Cek kuota pesan Coach", { auth: true }) },
    "/subscription": { get: operation("Subscription", "Ambil status langganan", { auth: true }) },
    "/subscription/payments": { get: operation("Subscription", "Daftar pembayaran", { auth: true }) },
    "/subscription/trial": { post: operation("Subscription", "Mulai trial Premium", { auth: true, status: 201 }) },
    "/subscription/checkout": { post: operation("Subscription", "Buat transaksi checkout Premium", { auth: true, status: 201 }) },
    "/subscription/refresh": { post: operation("Subscription", "Sinkronkan status langganan", { auth: true }) },
    "/subscription/cancel": { post: operation("Subscription", "Batalkan langganan", { auth: true }) },
    "/subscription/webhook": { post: operation("Subscription", "Terima webhook pembayaran", { body: "WebhookRequest" }) },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Kirim JWT Supabase melalui header Authorization: Bearer <token>.",
      },
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "goalpath_access_token",
        description: "Cookie HttpOnly yang diatur otomatis oleh endpoint login/register.",
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: { message: { type: "string" }, details: {} },
            required: ["message"],
          },
        },
        required: ["error"],
      },
      Credentials: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
        },
        required: ["email", "password"],
      },
      RegisterRequest: {
        allOf: [
          { $ref: "#/components/schemas/Credentials" },
          {
            type: "object",
            properties: { name: { type: "string", minLength: 2, maxLength: 80 } },
            required: ["name"],
          },
        ],
      },
      RefreshRequest: { type: "object", properties: { refreshToken: { type: "string", minLength: 1 } } },
      GoogleAuthRequest: {
        type: "object",
        properties: {
          next: { type: "string", description: "Jalur internal setelah autentikasi.", default: "/today" },
        },
      },
      ForgotPasswordRequest: {
        type: "object",
        properties: { email: { type: "string", format: "email" } },
        required: ["email"],
      },
      PasswordRequest: {
        type: "object",
        properties: { password: { type: "string", minLength: 8 } },
        required: ["password"],
      },
      HabitInput: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 120 },
          duration: { type: "integer", minimum: 1, maximum: 1440 },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          schedule: {
            type: "object",
            properties: {
              timeRange: { type: "string", enum: ["anytime", "morning", "afternoon", "evening"] },
              reminderTime: { type: "string" },
              activeDays: { type: "array", items: { type: "string" } },
              priority: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["timeRange", "activeDays", "priority"],
          },
        },
        required: ["title", "duration", "difficulty", "schedule"],
      },
      GoalRequest: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 2, maxLength: 160 },
          category: { type: "string", enum: ["language", "fitness", "skills", "creativity", "learning", "other"], default: "other" },
          period: { type: "string", enum: ["1month", "3months", "6months", "1year"] },
          progress: { type: "number", minimum: 0, maximum: 100, default: 0 },
          selectedHabits: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/HabitInput" } },
          startDate: { type: "string", format: "date-time" },
          targetDate: { type: "string", format: "date-time" },
          reminderEnabled: { type: "boolean" },
          notificationPreference: { type: "string", enum: ["all", "important", "none"] },
        },
        required: ["title", "period", "selectedHabits", "startDate", "targetDate", "reminderEnabled", "notificationPreference"],
      },
      GoalUpdateRequest: {
        type: "object",
        description: "Semua properti goal opsional; selectedHabits tidak dapat diubah lewat endpoint ini.",
        properties: {
          title: { type: "string", minLength: 2, maxLength: 160 },
          category: { type: "string", enum: ["language", "fitness", "skills", "creativity", "learning", "other"] },
          period: { type: "string", enum: ["1month", "3months", "6months", "1year"] },
          progress: { type: "number", minimum: 0, maximum: 100 },
          startDate: { type: "string", format: "date-time" },
          targetDate: { type: "string", format: "date-time" },
          reminderEnabled: { type: "boolean" },
          notificationPreference: { type: "string", enum: ["all", "important", "none"] },
        },
      },
      ProfileUpdateRequest: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          username: { type: "string", minLength: 2, maxLength: 40 },
          avatarUrl: { type: "string", format: "uri" },
        },
      },
      PreferencesUpdateRequest: {
        type: "object",
        properties: {
          appearance: { type: "string", enum: ["light", "dark", "system"] },
          notifications: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, title: { type: "string" },
                enabled: { type: "boolean" }, description: { type: "string" },
              },
              required: ["id", "title", "enabled", "description"],
            },
          },
          privacy: { type: "object", properties: { personalizedCoach: { type: "boolean" } } },
        },
      },
      CompletionRequest: {
        type: "object",
        properties: { completed: { type: "boolean" }, completionDate: { type: "string", format: "date" } },
        required: ["completed"],
      },
      AdaptivePreviewRequest: {
        type: "object",
        properties: { goalId: { type: "string", format: "uuid" }, habitId: { type: "string", format: "uuid" } },
        required: ["goalId"],
      },
      MilestoneSuggestionRequest: {
        type: "object",
        properties: {
          goalTitle: { type: "string", minLength: 2, maxLength: 160 },
          category: { type: "string", maxLength: 40 },
          duration: { type: "string", maxLength: 20 },
          habits: {
            type: "array", maxItems: 20,
            items: {
              type: "object",
              properties: { title: { type: "string" }, difficulty: { type: "string" } },
              required: ["title"],
            },
          },
        },
        required: ["goalTitle"],
      },
      MilestoneInput: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 3, maxLength: 200 },
          target_date: { type: "string", format: "date-time" },
          sort_order: { type: "integer", minimum: 0, maximum: 20 },
        },
        required: ["title"],
      },
      MilestonesRequest: {
        type: "object",
        properties: {
          milestones: { type: "array", minItems: 1, maxItems: 12, items: { $ref: "#/components/schemas/MilestoneInput" } },
        },
        required: ["milestones"],
      },
      MilestoneCompletionRequest: {
        type: "object",
        properties: { completed: { type: "boolean" } },
        required: ["completed"],
      },
      AdaptationChangesRequest: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          duration: { type: "integer", minimum: 1, maximum: 1440 },
          timeRange: { type: "string", enum: ["anytime", "morning", "afternoon", "evening"] },
          activeDays: {
            type: "array", maxItems: 7,
            items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
          },
        },
      },
      PersonaRefreshRequest: {
        type: "object",
        properties: { windowDays: { type: "integer", enum: [7, 14, 30] } },
      },
      CoachSessionCreateRequest: {
        type: "object",
        properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
      },
      CoachSessionUpdateRequest: {
        type: "object",
        properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
        required: ["title"],
      },
      CoachMessageRequest: {
        type: "object",
        description: "Untuk finalisasi Goal Wizard, content dapat diawali [goal_finalized] diikuti payload JSON.",
        properties: {
          role: { type: "string", enum: ["user", "assistant"], default: "user" },
          content: { type: "string", minLength: 1, maxLength: 20000 },
        },
        required: ["content"],
      },
      WebhookRequest: {
        type: "object",
        description: "Payload webhook pembayaran Midtrans; signature diverifikasi oleh server.",
        additionalProperties: true,
      },
    },
  },
} as const;
