# GoalPath API

Express + TypeScript API backed by Supabase PostgreSQL and Supabase Auth.

## Setup

1. Create a Supabase project.
2. Run `supabase/migrations/001_initial_schema.sql` in the Supabase SQL editor.
3. Copy `.env.example` to `.env` and fill the Supabase values. The publishable key is safe for Auth; the service-role key must remain backend-only.
4. For prototype pages before login, set `DEFAULT_USER_ID` to an existing Supabase Auth user UUID.
5. Run `npm install` and `npm run dev`.

API base URL: `http://localhost:4000/api/v1`.

Authenticated requests use `Authorization: Bearer <supabase-access-token>`. `DEFAULT_USER_ID` is development-only.

## Main routes

- `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/google`
- `GET|POST /goals`, `GET|PATCH|DELETE /goals/:id`
- `GET /today`, `GET /progress`
- `PUT /habits/:id/completion`
- `GET|PATCH /me`, `GET|PATCH /me/preferences`
- `GET|POST /coach/sessions`
- `GET|POST /coach/sessions/:id/messages`
