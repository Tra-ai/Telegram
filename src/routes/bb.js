// Backbook (Facebook-style app) API, mounted at /api/v1.
// Same database + same accounts as Layzzchat: a Backbook login IS a Layzzchat login,
// and Backbook "Messages" are the very same chats/messages as in Layzzchat.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { signToken, userFromToken } from '../auth.js';
import { saveFile, removeFileIfUnused } from '../storage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 10 } });

/* ---------------- helpers ---------------- */
const ok = (res, data = {}, extra = {}) => res.json({ status: 'success', data, ...extra });
const fail = (res, code, message) => res.status(code).json({ status: 'fail', message });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const user = await userFromToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!user) return fail(res, 401, 'Please log in');
  req.user = user;
  next();
}

const nameParts = (displayName = '') => {
  const t = String(displayName).trim().split(/\s+/);
  return { first_name: t[0] || '', last_name: t.slice(1).join(' ') };
};
const toUser = (u) => u && ({
  _id: u.id, id: u.id, username: u.username, ...nameParts(u.displayName),
  photo: u.avatarUrl || '', cover: u.cover || '', gender: u.gender || 'male', confirmed: true, verified: true,
  details: u.details || {}, bio: u.bio,
});
const SAFE_USER = { id: true, username: true, displayName: true, avatarUrl: true, cover: true, gender: true, details: true, bio: true };
const REACTS = ['like', 'love', 'haha', 'wow', 'sad', 'angry'];

const page = (req, def = 10) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || def));
  const pg = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { take: limit, skip: (pg - 1) * limit };
};

async function usersById(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: list } }, select: SAFE_USER });
  return new Map(rows.map((u) => [u.id, toUser(u)]));
}

async function notify(userId, sender, type, content, click) {
  if (userId === sender.id) return;
  const { first_name, last_name } = nameParts(sender.displayName);
  // content is "<first> <last> <type> ..." — the UI reads word #3 as the react icon name
  await prisma.bbNotification.create({ data: { userId, senderId: sender.id, type, content: `${first_name} ${last_name} ${content}`, click } }).catch(() => {});
}

async function blockedEitherWay(a, b) {
  return !!(await prisma.block.findFirst({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] } }));
}

/* ---------------- posts serialisation ---------------- */
function commentOut(c, users) {
  return {
    _id: c.id, user: users.get(c.userId) || null, text: c.text, photo: c.photo || '', likes: c.likes || [],
    createdAt: c.createdAt, post: c.postId,
    replies: (c.replies || []).map((r) => commentOut({ ...r, replies: [] }, users)),
  };
}

async function postsOut(rows, meId) {
  if (!rows.length) return [];
  const ids = rows.map((p) => p.id);
  const sharedIds = rows.map((p) => p.sharedId).filter(Boolean);
  const [shared, reacts, commentCounts, shareCounts, lastComments] = await Promise.all([
    sharedIds.length ? prisma.bbPost.findMany({ where: { id: { in: sharedIds } } }) : [],
    prisma.bbReact.findMany({ where: { postId: { in: ids } }, select: { postId: true, userId: true, type: true } }),
    prisma.bbComment.groupBy({ by: ['postId'], where: { postId: { in: ids } }, _count: { _all: true } }),
    prisma.bbPost.groupBy({ by: ['sharedId'], where: { sharedId: { in: ids } }, _count: { _all: true } }),
    Promise.all(ids.map((id) => prisma.bbComment.findFirst({ where: { postId: id, parentId: null }, orderBy: { createdAt: 'desc' }, include: { replies: { orderBy: { createdAt: 'asc' } } } }))),
  ]);
  const users = await usersById([...rows.map((p) => p.userId), ...shared.map((p) => p.userId),
    ...lastComments.flatMap((c) => (c ? [c.userId, ...c.replies.map((r) => r.userId)] : []))]);
  const sharedMap = new Map(shared.map((p) => [p.id, { _id: p.id, user: users.get(p.userId), type: p.type, text: p.text, background: p.background, images: p.images, createdAt: p.createdAt }]));
  const cc = new Map(commentCounts.map((x) => [x.postId, x._count._all]));
  const sc = new Map(shareCounts.map((x) => [x.sharedId, x._count._all]));
  return rows.map((p, i) => {
    const mine = reacts.filter((r) => r.postId === p.id);
    const types = {}; for (const r of mine) types[r.type] = (types[r.type] || 0) + 1;
    return {
      _id: p.id, user: users.get(p.userId) || null, type: p.type, text: p.text, background: p.background, images: p.images,
      sharedID: p.sharedId ? (sharedMap.get(p.sharedId) || null) : undefined, createdAt: p.createdAt,
      reactions: { types, totalCount: mine.length, isLiked: mine.find((r) => r.userId === meId)?.type || null },
      commentsCount: cc.get(p.id) || 0, sharesCount: sc.get(p.id) || 0,
      lastComment: lastComments[i] ? [commentOut(lastComments[i], users)] : [],
    };
  });
}

