import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { requireAuth } from '../auth.js';
import { isOnline } from '../presence.js';
import { userSelect, messageInclude, createMessage, markRead, shapeMessage } from '../services/messages.js';
import { leaveGroup } from '../services/groups.js';
import { handleUpload, uploadLimiter } from './upload.js';
import { removeFileIfUnused } from '../storage.js';

const EDIT_WINDOW_MS = 48 * 3600 * 1000;

const router = Router();
router.use(requireAuth);

const sendLimiter = rateLimit({ windowMs: 60_000, limit: 60, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
const actionLimiter = rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
const lightLimiter = rateLimit({ windowMs: 60_000, limit: 180, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
const chatMembersInclude = { members: { include: { user: { select: { ...userSelect, lastSeen: true } } } } };
const TYPING_MS = 5000;
const parseDate = (v) => { const d = v ? new Date(String(v)) : null; return d && !isNaN(d) ? d : null; };

function shape(chat, me, lastMessage = null, unread = 0, blocked = null) {
  const members = chat.members.map((m) => ({
    userId: m.userId, isAdmin: m.isAdmin, lastReadAt: m.lastReadAt,
    user: { ...m.user, online: isOnline(m.user.lastSeen) },
  }));
  let { title, avatarUrl } = chat;
  let peer = null;
  if (chat.type === 'PRIVATE') {
    peer = members.find((m) => m.userId !== me)?.user || members[0].user; // self = Saved Messages
    title = peer.id === me ? 'Saved Messages' : peer.displayName;
    avatarUrl = peer.avatarUrl;
  }
  return { id: chat.id, type: chat.type, ownerId: chat.ownerId, title, avatarUrl, peer, members, lastMessage, unread, blockedByMe: !!(peer && blocked?.has(peer.id)), createdAt: chat.createdAt };
}

const loadChat = (id) => prisma.chat.findUnique({ where: { id }, include: chatMembersInclude });
const getMember = (chatId, userId) => prisma.member.findUnique({ where: { chatId_userId: { chatId, userId } }, include: { chat: true } });

// My chats, newest activity first. Poll this every few seconds for the chat list.
router.get('/', async (req, res) => {
  const me = req.user.id;
  const blocked = new Set((await prisma.block.findMany({ where: { blockerId: me }, select: { blockedId: true } })).map((b) => b.blockedId));
  const mems = await prisma.member.findMany({
    where: { userId: me },
    include: { chat: { include: { ...chatMembersInclude, messages: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1, include: messageInclude } } } },
  });
  // One grouped query for all unread counts (instead of one COUNT per chat)
  const rows = await prisma.$queryRaw`
    SELECT m."chatId" AS "chatId", COUNT(*)::int AS n
    FROM "Message" m
    JOIN "Member" mem ON mem."chatId" = m."chatId" AND mem."userId" = ${me}
    WHERE m."deletedAt" IS NULL AND m."senderId" <> ${me} AND m."createdAt" > mem."lastReadAt"
    GROUP BY m."chatId"`;
  const unreadBy = new Map(rows.map((r) => [r.chatId, Number(r.n)]));
  const list = mems.map((m) => {
    const { messages, ...chat } = m.chat;
    return shape(chat, me, messages[0] || null, unreadBy.get(m.chatId) || 0, blocked);
  });
  const t = (c) => new Date(c.lastMessage?.createdAt || c.createdAt).getTime();
  res.json({ chats: list.sort((a, b) => t(b) - t(a)), serverTime: new Date() });
});

router.post('/private', actionLimiter, async (req, res) => {
  const me = req.user.id;
  const other = String(req.body?.userId || '');
  const target = await prisma.user.findUnique({ where: { id: other } });
  if (!target || target.isBanned) return res.status(404).json({ error: 'User not found' });

  const privateKey = [me, other].sort().join(':');
  let chat = await prisma.chat.findUnique({ where: { privateKey }, include: chatMembersInclude });
  if (!chat) {
    try {
      const ids = [...new Set([me, other])];
      await prisma.chat.create({ data: { type: 'PRIVATE', privateKey, members: { create: ids.map((userId) => ({ userId })) } } });
    } catch (e) {
      if (e.code !== 'P2002') throw e; // created concurrently by the other user → just load it
    }
    chat = await prisma.chat.findUnique({ where: { privateKey }, include: chatMembersInclude });
  }
  const blocked = new Set((await prisma.block.findMany({ where: { blockerId: me, blockedId: other }, select: { blockedId: true } })).map((b) => b.blockedId));
  res.status(201).json({ chat: shape(chat, me, null, 0, blocked) });
});

router.post('/group', actionLimiter, async (req, res) => {
  const me = req.user.id;
  const title = String(req.body?.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'Group title required' });
  const wanted = Array.isArray(req.body?.memberIds) ? req.body?.memberIds.map(String).slice(0, 200) : [];
  const valid = await prisma.user.findMany({ where: { id: { in: wanted }, isBanned: false, blocking: { none: { blockedId: me } } }, select: { id: true } });
  const ids = [...new Set([me, ...valid.map((u) => u.id)])];
  const created = await prisma.chat.create({
    data: { type: 'GROUP', title, ownerId: me, members: { create: ids.map((userId) => ({ userId, isAdmin: userId === me })) } },
    include: chatMembersInclude,
  });
  res.status(201).json({ chat: shape(created, me) });
});

router.post('/:id/members', actionLimiter, async (req, res) => {
  const chatId = req.params.id;
  const mem = await getMember(chatId, req.user.id);
  if (!mem || mem.chat.type !== 'GROUP' || !mem.isAdmin) return res.status(403).json({ error: 'Not allowed' });
  const wanted = Array.isArray(req.body?.userIds) ? req.body?.userIds.map(String).slice(0, 200) : [];
  const valid = await prisma.user.findMany({ where: { id: { in: wanted }, isBanned: false, blocking: { none: { blockedId: req.user.id } } }, select: { id: true } });
  await prisma.member.createMany({ data: valid.map((u) => ({ chatId, userId: u.id })), skipDuplicates: true });
  res.json({ chat: shape(await loadChat(chatId), req.user.id) });
});

router.delete('/:id/members/me', async (req, res) => {
  const mem = await getMember(req.params.id, req.user.id);
  if (!mem || mem.chat.type !== 'GROUP') return res.status(404).json({ error: 'Not found' });
  await leaveGroup(req.params.id, req.user.id); // handles owner hand-over and empty groups
  res.json({ ok: true });
});

// History:  ?before=<ISO>  → older page (newest-first, returned oldest-first)
// Polling:  ?after=<serverTime> → everything new/changed/deleted since then, plus typing + read receipts
router.get('/:id/messages', async (req, res) => {
  const chatId = req.params.id;
  const serverTime = new Date();
  if (!(await getMember(chatId, req.user.id))) return res.status(403).json({ error: 'Not a member' });

  const before = parseDate(req.query.before);
  const after = parseDate(req.query.after);
  const limit = Math.min(Number(req.query.limit) || (after ? 200 : 50), after ? 200 : 100);
  const rows = await prisma.message.findMany({
    where: {
      chatId,
      ...(after ? { updatedAt: { gt: after } } : { deletedAt: null }),
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    // polling pages by updatedAt so a full page can be continued without skipping rows
    orderBy: after ? { updatedAt: 'asc' } : { createdAt: 'desc' },
    take: limit,
    include: messageInclude,
  });
  const members = await prisma.member.findMany({ where: { chatId }, select: { userId: true, lastReadAt: true, typingAt: true } });
  const typing = members
    .filter((m) => m.userId !== req.user.id && m.typingAt && serverTime - m.typingAt < TYPING_MS)
    .map((m) => m.userId);
  const messages = (after ? rows : rows.reverse()).map(shapeMessage);
  res.json({
    messages, typing, serverTime,
    reads: members.map(({ userId, lastReadAt }) => ({ userId, lastReadAt })),
    hasMore: rows.length === limit,
  });
});

router.post('/:id/messages', sendLimiter, async (req, res) => {
  try {
    res.status(201).json({ message: await createMessage(req.user.id, { ...req.body, chatId: req.params.id }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/typing', lightLimiter, async (req, res) => {
  await prisma.member.updateMany({
    where: { chatId: req.params.id, userId: req.user.id },
    data: { typingAt: req.body?.isTyping === false ? null : new Date() },
  });
  res.json({ ok: true });
});

router.post('/:id/read', lightLimiter, async (req, res) => {
  try { res.json({ ok: true, readAt: await markRead(req.user.id, req.params.id) }); }
  catch (e) { res.status(403).json({ error: e.message }); }
});

// ---------- group management ----------
const groupAdmin = async (chatId, userId) => {
  const mem = await getMember(chatId, userId);
  return mem && mem.chat.type === 'GROUP' && mem.isAdmin ? mem : null;
};

router.get('/:id', async (req, res) => {
  if (!(await getMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  const chat = await loadChat(req.params.id);
  const blocked = new Set((await prisma.block.findMany({ where: { blockerId: req.user.id }, select: { blockedId: true } })).map((b) => b.blockedId));
  res.json({ chat: shape(chat, req.user.id, null, 0, blocked) });
});

// Rename (group admins)
router.patch('/:id', actionLimiter, async (req, res) => {
  if (!(await groupAdmin(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not allowed' });
  const title = String(req.body?.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'Group title required' });
  await prisma.chat.update({ where: { id: req.params.id }, data: { title } });
  res.json({ chat: shape(await loadChat(req.params.id), req.user.id) });
});

router.post('/:id/avatar', uploadLimiter, async (req, res) => {
  const mem = await groupAdmin(req.params.id, req.user.id);
  if (!mem) return res.status(403).json({ error: 'Not allowed' });
  try {
    const f = await handleUpload(req, res);
    if (f.type !== 'IMAGE') { await removeFileIfUnused(f.fileUrl); return res.status(400).json({ error: 'Image required' }); }
    await prisma.chat.update({ where: { id: req.params.id }, data: { avatarUrl: f.fileUrl } });
    if (mem.chat.avatarUrl) removeFileIfUnused(mem.chat.avatarUrl);
    res.json({ chat: shape(await loadChat(req.params.id), req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 4 MB)' : e.message });
  }
});

// Remove a member (admins; only the owner may remove other admins; the owner can't be removed)
router.delete('/:id/members/:userId', actionLimiter, async (req, res) => {
  const chatId = req.params.id, target = req.params.userId;
  const mem = await groupAdmin(chatId, req.user.id);
  if (!mem) return res.status(403).json({ error: 'Not allowed' });
  if (target === req.user.id) return res.status(400).json({ error: 'Use leave instead' });
  const tm = await prisma.member.findUnique({ where: { chatId_userId: { chatId, userId: target } } });
  if (!tm) return res.status(404).json({ error: 'Not found' });
  if (target === mem.chat.ownerId) return res.status(403).json({ error: "The owner can't be removed" });
  if (tm.isAdmin && req.user.id !== mem.chat.ownerId) return res.status(403).json({ error: 'Only the owner can remove admins' });
  await prisma.member.delete({ where: { id: tm.id } });
  res.json({ chat: shape(await loadChat(chatId), req.user.id) });
});

// Promote / demote an admin (owner only)
router.patch('/:id/members/:userId', actionLimiter, async (req, res) => {
  const chatId = req.params.id, target = req.params.userId;
  const mem = await getMember(chatId, req.user.id);
  if (!mem || mem.chat.type !== 'GROUP' || mem.chat.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the owner can do this' });
  if (typeof req.body?.isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin (boolean) required' });
  if (target === req.user.id) return res.status(400).json({ error: "The owner is always an admin" });
  const r = await prisma.member.updateMany({ where: { chatId, userId: target }, data: { isAdmin: req.body.isAdmin } });
  if (!r.count) return res.status(404).json({ error: 'Not found' });
  res.json({ chat: shape(await loadChat(chatId), req.user.id) });
});

// Transfer ownership (owner only; the old owner stays an admin)
router.post('/:id/transfer', actionLimiter, async (req, res) => {
  const chatId = req.params.id, target = String(req.body?.userId || '');
  const mem = await getMember(chatId, req.user.id);
  if (!mem || mem.chat.type !== 'GROUP' || mem.chat.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the owner can do this' });
  if (target === req.user.id) return res.status(400).json({ error: 'Already the owner' });
  const tm = await prisma.member.findUnique({ where: { chatId_userId: { chatId, userId: target } } });
  if (!tm) return res.status(404).json({ error: 'Not a member' });
  await prisma.$transaction([
    prisma.chat.update({ where: { id: chatId }, data: { ownerId: target } }),
    prisma.member.update({ where: { id: tm.id }, data: { isAdmin: true } }),
  ]);
  res.json({ chat: shape(await loadChat(chatId), req.user.id) });
});

// ---------- edit / delete own messages ----------
router.patch('/:id/messages/:mid', sendLimiter, async (req, res) => {
  const { id: chatId, mid } = req.params;
  if (!(await getMember(chatId, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  const msg = await prisma.message.findFirst({ where: { id: mid, chatId, deletedAt: null } });
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.senderId !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages' });
  if (Date.now() - msg.createdAt.getTime() > EDIT_WINDOW_MS) return res.status(400).json({ error: 'Too old to edit (48h)' });
  if (typeof req.body?.text !== 'string') return res.status(400).json({ error: 'text required' });
  const text = req.body.text.trim().slice(0, 4000);
  if (msg.type === 'TEXT' && !text) return res.status(400).json({ error: 'Empty message' });
  const message = await prisma.message.update({ where: { id: msg.id }, data: { text: text || null, editedAt: new Date() }, include: messageInclude });
  res.json({ message });
});

// Sender can delete their own message; group admins can delete anyone's in their group
router.delete('/:id/messages/:mid', actionLimiter, async (req, res) => {
  const { id: chatId, mid } = req.params;
  const mem = await getMember(chatId, req.user.id);
  if (!mem) return res.status(403).json({ error: 'Not a member' });
  const msg = await prisma.message.findFirst({ where: { id: mid, chatId, deletedAt: null } });
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.senderId !== req.user.id && !(mem.chat.type === 'GROUP' && mem.isAdmin)) return res.status(403).json({ error: 'Not allowed' });
  await prisma.message.update({ where: { id: msg.id }, data: { deletedAt: new Date(), text: null, fileUrl: null, fileName: null } });
  if (msg.fileUrl) await removeFileIfUnused(msg.fileUrl);
  res.json({ ok: true });
});

export default router;
