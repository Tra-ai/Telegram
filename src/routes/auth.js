import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { signToken, requireAuth, publicUser, invalidateUser } from '../auth.js';
import { makeVerifier, normalizePhone, userForPhone, PhoneError } from '../services/sms.js';

const router = Router();
// Separate buckets; successful logins don't count (users behind one NAT won't lock each other out)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.post('/register', registerLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const displayName = String(req.body?.displayName || username).trim().slice(0, 50);
  if (!/^[a-z0-9_]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username: 3-32 chars, a-z 0-9 _' });
  if (/bot$/.test(username)) return res.status(400).json({ error: 'Usernames ending in "bot" are reserved for bots' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Password must be 8-100 characters' });
  if (await prisma.user.findUnique({ where: { username } })) return res.status(409).json({ error: 'Username already taken' });
  try {
    const user = await prisma.user.create({
      data: { username, displayName: displayName || username, passwordHash: await bcrypt.hash(password, 10) },
    });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Username already taken' });
    throw e;
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash)))
    return res.status(401).json({ error: 'Wrong username or password' });
  if (user.isBanned) return res.status(403).json({ error: 'This account is banned' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// ---- Phone (SMS code) sign-in / sign-up ----
const sms = makeVerifier();
const CC = process.env.DEFAULT_COUNTRY_CODE || '855';
const phoneKey = (req) => normalizePhone(req.body?.phone, CC) || 'x';
const startIpLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false });
const startPhoneLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 3, keyGenerator: phoneKey, validate: false, standardHeaders: true, legacyHeaders: false });
const checkLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, keyGenerator: phoneKey, validate: false, standardHeaders: true, legacyHeaders: false });
const phoneFail = (res, e) => {
  if (e instanceof PhoneError) return res.status(e.status).json({ error: e.message });
  console.error(e); return res.status(500).json({ error: 'Server error' });
};

router.get('/config', (_req, res) => res.json({ phone: sms.configured }));

router.post('/phone/start', startIpLimiter, startPhoneLimiter, async (req, res) => {
  const phone = normalizePhone(req.body?.phone, CC);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  try { await sms.start(phone); res.json({ ok: true, phone }); } catch (e) { phoneFail(res, e); }
});

router.post('/phone/verify', checkLimiter, async (req, res) => {
  const phone = normalizePhone(req.body?.phone, CC);
  const code = String(req.body?.code || '').trim();
  if (!phone || !/^\d{4,8}$/.test(code)) return res.status(400).json({ error: 'Invalid phone number or code' });
  try {
    if (!(await sms.check(phone, code))) return res.status(401).json({ error: 'Wrong or expired code' });
    const { user, created } = await userForPhone(prisma, phone, req.body?.displayName);
    if (user.isBanned) return res.status(403).json({ error: 'This account is banned' });
    res.status(created ? 201 : 200).json({ token: signToken(user), user: publicUser(user), created });
  } catch (e) { phoneFail(res, e); }
});

const passwordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });

// Change password → every older token (all devices) stops working; returns a fresh token for this device
router.post('/password', requireAuth, passwordLimiter, async (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  if (!(await bcrypt.compare(current, req.user.passwordHash))) return res.status(401).json({ error: 'Current password is wrong' });
  if (next.length < 8 || next.length > 100) return res.status(400).json({ error: 'Password must be 8-100 characters' });
  if (next === current) return res.status(400).json({ error: 'New password must be different' });
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash: await bcrypt.hash(next, 10), tokenVersion: { increment: 1 } },
  });
  invalidateUser(user.id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

// "Log out everywhere": revoke all tokens, hand back a new one for this device
router.post('/logout-all', requireAuth, passwordLimiter, async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.user.id }, data: { tokenVersion: { increment: 1 } } });
  invalidateUser(user.id);
  res.json({ token: signToken(user) });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

export default router;