async function reactionSummary(postId, meId) {
  const rs = await prisma.bbReact.findMany({ where: { postId }, select: { userId: true, type: true } });
  const types = {}; for (const r of rs) types[r.type] = (types[r.type] || 0) + 1;
  return { types, totalCount: rs.length, isLiked: rs.find((r) => r.userId === meId)?.type || null };
}

/* ---------------- friendship ---------------- */
async function friendshipOf(meId, otherId) {
  if (meId === otherId) return { friends: false, requestSent: false, requestReceived: false, requestID: null, following: false };
  const [rel, fol] = await Promise.all([
    prisma.bbFriend.findFirst({ where: { OR: [{ senderId: meId, recipientId: otherId }, { senderId: otherId, recipientId: meId }] } }),
    prisma.bbFollow.findUnique({ where: { followerId_followingId: { followerId: meId, followingId: otherId } } }),
  ]);
  return {
    friends: rel?.status === 'ACCEPTED',
    requestSent: rel?.status === 'PENDING' && rel.senderId === meId,
    requestReceived: rel?.status === 'PENDING' && rel.recipientId === meId,
    requestID: rel?.id || null,
    following: !!fol,
  };
}
async function friendIds(meId) {
  const rows = await prisma.bbFriend.findMany({ where: { status: 'ACCEPTED', OR: [{ senderId: meId }, { recipientId: meId }] } });
  return rows.map((r) => (r.senderId === meId ? r.recipientId : r.senderId));
}

/* ---------------- stats (badges) ---------------- */
async function statsOf(user) {
  const [req, notif, unreadChats] = await Promise.all([
    prisma.bbFriend.count({ where: { recipientId: user.id, status: 'PENDING' } }),
    prisma.bbNotification.count({ where: { userId: user.id, seen: false } }),
    unseenMessagesOf(user.id),
  ]);
  return { recivedRequestsCount: req, unseenNotification: notif, unseenMessages: unreadChats };
}
async function unseenMessagesOf(userId) {
  const ms = await prisma.member.findMany({ where: { userId }, select: { chatId: true, lastReadAt: true } });
  if (!ms.length) return 0;
  const counts = await Promise.all(ms.map((m) => prisma.message.count({ where: { chatId: m.chatId, senderId: { not: userId }, deletedAt: null, createdAt: { gt: m.lastReadAt } } })));
  return counts.filter((n) => n > 0).length;
}
const meOut = async (u) => ({ ...toUser(u), ...(await statsOf(u)) });

/* ============================== USERS ============================== */
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.post('/users/login', loginLimiter, wrap(async (req, res) => {
  // The UI's "email" box carries the Layzzchat username
  const username = String(req.body?.email || req.body?.username || '').trim().toLowerCase().replace(/^@/, '');
  const password = String(req.body?.password || '');
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return fail(res, 401, 'Wrong username or password');
  if (user.isBanned) return fail(res, 403, 'This account is banned');
  ok(res, { user: await meOut(user), token: signToken(user) });
}));

router.post('/users/signup', signupLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const username = String(b.email || b.username || '').trim().toLowerCase().replace(/^@/, '');
  const password = String(b.password || '');
  const first = String(b.first_name || '').trim().slice(0, 25), last = String(b.last_name || '').trim().slice(0, 25);
  if (!first) return fail(res, 400, 'First name is required');
  if (!/^[a-z0-9_]{3,32}$/.test(username)) return fail(res, 400, 'Username: 3-32 chars, a-z 0-9 _');
  if (/bot$/.test(username)) return fail(res, 400, 'Usernames ending in "bot" are reserved');
  if (password.length < 8 || password.length > 100) return fail(res, 400, 'Password must be 8-100 characters');
  if (b.passwordConfirm !== undefined && b.passwordConfirm !== password) return fail(res, 400, 'Passwords do not match');
  if (await prisma.user.findUnique({ where: { username } })) return fail(res, 409, 'Username already taken');
  const gender = ['male', 'female'].includes(b.gender) ? b.gender : 'male';
  try {
    const user = await prisma.user.create({ data: { username, displayName: `${first} ${last}`.trim(), passwordHash: await bcrypt.hash(password, 10), gender } });
    res.status(201).json({ status: 'success', data: { user: await meOut(user), token: signToken(user) } });
  } catch (e) {
    if (e.code === 'P2002') return fail(res, 409, 'Username already taken');
    throw e;
  }
}));

