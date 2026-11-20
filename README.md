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

## 📱 Android app
GitHub → Actions → **Build Android APK** → Run workflow → ដាក់ URL គេហទំព័រ → រង់ចាំ ~5 នាទី → ទាញ artifact `Layzzchat-apk` → install។
Screenshot / screen record ថតបានធម្មតា (បានបិទ `FLAG_SECURE`)។

## Bots (Bot API)

Create bots in the app: **Settings → Bots → Create**. Username must end with `bot`. You get a token shown once (`<botId>:<secret>`; only a hash is stored). Regular signups can't use usernames ending in `bot`.

`GET|POST /api/bot/<TOKEN>/<method>` — params as JSON body or query string. Responses: `{ ok, result }` or `{ ok:false, error_code, description }`.

| Method | Params |
|---|---|
| `getMe` | – |
| `getUpdates` | `offset`, `limit` (≤100), `timeout` (≤8s long-poll). Updates below `offset` are deleted (ack); kept max 24h |
| `sendMessage` | `chat_id`, `text`, `reply_to_message_id` |
| `editMessageText` / `deleteMessage` | `chat_id`, `message_id` (own messages only) |
| `sendChatAction` | `chat_id` (shows "typing") |
| `setMyCommands` / `getMyCommands` | `commands: [{command, description}]` — shown as chips in the bot's chat |

A bot receives every message in chats it is a member of (private chats with users, or groups it was added to). No webhooks yet — use `getUpdates`. Rate limit: 100 requests / 10 s per bot. Deploy runs `prisma db push`, which adds the `Bot` and `BotUpdate` tables (nothing existing is changed).

## 🔐 ស្កេនមុខ / ម្រាមដៃ ដើម្បីចូល /admin/ (Passkey)
- ចូល /admin/ → ទិដ្ឋភាពទូទាំង → ផ្នែក **សុវត្ថិភាព Admin** → **បើកការស្កេនលើឧបករណ៍នេះ**។ ពេលក្រោយ ត្រូវស្កេន (មុខ/ម្រាមដៃ/PIN របស់ទូរស័ព្ទ) រាល់ពេលចូល (ដំណើរការ ៨ ម៉ោង)។ ការពិនិត្យធ្វើនៅ server ទាំងអស់។
- ត្រូវបើក /admin/ ក្នុង **Chrome (HTTPS)**។ APK (WebView) មិនគាំទ្រ WebAuthn ទេ។
- ទូរស័ព្ទជាអ្នកជ្រើសរើសថាប្រើមុខ ឬម្រាមដៃ (app មិនអាចបង្ខំឱ្យប្រើតែមុខបានទេ)។
- បើបាត់ឧបករណ៍ទាំងអស់៖ ដាក់ env `ADMIN_PASSKEY_BYPASS=1` ក្នុង Vercel ហើយ redeploy ដើម្បីបិទការពារបណ្តោះអាសន្ន រួចលុបឧបករណ៍ចាស់ ហើយបិទ env វិញ។
- ជម្រើស env៖ `WEBAUTHN_RP_ID` (ឧ. `yourapp.vercel.app`) និង `WEBAUTHN_ORIGIN` (ឧ. `https://yourapp.vercel.app`) ប្រសិនបើ domain មិនត្រូវស្គាល់ដោយស្វ័យប្រវត្តិ។


## Backbook (កម្មវិធី Facebook ភ្ជាប់ជាមួយ Layzzchat)
ថត `backbook/` ជា frontend ស្ទីល Facebook ។ backend របស់វានៅក្នុង server នេះ (`src/routes/bb.js`, ផ្លូវ `/api/v1`) ប្រើ database និងគណនីតែមួយជាមួយ Layzzchat ។ ការណែនាំ deploy មើល `backbook/README.md` ។ ត្រូវដាក់ env `CLIENT_ORIGIN` = URL របស់ Backbook ។
