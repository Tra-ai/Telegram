import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { requireAuth } from '../auth.js';
import { isBlobUrl, removeFileIfUnused } from '../storage.js';

const router = Router();
router.use(requireAuth);
const postLimiter = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
const shape = (p) => ({ id: p.id, text: p.text, imageUrl: p.imageUrl, createdAt: p.createdAt, userId: p.userId });

// Posts of a user (newest first). Hidden if that user blocked me.
router.get('/user/:id', async (req, res) => {
  const id = req.params.id;
  if (id !== req.user.id) {
    const u = await prisma.user.findUnique({ where: { id }, select: { isBanned: true } });
    if (!u || u.isBanned) return res.status(404).json({ error: 'Not found' });
    if (await prisma.block.findFirst({ where: { blockerId: id, blockedId: req.user.id } })) return res.status(404).json({ error: 'Not found' });
  }
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const rows = await prisma.post.findMany({
    where: { userId: id, ...(before && !isNaN(before) ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: 'desc' }, take: 20,
  });
  res.json({ posts: rows.map(shape) });
});

router.post('/', postLimiter, async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 2000) : '';
  const imageUrl = typeof req.body?.imageUrl === 'string' && req.body.imageUrl ? req.body.imageUrl : null;
  if (!text && !imageUrl) return res.status(400).json({ error: 'Empty post' });
  if (imageUrl && !isBlobUrl(imageUrl, req.user.id)) return res.status(400).json({ error: 'Bad image' });
  const p = await prisma.post.create({ data: { userId: req.user.id, text, imageUrl } });
  res.status(201).json({ post: shape(p) });
});

router.delete('/:id', async (req, res) => {
  const p = await prisma.post.findUnique({ where: { id: req.params.id } });
  if (!p || p.userId !== req.user.id) return res.status(404).json({ error: 'Not found' });
  await prisma.post.delete({ where: { id: p.id } });
  if (p.imageUrl) removeFileIfUnused(p.imageUrl);
  res.json({ ok: true });
});

export default router;