// Not applicable (no e-mail on Layzzchat accounts) — answer politely so the UI never breaks
router.all(['/users/logout', '/users/fcm', '/users/emailVerification', '/users/resendEmailVerifivation'], (_req, res) => ok(res, {}));
router.all(['/users/forgotPassword', '/users/resetPassword'], (_req, res) => fail(res, 400, 'Password reset is not available. Change your password inside Layzzchat settings.'));

router.put('/users/ping', auth, wrap(async (req, res) => {
  const s = await statsOf(req.user);
  res.json({ status: 'success', ...s, data: s });
}));

// Who is online right now (friends + people I chat with), for the "online" strip in Messages
router.get('/users/online', auth, wrap(async (req, res) => {
  const [fids, mine] = await Promise.all([friendIds(req.user.id), prisma.member.findMany({ where: { userId: req.user.id }, select: { chatId: true } })]);
  const peers = await prisma.member.findMany({ where: { chatId: { in: mine.map((m) => m.chatId) }, userId: { not: req.user.id } }, select: { userId: true } });
  const ids = [...new Set([...fids, ...peers.map((p) => p.userId)])];
  const rows = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, isBanned: false, lastSeen: { gt: new Date(Date.now() - 40_000) } }, select: SAFE_USER, take: 50 }) : [];
  ok(res, { users: rows.map((u) => { const x = toUser(u); return { id: x._id, username: x.username, first_name: x.first_name, last_name: x.last_name, photo: x.photo }; }) });
}));

router.get('/users/search', auth, wrap(async (req, res) => {
  const rows = await prisma.bbSearch.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 12 });
  const users = await usersById(rows.map((r) => r.targetId));
  ok(res, { results: rows.filter((r) => users.has(r.targetId)).map((r) => ({ _id: r.targetId, user: users.get(r.targetId) })) });
}));
router.post('/users/search', auth, wrap(async (req, res) => {
  const term = String(req.body?.term || '').trim();
  if (term.length < 1) return ok(res, { results: [] });
  const rows = await prisma.user.findMany({
    where: { isBanned: false, id: { not: req.user.id }, blocking: { none: { blockedId: req.user.id } },
      OR: [{ username: { contains: term.toLowerCase() } }, { displayName: { contains: term, mode: 'insensitive' } }] },
    select: SAFE_USER, take: 20,
  });
  ok(res, { results: rows.map(toUser) });
}));
router.post('/users/search/add', auth, wrap(async (req, res) => {
  const t = String(req.body?.searchUser || '');
  if (t) await prisma.bbSearch.upsert({ where: { userId_targetId: { userId: req.user.id, targetId: t } }, update: { createdAt: new Date() }, create: { userId: req.user.id, targetId: t } }).catch(() => {});
  ok(res, {});
}));
router.post('/users/search/remove', auth, wrap(async (req, res) => {
  await prisma.bbSearch.deleteMany({ where: { userId: req.user.id, targetId: String(req.body?.searchUser || '') } });
  ok(res, {});
}));

router.get('/users/notifications', auth, wrap(async (req, res) => {
  const rows = await prisma.bbNotification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 40 });
  const users = await usersById(rows.map((r) => r.senderId));
  ok(res, { notifications: rows.map((n) => ({ _id: n.id, sender: users.get(n.senderId) || null, type: n.type, content: n.content, click: n.click, createdAt: n.createdAt, seen: n.seen ? 'seen' : 'unseen' })) });
}));
router.put('/users/notifications/:id/seen', auth, wrap(async (req, res) => {
  await prisma.bbNotification.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: { seen: true } });
  ok(res, { notification: { _id: req.params.id, seen: 'seen' } });
}));

/* ---- profile ---- */
async function profileUser(req, res) {
  const u = await prisma.user.findUnique({ where: { username: String(req.params.username).toLowerCase() }, select: SAFE_USER });
  if (!u) { fail(res, 404, 'User not found'); return null; }
  if (u.id !== req.user.id && await prisma.block.findFirst({ where: { blockerId: u.id, blockedId: req.user.id } })) { fail(res, 404, 'User not found'); return null; }
  return u;
}
router.get('/users/getProfile/:username', auth, wrap(async (req, res) => {
  const u = await profileUser(req, res); if (!u) return;
  const fids = await friendIds(u.id);
  const friends = [...(await usersById(fids.slice(0, 9))).values()];
  ok(res, { user: { ...toUser(u), friendsCount: fids.length }, friends, friendship: await friendshipOf(req.user.id, u.id) });
}));
router.get('/users/getProfile/:username/posts', auth, wrap(async (req, res) => {
  const u = await profileUser(req, res); if (!u) return;
  const rows = await prisma.bbPost.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, ...page(req) });
  const data = await postsOut(rows, req.user.id);
  res.json({ status: 'success', length: data.length, data });
}));
router.get('/users/getProfile/:username/photos', auth, wrap(async (req, res) => {
  const u = await profileUser(req, res); if (!u) return;
  const rows = await prisma.bbPost.findMany({ where: { userId: u.id, images: { isEmpty: false } }, orderBy: { createdAt: 'desc' }, take: 60, select: { id: true, images: true } });
  const resources = rows.flatMap((p) => p.images.map((url, i) => ({ id: `${p.id}-${i}`, url })));
  ok(res, { total_count: resources.length, resources });
}));

