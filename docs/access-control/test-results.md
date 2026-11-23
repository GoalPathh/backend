# HASIL PENGUJIAN ROLE-BASED ACCESS CONTROL (RBAC) GOALPATH

**Waktu Eksekusi**: 2026-11-23T14:37:56.363Z
**Lingkungan**: Development (Node.js + Express 5 + MySQL/Prisma + JWT)

| Test ID | Skenario Pengujian | Aktor | Method | Endpoint | Expected | Actual | Hasil |
|---|---|---|---|---|---|---|---|
| TC01 | User creates their own goal | USER (Alice) | POST | `/goals` | 201 | 201 | **PASS** |
| TC02 | User updates their own goal | USER (Alice) | PATCH | `/goals/7104bd0e-4040-499f-ae01-e5d94a9aa20b` | 200 | 200 | **PASS** |
| TC03 | Non-admin user blocked from admin endpoint | USER (Alice) | GET | `/admin/users` | 403 | 403 | **PASS** |
| TC04 | User B denied access to User A's goal (Ownership check) | USER (Bob) | GET | `/goals/7104bd0e-4040-499f-ae01-e5d94a9aa20b` | 404 | 404 | **PASS** |
| TC05 | Admin accesses admin user management list | ADMIN | GET | `/admin/users` | 200 | 200 | **PASS** |
| TC06 | Unauthenticated request rejected | ANONYMOUS | GET | `/goals` | 401 | 401 | **PASS** |
| TC07 | Non-admin blocked from self-escalating role | USER (Alice) | PATCH | `/admin/users/28512252-2dec-440b-9110-d9bb6374d008/role` | 403 | 403 | **PASS** |
| TC08 | Forged or expired JWT rejected | ATTACKER (Invalid Token) | GET | `/goals` | 401 | 401 | **PASS** |
| TC09 | Admin accesses system administrative statistics | ADMIN | GET | `/admin/stats` | 200 | 200 | **PASS** |

## Detail Respons HTTP Setiap Test Case

### [TC01] User creates their own goal
- **Aktor**: USER (Alice)
- **Request**: `POST /goals`
- **Status**: `201` (Expected: `201`) -> **PASS**
- **Response Snippet**:
```json
{"data":{"id":"7104bd0e-4040-499f-ae01-e5d94a9aa20b","title":"Belajar Keamanan Jaringan","category":"skills","period":"1month","progress":0,"start_dat
```

### [TC02] User updates their own goal
- **Aktor**: USER (Alice)
- **Request**: `PATCH /goals/7104bd0e-4040-499f-ae01-e5d94a9aa20b`
- **Status**: `200` (Expected: `200`) -> **PASS**
- **Response Snippet**:
```json
{"data":{"id":"7104bd0e-4040-499f-ae01-e5d94a9aa20b","title":"Belajar Keamanan Jaringan & RBAC (Updated)","category":"other","period":"1month","progre
```

### [TC03] Non-admin user blocked from admin endpoint
- **Aktor**: USER (Alice)
- **Request**: `GET /admin/users`
- **Status**: `403` (Expected: `403`) -> **PASS**
- **Response Snippet**:
```json
{"error":{"message":"Access forbidden. Insufficient permissions."}}
```

### [TC04] User B denied access to User A's goal (Ownership check)
- **Aktor**: USER (Bob)
- **Request**: `GET /goals/7104bd0e-4040-499f-ae01-e5d94a9aa20b`
- **Status**: `404` (Expected: `404`) -> **PASS**
- **Response Snippet**:
```json
{"error":{"message":"Goal not found."}}
```

### [TC05] Admin accesses admin user management list
- **Aktor**: ADMIN
- **Request**: `GET /admin/users`
- **Status**: `200` (Expected: `200`) -> **PASS**
- **Response Snippet**:
```json
{"data":{"users":[{"id":"7a33edef-0718-40fb-8a0c-51ad4ae48b00","email":"user_b_1795444675874@test.com","role":"USER","email_verified":false,"created_a
```

### [TC06] Unauthenticated request rejected
- **Aktor**: ANONYMOUS
- **Request**: `GET /goals`
- **Status**: `401` (Expected: `401`) -> **PASS**
- **Response Snippet**:
```json
{"error":{"message":"Authentication is required."}}
```

### [TC07] Non-admin blocked from self-escalating role
- **Aktor**: USER (Alice)
- **Request**: `PATCH /admin/users/28512252-2dec-440b-9110-d9bb6374d008/role`
- **Status**: `403` (Expected: `403`) -> **PASS**
- **Response Snippet**:
```json
{"error":{"message":"Access forbidden. Insufficient permissions."}}
```

### [TC08] Forged or expired JWT rejected
- **Aktor**: ATTACKER (Invalid Token)
- **Request**: `GET /goals`
- **Status**: `401` (Expected: `401`) -> **PASS**
- **Response Snippet**:
```json
{"error":{"message":"Authentication is required."}}
```

### [TC09] Admin accesses system administrative statistics
- **Aktor**: ADMIN
- **Request**: `GET /admin/stats`
- **Status**: `200` (Expected: `200`) -> **PASS**
- **Response Snippet**:
```json
{"data":{"totalUsers":3,"totalGoals":1,"totalHabits":1,"totalSessions":0,"premiumUsers":0}}
```

