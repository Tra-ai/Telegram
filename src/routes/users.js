import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth, publicUser } from '../auth.js';
import { isOnline } from '../presence.js';
import { handleUpload, uploadLimiter } from './upload.js';
import { removeFile, removeFileIfUnused } from '../storage.js';
import rateLimit from 'express-rate-limit';

const router = Router();
router.use(requireAuth);
const searchLimiter = rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
const blockLimiter = rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
const withOnline = (u) => ({ ...publicUser(u), online: isOnline(u.lastSeen) });

router.get('/search', searchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const users = await prisma.user.findMany({
    where: {
      id: { not: req.user.id }, isBanned: false,
      blocking: { none: { blockedId: req.user.id } }, // hide people who blocked me
      OR: [{ username: { contains: q.toLowerCase() } }, { displayName: { contains: q, mode: 'insensitive' } }],
    },
    take: 20,
  });
  res.json({ users: users.map(withOnline) });
});

router.patch('/me', async (req, res) => {
  const data = {};
  if (typeof req.body?.displayName === 'string' && req.body?.displayName.trim())
    data.displayName = req.body?.displayName.trim().slice(0, 50);
  if (typeof req.body?.bio === 'string') data.bio = req.body?.bio.slice(0, 200);
  res.json({ user: publicUser(await prisma.user.update({ where: { id: req.user.id }, data })) });
});

router.post('/me/avatar', uploadLimiter, async (req, res) => {
  try {
    const f = await handleUpload(req, res);
    if (f.type !== 'IMAGE') { await removeFile(f.fileUrl); return res.status(400).json({ error: 'Image required' }); }
    const old = req.user.avatarUrl;
    const u = await prisma.user.update({ where: { id: req.user.id }, data: { avatarUrl: f.fileUrl } });
    if (old) removeFileIfUnused(old);
    res.json({ user: publicUser(u) });
  } catch (e) {
    res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 4 MB)' : e.message });
  }
});

// ---- blocking ----
router.get('/blocked', async (req, res) => {
  const rows = await prisma.block.findMany({ where: { blockerId: req.user.id }, orderBy: { createdAt: 'desc' }, include: { blocked: true } });
  res.json({ users: rows.map((b) => publicUser(b.blocked)) });
});

router.post('/:id/block', blockLimiter, async (req, res) => {
  const id = req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: "You can't block yourself" });
  if (!(await prisma.user.findUnique({ where: { id }, select: { id: true } }))) return res.status(404).json({ error: 'Not found' });
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId: req.user.id, blockedId: id } },
    update: {}, create: { blockerId: req.user.id, blockedId: id },
  });
  res.json({ ok: true });
});

router.delete('/:id/block', blockLimiter, async (req, res) => {
  await prisma.block.deleteMany({ where: { blockerId: req.user.id, blockedId: req.params.id } });
  res.json({ ok: true });
});

// Keep AFTER /search, /me and /blocked
router.get('/:id', async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (u && u.id !== req.user.id && await prisma.block.findFirst({ where: { blockerId: u.id, blockedId: req.user.id } })) return res.status(404).json({ error: 'Not found' });
  if (!u || u.isBanned) return res.status(404).json({ error: 'Not found' });
  res.json({ user: withOnline(u) });
});

export default router;