async function saveOne(req, field) {
  const f = (req.files || []).find((x) => x.fieldname === field) || req.file;
  if (!f) return null;
  if (!/\.(jpe?g|png|gif|webp)$/i.test(f.originalname || '')) {
    // Blob images from the cropper arrive without a file name
    f.originalname = (f.mimetype && f.mimetype.includes('png')) ? 'photo.png' : 'photo.jpg';
  }
  return (await saveFile(f, req.user.id)).fileUrl;
}
const anyFiles = upload.any();
router.all('/users/update/profile/photo', auth, anyFiles, wrap(async (req, res) => {
  const url = await saveOne(req, 'photo'); if (!url) return fail(res, 400, 'Photo required');
  const old = req.user.avatarUrl;
  await prisma.user.update({ where: { id: req.user.id }, data: { avatarUrl: url } });
  await prisma.bbPost.create({ data: { userId: req.user.id, type: 'profilePhoto', text: String(req.body?.text || '').slice(0, 500), images: [url] } });
  if (old) removeFileIfUnused(old);
  ok(res, { url });
}));
router.all('/users/update/profile/cover', auth, anyFiles, wrap(async (req, res) => {
  const url = await saveOne(req, 'photo'); if (!url) return fail(res, 400, 'Photo required');
  await prisma.user.update({ where: { id: req.user.id }, data: { cover: url } });
  await prisma.bbPost.create({ data: { userId: req.user.id, type: 'cover', images: [url] } });
  ok(res, { url });
}));
const DETAIL_KEYS = ['otherName', 'job', 'workplace', 'highSchool', 'college', 'currentCity', 'homeTown', 'relationship', 'instagram'];
router.all('/users/update/profile/details', auth, wrap(async (req, res) => {
  const src = req.body?.infos || req.body?.details || req.body || {};
  const details = {};
  for (const k of DETAIL_KEYS) if (typeof src[k] === 'string') details[k] = src[k].slice(0, 100);
  await prisma.user.update({ where: { id: req.user.id }, data: { details } });
  ok(res, { details });
}));

/* ============================== POSTS ============================== */
const postLimiter = rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });

router.get('/posts/getAllPosts', auth, wrap(async (req, res) => {
  const hidden = await prisma.block.findMany({ where: { OR: [{ blockerId: req.user.id }, { blockedId: req.user.id }] }, select: { blockerId: true, blockedId: true } });
  const ban = hidden.map((b) => (b.blockerId === req.user.id ? b.blockedId : b.blockerId));
  const rows = await prisma.bbPost.findMany({ where: { userId: { notIn: ban }, user: { isBanned: false } }, orderBy: { createdAt: 'desc' }, ...page(req) });
  const data = await postsOut(rows, req.user.id);
  res.json({ status: 'success', length: data.length, data });
}));

async function createPost(req, res, images = []) {
  const b = req.body || {};
  const type = ['normal', 'background', 'image', 'share'].includes(b.type) ? b.type : 'normal';
  const text = String(b.text || '').slice(0, 5000);
  const data = { userId: req.user.id, type, text, images };
  if (type === 'background') {
    const bg = parseInt(b.background, 10);
    if (!(bg >= 1 && bg <= 20)) return fail(res, 400, 'Bad background');
    data.background = bg;
  }
  if (type === 'share') {
    const s = await prisma.bbPost.findUnique({ where: { id: String(b.sharedID || '') } });
    if (!s) return fail(res, 404, 'Post not found');
    data.sharedId = s.id;
  }
  if (type !== 'share' && !text.trim() && !images.length) return fail(res, 400, 'Empty post');
  const p = await prisma.bbPost.create({ data });
  if (type === 'share') {
    const orig = await prisma.bbPost.findUnique({ where: { id: data.sharedId }, select: { userId: true } });
    if (orig) await notify(orig.userId, req.user, 'share', 'shared your post', `/post/${p.id}`);
  }
  res.status(201).json({ status: 'success', data: (await postsOut([p], req.user.id))[0] });
}
router.post('/posts/createPost', auth, postLimiter, wrap((req, res) => createPost(req, res)));
router.post('/posts/createPost/images', auth, postLimiter, upload.array('images', 10), wrap(async (req, res) => {
  const urls = [];
  for (const f of req.files || []) urls.push((await saveFile(f, req.user.id)).fileUrl);
  req.body.type = 'image';
  return createPost(req, res, urls);
}));

