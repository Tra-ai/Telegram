# Telegram Clone Server — Vercel + Neon

Express 5 · Prisma · Neon Postgres · Vercel Blob (files) · JWT. Realtime = polling (Vercel មិនគាំទ្រ WebSocket)។

## Deploy
1. **Neon** → បង្កើត project → ចម្លង 2 connection strings:
   - `DATABASE_URL` = **Pooled** (host មាន `-pooler`) + `&pgbouncer=true`
   - `DIRECT_URL` = **Direct** (គ្មាន `-pooler`)
2. **បង្កើត tables + admin (ធ្វើម្ដងក្នុង computer)**
   ```bash
   npm install
   cp .env.example .env      # បំពេញ DATABASE_URL, DIRECT_URL, JWT_SECRET, ADMIN_PASSWORD
   npm run db:push
   npm run seed:admin
   ```
3. **GitHub** → push → **Vercel** → Import project
4. Vercel → **Storage → Create → Blob** → Connect to project (បន្ថែម `BLOB_READ_WRITE_TOKEN` អូតូ)
5. Vercel → Settings → Environment Variables: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` (32+ ចៃដន្យ), `CLIENT_ORIGIN` (domain frontend) → **Redeploy**
6. ពិនិត្យ: `https://<app>.vercel.app/api/health` → `{"ok":true}` · Admin: `https://<app>.vercel.app/admin/`

## ⚠️ ពេល update ពី v2.0 → v2.1
Schema ប្ដូរ (Block table, `tokenVersion`, `editedAt`) → រត់ម្ដងទៀត: `npm run db:push` (ជាការបន្ថែមសុទ្ធ មិនបាត់ data)។

## មុខងារបន្ថែម (v2.1)
- Block / unblock: `POST|DELETE /api/users/:id/block`, `GET /api/users/blocked` (chat មាន `blockedByMe`)
- កែ/លុបសារខ្លួនឯង: `PATCH|DELETE /api/chats/:id/messages/:mid` (កែបាន 48h · admin group លុបសារអ្នកដទៃបាន)
- Group: rename `PATCH /chats/:id` · avatar `POST /chats/:id/avatar` · kick `DELETE /chats/:id/members/:userId` · admin `PATCH /chats/:id/members/:userId` · ផ្ទេរ owner `POST /chats/:id/transfer`
- Owner ចាកចេញ → ផ្ទេរអូតូ · សមាជិកចុងក្រោយចាកចេញ → group + ឯកសារត្រូវលុប
- ប្ដូរពាក្យសម្ងាត់ `POST /auth/password` / `POST /auth/logout-all` → token ចាស់ទាំងអស់ត្រូវ revoke · Admin មានប៊ូតុង "Log out"

## ចំណាំ
- Upload ≤ 4 MB (កំណត់ Vercel 4.5 MB) · whitelist: jpg png gif webp mp4 webm mov mp3 ogg m4a wav aac
- Online = ធ្វើសកម្មភាពក្នុង 40 វិនាទីចុងក្រោយ · Typing = 5 វិនាទី
- Uploads are stored under `uploads/<userId>/` and only the uploader can attach them to a message
- Auth user cache 10 វិនាទី (ban/role មានអានុភាពក្នុង ≤10s) · ពាក្យសម្ងាត់ ≥ 8 តួ · ឯកសារត្រូវលុបតែពេលគ្មានសារ/avatar ណាប្រើ
- Production ត្រូវការ `BLOB_READ_WRITE_TOKEN` (បើគ្មាន file URL នឹងត្រូវបដិសេធ)
- Rate limit ជា in-memory (ក្នុងមួយ instance) — ប្រសិនបើត្រូវការតឹងរ៉ឹង ប្រើ Upstash/Vercel KV
- Frontend: copy `client/api.ts` → `src/api.ts`, ប្រើ `watchChats` / `watchChat`

## 📱 Android app (screenshot = ខ្មៅ)
GitHub → Actions → **Build Android APK** → Run workflow → ដាក់ URL គេហទំព័រ → រង់ចាំ ~5 នាទី → ទាញ artifact `SecureChat-apk` → install។
App ប្រើ `FLAG_SECURE` ដូច្នេះ screenshot / screen record / recent-apps thumbnail ចេញខ្មៅ។
