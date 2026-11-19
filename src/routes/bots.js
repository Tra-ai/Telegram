// Managing your bots (like @BotFather, but inside the app). Requires a normal user login.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { requireAuth } from '../auth.js';
import { isOnline } from '../presence.js';
import { BOT_USERNAME, newToken } from '../services/bots.js';

const MAX_BOTS = 10;
const router = Router();
router.use(requireAuth);
const limiter = rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });

const shape = (b) => ({
  id: b.userId, username: b.user.username, displayName: b.user.displayName, avatarUrl: b.user.avatarUrl,
  description: b.description, createdAt: b.createdAt, online: isOnline(b.user.lastSeen),
});
const mine = (userId, ownerId) => prisma.bot.findFirst({ where: { userId: String(userId), ownerId }, include: { user: true } });

router.get('/', async (req, res) => {
  const bots = await prisma.bot.findMany({ where: { ownerId: req.user.id }, orderBy: { createdAt: 'desc' }, include: { user: true } });
  res.json({ bots: bots.map(shape) });
});

// Public info used by the chat screen (description, command list)
router.get('/info/:userId', async (req, res) => {
  const b = await prisma.bot.findUnique({ where: { userId: String(req.params.userId) }, select: { description: true, commands: true } });
  res.json(b ? { isBot: true, description: b.description, commands: Array.isArray(b.commands) ? b.commands : [] } : { isBot: false });
});

router.post('/', limiter, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 50);
  const username = String(req.body?.username || '').trim().toLowerCase().replace(/^@/, '');
  const description = String(req.body?.description || '').trim().slice(0, 200);
  if (!name) return res.status(400).json({ error: 'Bot name required' });
  if (!BOT_USERNAME.test(username) || username.length > 32) return res.status(400).json({ error: 'Username must end with "bot" (a-z, 0-9, _ · 6-32 chars), e.g. my_shop_bot' });
  if ((await prisma.bot.count({ where: { ownerId: req.user.id } })) >= MAX_BOTS) return res.status(400).json({ error: `You can have up to ${MAX_BOTS} bots` });
  if (await prisma.user.findUnique({ where: { username }, select: { id: true } })) return res.status(409).json({ error: 'Username already taken' });
  try {
    // Nobody knows this password → a bot account can never log in like a person
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 8);
    const { bot, token } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { username, displayName: name, bio: description, passwordHash } });
      const t = newToken(user.id);
      const bot = await tx.bot.create({ data: { userId: user.id, ownerId: req.user.id, tokenHash: t.hash, description }, include: { user: true } });
      return { bot, token: t.token };
    });
    res.status(201).json({ bot: shape(bot), token });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Username already taken' });
    throw e;
  }
});

// New token → the old one stops working immediately
router.post('/:id/token', limiter, async (req, res) => {
  const b = await mine(req.params.id, req.user.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const t = newToken(b.userId);
  await prisma.bot.update({ where: { id: b.id }, data: { tokenHash: t.hash } });
  res.json({ token: t.token });
});

router.patch('/:id', limiter, async (req, res) => {
  const b = await mine(req.params.id, req.user.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const userData = {}, botData = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) userData.displayName = req.body.name.trim().slice(0, 50);
  if (typeof req.body?.description === 'string') { botData.description = req.body.description.trim().slice(0, 200); userData.bio = botData.description; }
  if (Object.keys(userData).length) await prisma.user.update({ where: { id: b.userId }, data: userData });
  if (Object.keys(botData).length) await prisma.bot.update({ where: { id: b.id }, data: botData });
  res.json({ bot: shape(await mine(req.params.id, req.user.id)) });
});

// Deleting the bot's user removes the Bot row, its chats and messages (cascade)
router.delete('/:id', limiter, async (req, res) => {
  const b = await mine(req.params.id, req.user.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  await prisma.user.delete({ where: { id: b.userId } });
  res.json({ ok: true });
});

export default router;