router.get('/posts/comments/:postId', auth, wrap(async (req, res) => {
  const rows = await prisma.bbComment.findMany({ where: { postId: req.params.postId, parentId: null }, orderBy: { createdAt: 'desc' }, include: { replies: { orderBy: { createdAt: 'asc' } } }, ...page(req, 4) });
  const users = await usersById(rows.flatMap((c) => [c.userId, ...c.replies.map((r) => r.userId)]));
  res.json({ status: 'success', datalength: rows.length, data: { comments: rows.map((c) => commentOut(c, users)) } });
}));

async function addComment(req, res, parentId) {
  const text = String(req.body?.text || '').slice(0, 2000);
  const f = (req.files || []).find((x) => x.fieldname === 'photo');
  let photo = null;
  if (f) { f.originalname = /\.(jpe?g|png|gif|webp)$/i.test(f.originalname || '') ? f.originalname : 'photo.jpg'; photo = (await saveFile(f, req.user.id)).fileUrl; }
  if (!text.trim() && !photo) { fail(res, 400, 'Empty comment'); return null; }
  return { text, photo };
}
router.post('/posts/AddComment/:postId', auth, postLimiter, anyFiles, wrap(async (req, res) => {
  const post = await prisma.bbPost.findUnique({ where: { id: req.params.postId }, select: { id: true, userId: true } });
  if (!post) return fail(res, 404, 'Post not found');
  if (post.userId !== req.user.id && await blockedEitherWay(post.userId, req.user.id)) return fail(res, 403, 'Not allowed');
  const c = await addComment(req, res); if (!c) return;
  const row = await prisma.bbComment.create({ data: { postId: post.id, userId: req.user.id, ...c }, include: { replies: true } });
  await notify(post.userId, req.user, 'comment', 'commented on your post', `/post/${post.id}`);
  const users = await usersById([req.user.id]);
  const count = await prisma.bbComment.count({ where: { postId: post.id } });
  ok(res, { commendData: commentOut(row, users), commentsCount: count });
}));
router.post('/posts/comments/:commentId/reply', auth, postLimiter, anyFiles, wrap(async (req, res) => {
  const parent = await prisma.bbComment.findUnique({ where: { id: req.params.commentId } });
  if (!parent) return fail(res, 404, 'Comment not found');
  const rootId = parent.parentId || parent.id;
  const c = await addComment(req, res); if (!c) return;
  await prisma.bbComment.create({ data: { postId: parent.postId, userId: req.user.id, parentId: rootId, ...c } });
  await notify(parent.userId, req.user, 'reply', 'replied to your comment', `/post/${parent.postId}`);
  const replies = await prisma.bbComment.findMany({ where: { parentId: rootId }, orderBy: { createdAt: 'asc' } });
  const users = await usersById(replies.map((r) => r.userId));
  ok(res, { replies: replies.map((r) => commentOut({ ...r, replies: [] }, users)) });
}));
router.put('/posts/comments/:id/like', auth, wrap(async (req, res) => {
  const c = await prisma.bbComment.findUnique({ where: { id: req.params.id } });
  if (!c) return fail(res, 404, 'Comment not found');
  const has = c.likes.includes(req.user.id);
  const likes = has ? c.likes.filter((x) => x !== req.user.id) : [...c.likes, req.user.id];
  await prisma.bbComment.update({ where: { id: c.id }, data: { likes } });
  if (!has) await notify(c.userId, req.user, 'like', 'liked your comment', `/post/${c.postId}`);
  ok(res, { likes });
}));

