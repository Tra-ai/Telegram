# Backbook (Facebook-style app) — connected to Layzzchat

This frontend has **no backend of its own**. It talks to the Layzzchat server (`/api/v1/*`, see `../src/routes/bb.js`):

- **Same accounts**: log in with your Layzzchat username + password (or sign up here — it creates a Layzzchat account).
- **Same database**: profile photo/name are shared; Backbook "Messages" are the same chats as Layzzchat.
- Posts, reactions, comments, friends, notifications, search live in new `Bb*` tables (created by `prisma db push` on deploy).
- No websockets on Vercel → the app polls every 6 s for badges / online users / new messages.
- Not included: e-mail verification, password reset by e-mail, Firebase push.

## Deploy (second Vercel project)
1. Vercel → Add New Project → same GitHub repo → **Root Directory: `backbook`** (framework: Vite).
2. Environment variable: `VITE_BACKEND_URL` = your Layzzchat URL (no trailing slash).
3. In the **Layzzchat** project add env `CLIENT_ORIGIN` = the Backbook URL (comma-separate several), then redeploy it (needed for CORS).

## Local
```
cp .env.example .env   # set VITE_BACKEND_URL
npm install --legacy-peer-deps
npm run dev
```
