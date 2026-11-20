import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth, requireAdmin, publicUser } from '../auth.js';
import { isOnline, onlineSince } from '../presence.js';
import { messageInclude } from '../services/messages.js';
import { removeFileIfUnused } from '../storage.js';
import { invalidateUser } from '../auth.js';
import { leaveGroup } from '../services/groups.js';
import passkeyRoutes, { requirePass } from './adminPasskey.js';

const router = Router();
router.use(requireAuth, requireAdmin);
router.use('/passkey', passkeyRoutes); // face / fingerprint gate (enrol + verify)
router.use(requirePass); // every route below needs the gate once an admin has enrolled
const live = { deletedAt: null };

router.get('/stats', async (_req, res) => {
  const day = new Date(Date.now() - 24 * 3600 * 1000);
  const [users, banned, chats, groups, messages, messagesToday, media, newUsers, onlineNow] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isBanned: true } }),
    prisma.chat.count(),
    prisma.chat.count({ where: { type: 'GROUP' } }),
    prisma.message.count({ where: live }),
    prisma.message.count({ where: { ...live, createdAt: { gt: day } } }),
    prisma.message.count({ where: { ...live, type: { in: ['IMAGE', 'VIDEO', 'VOICE', 'FILE'] } } }),
    prisma.user.count({ where: { createdAt: { gt: day } } }),
    prisma.user.count({ where: { lastSeen: { gt: onlineSince() }, isBanned: false } }),
  ]);
  res.json({ users, banned, chats, groups, messages, messagesToday, media, newUsers, onlineNow });
});

// Last 7 rolling 24h buckets (oldest first): new users + messages per bucket
router.get('/series', async (_req, res) => {
  const DAY = 24 * 3600 * 1000, end = Date.now();
  const days = await Promise.all([6, 5, 4, 3, 2, 1, 0].map(async (i) => {
    const from = new Date(end - (i + 1) * DAY), to = new Date(end - i * DAY);
    const range = { gt: from, lte: to };
    const [users, messages] = await Promise.all([prisma.user.count({ where: { createdAt: range } }), prisma.message.count({ where: { ...live, createdAt: range } })]);
    return { to, users, messages };
  }));
  res.json({ days });
});

router.get('/bots', async (_req, res) => {
  const bots = await prisma.bot.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { user: true, owner: true } });
  res.json({ bots: bots.map((b) => ({ id: b.id, userId: b.userId, username: b.user.username, displayName: b.user.displayName, avatarUrl: b.user.avatarUrl,
    owner: { username: b.owner.username, displayName: b.owner.displayName }, createdAt: b.createdAt, online: isOnline(b.user.lastSeen) })) });
});

router.get('/users', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = Math.max(Number(req.query.page) || 1, 1);
  const take = 25;
  const where = q ? { OR: [{ username: { contains: q.toLowerCase() } }, { displayName: { contains: q, mode: 'insensitive' } }] } : {};
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take }),
  ]);
  res.json({ total, page, pages: Math.ceil(total / take),
    users: users.map((u) => ({ ...publicUser(u), isBanned: u.isBanned, online: isOnline(u.lastSeen) })) });
});

router.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) return res.status(400).json({ error: "You can't change your own account here" });
  const data = {};
  if (typeof req.body?.isBanned === 'boolean') data.isBanned = req.body?.isBanned;
  if (['USER', 'ADMIN'].includes(req.body?.role)) data.role = req.body?.role;
  if (req.body?.revokeSessions === true) data.tokenVersion = { increment: 1 }; // log the user out everywhere
  const u = await prisma.user.update({ where: { id }, data }).catch(() => null);
  if (!u) return res.status(404).json({ error: 'Not found' });
  invalidateUser(id);
  res.json({ user: { ...publicUser(u), isBanned: u.isBanned } });
});

router.delete('/users/:id', async (req, res) => {
  const id = req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  // Private chats involving this user would otherwise be left as a fake "Saved Messages" for the peer
  const priv = await prisma.chat.findMany({ where: { type: 'PRIVATE', privateKey: { contains: id } }, select: { id: true } });
  const chatIds = priv.map((c) => c.id);
  const files = await prisma.message.findMany({
    where: { fileUrl: { not: null }, OR: [{ senderId: id }, { chatId: { in: chatIds } }] }, select: { fileUrl: true },
  });
  // Groups: hand over ownership / remove empty groups before the user's rows cascade away
  const groups = await prisma.member.findMany({ where: { userId: id, chat: { type: 'GROUP' } }, select: { chatId: true } });
  for (const g of groups) await leaveGroup(g.chatId, id).catch(() => {});
  const u = await prisma.user.delete({ where: { id } }).catch(() => null);
  if (u) {
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    invalidateUser(id);
    const urls = [...new Set([...files.map((f) => f.fileUrl), u.avatarUrl].filter(Boolean))];
    await Promise.all(urls.map(removeFileIfUnused));
  }
  res.json({ ok: true });
});

router.get('/chats', async (_req, res) => {
  const chats = await prisma.chat.findMany({
    orderBy: { createdAt: 'desc' }, take: 100,
    include: { _count: { select: { members: true, messages: true } } },
  });
  res.json({ chats });
});

router.get('/messages', async (req, res) => {
  const where = { ...live };
  if (req.query.chatId) where.chatId = String(req.query.chatId);
  if (req.query.q) where.text = { contains: String(req.query.q), mode: 'insensitive' };
  res.json({ messages: await prisma.message.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, include: messageInclude }) });
});

// Soft delete → polling clients receive a tombstone and remove it
router.delete('/messages/:id', async (req, res) => {
  const msg = await prisma.message.findFirst({ where: { id: req.params.id, ...live } });
  if (!msg) return res.status(404).json({ error: 'Not found' });
  await prisma.message.update({ where: { id: msg.id }, data: { deletedAt: new Date(), text: null, fileUrl: null, fileName: null } });
  if (msg.fileUrl) await removeFileIfUnused(msg.fileUrl); // fileUrl was just nulled on this row
  res.json({ ok: true });
});

export default router;