router.put('/posts/:id/reacts', auth, wrap(async (req, res) => {
  const type = String(req.body?.type || 'like');
  if (!REACTS.includes(type)) return fail(res, 400, 'Bad reaction');
  const post = await prisma.bbPost.findUnique({ where: { id: req.params.id }, select: { id: true, userId: true } });
  if (!post) return fail(res, 404, 'Post not found');
  const where = { postId_userId: { postId: post.id, userId: req.user.id } };
  const cur = await prisma.bbReact.findUnique({ where });
  if (cur && cur.type === type) await prisma.bbReact.delete({ where });
  else {
    await prisma.bbReact.upsert({ where, update: { type }, create: { postId: post.id, userId: req.user.id, type } });
    if (!cur) await notify(post.userId, req.user, 'react', `${type} your post`, `/post/${post.id}`);
  }
  ok(res, { reactions: await reactionSummary(post.id, req.user.id) });
}));
router.get('/posts/:id/reacts', auth, wrap(async (req, res) => {
  const rows = await prisma.bbReact.findMany({ where: { postId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 200 });
  const users = await usersById(rows.map((r) => r.userId));
  const types = {}; for (const r of rows) types[r.type] = (types[r.type] || 0) + 1;
  ok(res, { stats: { types }, reacts: rows.map((r) => ({ _id: r.id, type: r.type, user: users.get(r.userId) })) });
}));

router.get('/posts/:id', auth, wrap(async (req, res) => {
  const p = await prisma.bbPost.findUnique({ where: { id: req.params.id } });
  if (!p || (p.userId !== req.user.id && await blockedEitherWay(p.userId, req.user.id))) return fail(res, 404, 'Post not found');
  ok(res, { post: (await postsOut([p], req.user.id))[0] });
}));
// The UI deletes with PUT /posts/:id
router.put('/posts/:id', auth, wrap(async (req, res) => {
  const p = await prisma.bbPost.findUnique({ where: { id: req.params.id } });
  if (!p || p.userId !== req.user.id) return fail(res, 404, 'Post not found');
  await prisma.bbPost.delete({ where: { id: p.id } });
  for (const url of p.images) removeFileIfUnused(url);
  ok(res, {});
}));

/* ============================== FRIENDS ============================== */
router.get('/friends/friendsPage', auth, wrap(async (req, res) => {
  const me = req.user.id;
  const rows = await prisma.bbFriend.findMany({ where: { OR: [{ senderId: me }, { recipientId: me }] }, orderBy: { createdAt: 'desc' } });
  const users = await usersById(rows.flatMap((r) => [r.senderId, r.recipientId]));
  ok(res, {
    recivedRequests: rows.filter((r) => r.status === 'PENDING' && r.recipientId === me).map((r) => ({ _id: r.id, sender: users.get(r.senderId) })).filter((r) => r.sender),
    sentRequests: rows.filter((r) => r.status === 'PENDING' && r.senderId === me).map((r) => ({ _id: r.id, recipient: users.get(r.recipientId) })).filter((r) => r.recipient),
    friendLists: rows.filter((r) => r.status === 'ACCEPTED').map((r) => users.get(r.senderId === me ? r.recipientId : r.senderId)).filter(Boolean),
  });
}));

router.put('/friends/:type/:id', auth, wrap(async (req, res) => {
  const me = req.user, { type, id } = req.params;
  const friendship = (other) => friendshipOf(me.id, other);
  if (type === 'add') {
    if (id === me.id) return fail(res, 400, 'Cannot add yourself');
    const other = await prisma.user.findUnique({ where: { id }, select: { id: true, isBanned: true } });
    if (!other || other.isBanned || await blockedEitherWay(me.id, id)) return fail(res, 404, 'User not found');
    const ex = await prisma.bbFriend.findFirst({ where: { OR: [{ senderId: me.id, recipientId: id }, { senderId: id, recipientId: me.id }] } });
    if (!ex) {
      await prisma.bbFriend.create({ data: { senderId: me.id, recipientId: id } });
      await prisma.bbFollow.upsert({ where: { followerId_followingId: { followerId: me.id, followingId: id } }, update: {}, create: { followerId: me.id, followingId: id } });
      await notify(id, me, 'friend', 'sent you a friend request', `/friends`);
    }
    return ok(res, { friendship: await friendship(id) });
  }
  if (type === 'follow' || type === 'unfollow') {
    if (type === 'follow') await prisma.bbFollow.upsert({ where: { followerId_followingId: { followerId: me.id, followingId: id } }, update: {}, create: { followerId: me.id, followingId: id } });
    else await prisma.bbFollow.deleteMany({ where: { followerId: me.id, followingId: id } });
    return ok(res, { friendship: await friendship(id) });
  }
  // acceptRequest | remove | cancel — id is the request id
  const r = await prisma.bbFriend.findUnique({ where: { id } });
  if (!r || (r.senderId !== me.id && r.recipientId !== me.id)) return fail(res, 404, 'Request not found');
  const other = r.senderId === me.id ? r.recipientId : r.senderId;
  if (type === 'acceptRequest') {
    if (r.recipientId !== me.id || r.status !== 'PENDING') return fail(res, 400, 'Cannot accept');
    await prisma.bbFriend.update({ where: { id }, data: { status: 'ACCEPTED' } });
    await prisma.bbFollow.upsert({ where: { followerId_followingId: { followerId: me.id, followingId: other } }, update: {}, create: { followerId: me.id, followingId: other } });
    await notify(other, me, 'friend', 'accepted your friend request', `/profile/${me.username}`);
  } else if (type === 'remove' || type === 'cancel') {
    await prisma.bbFriend.delete({ where: { id } });
    await prisma.bbFollow.deleteMany({ where: { OR: [{ followerId: me.id, followingId: other }, { followerId: other, followingId: me.id }] } });
  } else return fail(res, 404, 'Unknown action');
  ok(res, { friendship: await friendship(other) });
}));

/* ======================= CHATS & MESSAGES (shared with Layzzchat) ======================= */
const chatInclude = { members: { include: { user: { select: SAFE_USER } } } };

async function chatOut(chat, meId) {
  const last = await prisma.message.findFirst({ where: { chatId: chat.id, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  const others = chat.members.filter((m) => m.userId !== meId);
  const group = chat.type === 'GROUP';
  const peer = others[0]?.user || chat.members[0]?.user;
  const users = chat.members.map((m) => toUser(m.user));
  let latestMessage;
  if (last) {
    const sender = chat.members.find((m) => m.userId === last.senderId)?.user;
    latestMessage = messageOut(last, sender ? toUser(sender) : null, chat);
  }
  return {
    _id: chat.id, type: group ? 'group' : 'private',
    chatName: group ? (chat.title || 'Group') : (peer ? `${nameParts(peer.displayName).first_name} ${nameParts(peer.displayName).last_name}`.trim() : 'Chat'),
    photo: group ? (chat.avatarUrl || '') : (peer?.avatarUrl || ''),
    users: group ? users : others.length ? others.map((m) => toUser(m.user)) : users,
    groupAdmin: chat.members.filter((m) => m.isAdmin).map((m) => toUser(m.user)),
    theme: chat.theme || 1, latestMessage, updatedAt: last?.createdAt || chat.createdAt, createdAt: chat.createdAt,
  };
}
function messageOut(m, sender, chat) {
  const seen = chat.members.some((mb) => mb.userId !== m.senderId && mb.lastReadAt >= m.createdAt);
  const content = m.type === 'TEXT' ? (m.text || '') : m.fileUrl ? m.fileUrl : (m.text || '');
  return { _id: m.id, content, type: m.text === '👍' ? 'like' : 'text', chat: m.chatId, sender, seen: seen ? 'seen' : 'unseen', createdAt: m.createdAt, updatedAt: m.createdAt };
}
async function myChat(chatId, meId) {
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, include: chatInclude });
  if (!chat || !chat.members.some((m) => m.userId === meId)) return null;
  return chat;
}

router.get('/chats', auth, wrap(async (req, res) => {
  const chats = await prisma.chat.findMany({ where: { members: { some: { userId: req.user.id } } }, include: chatInclude, take: 100 });
  const out = await Promise.all(chats.filter((c) => c.type === 'GROUP' || c.members.length > 1).map((c) => chatOut(c, req.user.id)));
  out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  ok(res, { chats: out }, { results: out.length });
}));

router.post('/chats/create/private', auth, wrap(async (req, res) => {
  const other = String(req.body?.userId || '');
  if (!other || other === req.user.id) return fail(res, 400, 'Bad user');
  const u = await prisma.user.findUnique({ where: { id: other }, select: { id: true, isBanned: true } });
  if (!u || u.isBanned || await blockedEitherWay(req.user.id, other)) return fail(res, 404, 'User not found');
  const key = [req.user.id, other].sort().join(':');
  let chat = await prisma.chat.findUnique({ where: { privateKey: key }, include: chatInclude });
  if (!chat) {
    try {
      chat = await prisma.chat.create({ data: { type: 'PRIVATE', privateKey: key, members: { create: [{ userId: req.user.id }, { userId: other }] } }, include: chatInclude });
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      chat = await prisma.chat.findUnique({ where: { privateKey: key }, include: chatInclude });
    }
  }
  ok(res, { chat: await chatOut(chat, req.user.id) });
}));

router.post('/chats/create/group', auth, wrap(async (req, res) => {
  let users = req.body?.users; if (typeof users === 'string') { try { users = JSON.parse(users); } catch { users = []; } }
  const ids = [...new Set((Array.isArray(users) ? users : []).map((u) => String(u?._id || u?.id || u)).filter((x) => x && x !== req.user.id))].slice(0, 50);
  const title = String(req.body?.chatName || '').trim().slice(0, 50);
  if (ids.length < 1) return fail(res, 400, 'Add at least one member');
  if (!title) return fail(res, 400, 'Group name is required');
  const valid = await prisma.user.findMany({ where: { id: { in: ids }, isBanned: false }, select: { id: true } });
  const chat = await prisma.chat.create({ data: { type: 'GROUP', title, ownerId: req.user.id, members: { create: [{ userId: req.user.id, isAdmin: true }, ...valid.map((v) => ({ userId: v.id }))] } }, include: chatInclude });
  ok(res, { chat: await chatOut(chat, req.user.id) });
}));

async function adminChat(req, res) {
  const chat = await myChat(String(req.body?.chatId || ''), req.user.id);
  if (!chat || chat.type !== 'GROUP') { fail(res, 404, 'Group not found'); return null; }
  if (!chat.members.find((m) => m.userId === req.user.id)?.isAdmin) { fail(res, 403, 'Only admins can do this'); return null; }
  return chat;
}
router.put('/chats/group/rename', auth, wrap(async (req, res) => {
  const chat = await adminChat(req, res); if (!chat) return;
  const chatName = String(req.body?.chatName || '').trim().slice(0, 50);
  if (!chatName) return fail(res, 400, 'Name required');
  await prisma.chat.update({ where: { id: chat.id }, data: { title: chatName } });
  ok(res, { chatName, user: req.user.id });
}));
router.put('/chats/group/add', auth, wrap(async (req, res) => {
  const chat = await adminChat(req, res); if (!chat) return;
  const userId = String(req.body?.userId || '');
  const u = await prisma.user.findUnique({ where: { id: userId }, select: SAFE_USER });
  if (!u) return fail(res, 404, 'User not found');
  await prisma.member.upsert({ where: { chatId_userId: { chatId: chat.id, userId } }, update: {}, create: { chatId: chat.id, userId } });
  ok(res, { user: toUser(u) });
}));
router.put('/chats/group/remove', auth, wrap(async (req, res) => {
  const chat = await adminChat(req, res); if (!chat) return;
  const userId = String(req.body?.userId || '');
  const m = chat.members.find((x) => x.userId === userId);
  if (!m) return fail(res, 404, 'Not a member');
  await prisma.member.delete({ where: { chatId_userId: { chatId: chat.id, userId } } });
  ok(res, { user: userId, deletedUser: toUser(m.user) });
}));
router.put('/chats/:id/theme', auth, wrap(async (req, res) => {
  const chat = await myChat(req.params.id, req.user.id); if (!chat) return fail(res, 404, 'Chat not found');
  const theme = parseInt(req.body?.theme, 10);
  if (!(theme >= 1 && theme <= 30)) return fail(res, 400, 'Bad theme');
  await prisma.chat.update({ where: { id: chat.id }, data: { theme } });
  ok(res, { theme, name: `${nameParts(req.user.displayName).first_name} ${nameParts(req.user.displayName).last_name}`.trim(), user: req.user.id });
}));

router.get('/messages/:chatId', auth, wrap(async (req, res) => {
  const chat = await myChat(req.params.chatId, req.user.id); if (!chat) return fail(res, 404, 'Chat not found');
  const rows = await prisma.message.findMany({ where: { chatId: chat.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, ...page(req, 100) });
  const bySender = new Map(chat.members.map((m) => [m.userId, toUser(m.user)]));
  ok(res, { chat: await chatOut(chat, req.user.id), messages: rows.map((m) => messageOut(m, bySender.get(m.senderId) || null, chat)) }, { results: rows.length });
}));
router.put('/messages/:chatId/send', auth, rateLimit({ windowMs: 10_000, limit: 30, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false }), wrap(async (req, res) => {
  const chat = await myChat(req.params.chatId, req.user.id); if (!chat) return fail(res, 404, 'Chat not found');
  if (chat.type === 'PRIVATE') {
    const other = chat.members.find((m) => m.userId !== req.user.id);
    if (other && await blockedEitherWay(req.user.id, other.userId)) return fail(res, 403, 'You cannot message this user');
  }
  const text = req.body?.type === 'like' ? '👍' : String(req.body?.content || '').trim().slice(0, 4000);
  if (!text) return fail(res, 400, 'Empty message');
  const m = await prisma.message.create({ data: { chatId: chat.id, senderId: req.user.id, type: 'TEXT', text } });
  await prisma.member.update({ where: { chatId_userId: { chatId: chat.id, userId: req.user.id } }, data: { lastReadAt: m.createdAt } }).catch(() => {});
  ok(res, { message: messageOut(m, toUser(req.user), chat) });
}));
router.put('/messages/:id/seen', auth, wrap(async (req, res) => {
  const m = await prisma.message.findUnique({ where: { id: req.params.id } });
  if (!m) return fail(res, 404, 'Message not found');
  const chat = await myChat(m.chatId, req.user.id); if (!chat) return fail(res, 404, 'Message not found');
  await prisma.member.update({ where: { chatId_userId: { chatId: chat.id, userId: req.user.id } }, data: { lastReadAt: new Date() } });
  const fresh = await myChat(m.chatId, req.user.id);
  const sender = fresh.members.find((x) => x.userId === m.senderId)?.user;
  ok(res, { message: messageOut(m, sender ? toUser(sender) : null, fresh), unseenMessages: await unseenMessagesOf(req.user.id) });
}));

// Multer / unknown errors → the same JSON shape the UI expects
router.use((err, _req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return fail(res, 400, 'File too large (max 4 MB)');
  if (err?.name === 'MulterError') return fail(res, 400, err.message);
  next(err);
});

export default router;
