import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { signScoped, verifyScoped } from '../auth.js';
import { b64u, verifyRegistration, verifyAssertion, PasskeyError } from '../services/webauthn.js';

// Face / fingerprint / screen-lock gate for the admin dashboard (WebAuthn passkeys, verified on the server).
// Mounted under /api/admin/passkey AFTER requireAuth + requireAdmin; everything else in /api/admin needs requirePass.
const BYPASS = process.env.ADMIN_PASSKEY_BYPASS === '1'; // emergency switch if the admin loses every device
const PASS_TTL = '8h';
const MAX_KEYS = 5;

const rp = (req) => ({
  rpId: (process.env.WEBAUTHN_RP_ID || req.hostname).toLowerCase(),
  origins: [process.env.WEBAUTHN_ORIGIN || `${req.protocol}://${req.get('host')}`],
});

function hasPass(req) {
  const p = verifyScoped(String(req.headers['x-admin-pass'] || ''));
  return !!p && p.purpose === 'admin-pass' && p.uid === req.user.id && (p.v ?? 0) === (req.user.tokenVersion ?? 0);
}

export async function requirePass(req, res, next) {
  if (BYPASS) return next();
  const n = await prisma.adminPasskey.count({ where: { userId: req.user.id } });
  if (n === 0 || hasPass(req)) return next();
  res.status(403).json({ error: 'ត្រូវស្កេនមុខ ឬម្រាមដៃ ដើម្បីចូល', code: 'PASSKEY_REQUIRED' });
}

const router = Router();
const limiter = rateLimit({ windowMs: 10 * 60_000, limit: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user.id,
  handler: (_req, res) => res.status(429).json({ error: 'ព្យាយាមច្រើនពេក សូមរង់ចាំបន្តិច' }) });
router.use(limiter);

const state = (req, purpose, ch) => signScoped({ uid: req.user.id, purpose, ch }, '5m');
const readState = (req, purpose) => {
  const s = verifyScoped(String(req.body?.state || ''));
  if (!s || s.purpose !== purpose || s.uid !== req.user.id) throw new PasskeyError('Expired, please try again');
  return s.ch;
};
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof PasskeyError) return res.status(400).json({ error: 'ការស្កេនមិនត្រឹមត្រូវ៖ ' + e.message });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
};
// registering / deleting a passkey needs an existing pass once the gate is on (so a stolen token can't add its own)
const gate = async (req, res) => {
  if (BYPASS) return true;
  const n = await prisma.adminPasskey.count({ where: { userId: req.user.id } });
  if (n === 0 || hasPass(req)) return true;
  res.status(403).json({ error: 'ត្រូវស្កេនមុខ ឬម្រាមដៃជាមុន', code: 'PASSKEY_REQUIRED' });
  return false;
};

router.get('/status', wrap(async (req, res) => {
  const keys = await prisma.adminPasskey.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'asc' } });
  const enabled = keys.length > 0 && !BYPASS;
  res.json({ enabled, verified: !enabled || hasPass(req), bypass: BYPASS,
    passkeys: keys.map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })) });
}));

router.post('/register/options', wrap(async (req, res) => {
  if (!(await gate(req, res))) return;
  const keys = await prisma.adminPasskey.findMany({ where: { userId: req.user.id } });
  if (keys.length >= MAX_KEYS) return res.status(400).json({ error: `អតិបរមា ${MAX_KEYS} ឧបករណ៍` });
  const ch = b64u.enc(crypto.randomBytes(32));
  res.json({
    state: state(req, 'pk-reg', ch),
    options: {
      challenge: ch, rp: { name: 'Layzzchat Admin', id: rp(req).rpId },
      user: { id: b64u.enc(Buffer.from(req.user.id)), name: req.user.username, displayName: req.user.displayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none', timeout: 60_000,
      excludeCredentials: keys.map((k) => ({ type: 'public-key', id: k.credentialId })),
    },
  });
}));

router.post('/register/verify', wrap(async (req, res) => {
  if (!(await gate(req, res))) return;
  const ch = readState(req, 'pk-reg');
  const { rpId, origins } = rp(req);
  const v = verifyRegistration({ credential: req.body.credential, challenge: ch, rpId, origins });
  if (await prisma.adminPasskey.count({ where: { userId: req.user.id } }) >= MAX_KEYS) return res.status(400).json({ error: `អតិបរមា ${MAX_KEYS} ឧបករណ៍` });
  const name = String(req.body?.name || '').trim().slice(0, 40) || 'ឧបករណ៍';
  const key = await prisma.adminPasskey.create({ data: { userId: req.user.id, name, ...v } }).catch(() => null);
  if (!key) return res.status(400).json({ error: 'ឧបករណ៍នេះបានចុះឈ្មោះរួចហើយ' });
  // the admin who just enrolled is verified right away
  res.status(201).json({ ok: true, pass: signScoped({ uid: req.user.id, purpose: 'admin-pass', v: req.user.tokenVersion ?? 0 }, PASS_TTL) });
}));

router.post('/login/options', wrap(async (req, res) => {
  const keys = await prisma.adminPasskey.findMany({ where: { userId: req.user.id } });
  if (!keys.length) return res.status(400).json({ error: 'មិនទាន់មានឧបករណ៍ស្កេន' });
  const ch = b64u.enc(crypto.randomBytes(32));
  res.json({
    state: state(req, 'pk-auth', ch),
    options: { challenge: ch, rpId: rp(req).rpId, userVerification: 'required', timeout: 60_000,
      allowCredentials: keys.map((k) => ({ type: 'public-key', id: k.credentialId })) },
  });
}));

router.post('/login/verify', wrap(async (req, res) => {
  const ch = readState(req, 'pk-auth');
  const key = await prisma.adminPasskey.findFirst({ where: { userId: req.user.id, credentialId: String(req.body?.credential?.id || '') } });
  if (!key) throw new PasskeyError('Unknown device');
  const { rpId, origins } = rp(req);
  const counter = verifyAssertion({ credential: req.body.credential, challenge: ch, rpId, origins, stored: key });
  await prisma.adminPasskey.update({ where: { id: key.id }, data: { counter, lastUsedAt: new Date() } });
  res.json({ pass: signScoped({ uid: req.user.id, purpose: 'admin-pass', v: req.user.tokenVersion ?? 0 }, PASS_TTL) });
}));

router.delete('/:id', wrap(async (req, res) => {
  if (!(await gate(req, res))) return;
  const r = await prisma.adminPasskey.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
  res.json({ ok: r.count > 0 });
}));

export default router;
