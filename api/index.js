import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from '../src/routes/auth.js';
import userRoutes from '../src/routes/users.js';
import chatRoutes from '../src/routes/chats.js';
import uploadRoutes from '../src/routes/upload.js';
import adminRoutes from '../src/routes/admin.js';
import bbRoutes from '../src/routes/bb.js';
import postRoutes from '../src/routes/posts.js';
import botRoutes from '../src/routes/bots.js';
import botApiRoutes from '../src/routes/botapi.js';

const origins = process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean) : process.env.NODE_ENV === 'production' ? false : true;

const app = express();
app.set('trust proxy', 1); // behind Vercel's proxy → real client IP for rate limiting
app.disable('x-powered-by');
app.use(cors({ origin: origins, credentials: true }));
app.use(express.json({ limit: '100kb' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/v1', bbRoutes); // Backbook (social app) API
app.use('/api/upload', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/bots', botRoutes); // manage your bots (user login)
app.use('/api/bot', botApiRoutes); // Bot API (bot token)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'Server error' });
});

export default app;
