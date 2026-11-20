import jwt from 'jsonwebtoken';
import { prisma } from './db.js';

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) throw new Error('JWT_SECRET missing or too short (use 32+ random chars)');

// Short-lived scoped tokens (WebAuthn challenges, admin "pass"). They use `uid`, never `sub`, so they can't be used as login tokens.
export const signScoped = (payload, expiresIn) => jwt.sign(payload, SECRET, { expiresIn });
export const verifyScoped = (token) => { try { return jwt.verify(token, SECRET); } catch { return null; } };

export const signToken = (user) => jwt.sign({ sub: user.id, v: user.tokenVersion ?? 0 }, SECRET, { expiresIn: '30d' });

// Tiny per-instance cache so polling doesn't hit the DB on every request (ban/role changes apply within CACHE_MS)
const CACHE_MS = 10_000;
const cache = new Map();
export const invalidateUser = (id) => cache.delete(id);

export async function userFromToken(token) {
  if (!token) return null;
  try {
    const { sub, v } = jwt.verify(token, SECRET);
    if (!sub) return null;
    let hit = cache.get(sub);
    if (hit && hit.exp < Date.now()) hit = null;
    const user = hit ? hit.user : await prisma.user.findUnique({ where: { id: sub } });
    if (!user || user.isBanned || (v ?? 0) !== user.tokenVersion) { cache.delete(sub); return null; }
    if (!hit) {
      if (cache.size > 5000) cache.clear();
      cache.set(sub, { user, exp: Date.now() + CACHE_MS });
    }
    // Every authenticated request is a heartbeat (throttled to 1 write / 20s)
    if (Date.now() - user.lastSeen.getTime() > 20_000) {
      user.lastSeen = new Date();
      await prisma.user.update({ where: { id: user.id }, data: { lastSeen: user.lastSeen } }).catch(() => {});
    }
    return user;
  } catch {
    return null;
  }
}

export async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const user = await userFromToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });
  next();
}

export const publicUser = (u) => ({
  id: u.id, username: u.username, displayName: u.displayName, bio: u.bio,
  avatarUrl: u.avatarUrl, role: u.role, lastSeen: u.lastSeen, createdAt: u.createdAt,
});
