// Phone sign-in: codes are sent and checked by Twilio Verify (it generates, expires and rate-limits the codes).
// Needs env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID.  Optional: DEFAULT_COUNTRY_CODE (default 855).
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export class PhoneError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// "012 345 678" -> +85512345678 ; "+855 12 345 678" and "00855..." work too. Returns null when it can't be a phone number.
export function normalizePhone(input, cc = '855') {
  let s = String(input || '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0')) s = '+' + cc + s.slice(1);
  else if (!s.startsWith('+')) s = '+' + (s.startsWith(cc) ? '' : cc) + s;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

export function makeVerifier(env = process.env, fetchFn = globalThis.fetch) {
  const sid = env.TWILIO_ACCOUNT_SID, tok = env.TWILIO_AUTH_TOKEN, svc = env.TWILIO_VERIFY_SID;
  const configured = !!(sid && tok && svc);
  const call = async (path, form) => {
    const res = await fetchFn(`https://verify.twilio.com/v2/Services/${svc}/${path}`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, body };
  };
  return {
    configured,
    async start(phone) {
      if (!configured) throw new PhoneError(503, 'SMS login is not set up');
      const r = await call('Verifications', { To: phone, Channel: 'sms' });
      if (r.ok) return;
      if (r.status === 429 || r.body.code === 60203) throw new PhoneError(429, 'Too many codes sent. Try again later');
      if (r.body.code === 60200 || r.body.code === 21211) throw new PhoneError(400, 'Invalid phone number');
      console.error('twilio start failed', r.status, r.body.code, r.body.message);
      throw new PhoneError(502, 'Could not send the code. Try again later');
    },
    async check(phone, code) {
      if (!configured) throw new PhoneError(503, 'SMS login is not set up');
      const r = await call('VerificationCheck', { To: phone, Code: code });
      if (r.ok) return r.body.status === 'approved';
      if (r.status === 404 || r.body.code === 20404) return false; // expired, already used, or never sent
      if (r.status === 429) throw new PhoneError(429, 'Too many attempts. Request a new code');
      console.error('twilio check failed', r.status, r.body.code, r.body.message);
      throw new PhoneError(502, 'Could not verify the code. Try again later');
    },
  };
}

// After the code is verified: sign in the owner of this number, or create the account.
export async function userForPhone(db, phone, displayName) {
  const found = await db.user.findUnique({ where: { phone } });
  if (found) return { user: found, created: false };
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 8); // no password: sign in by SMS only
  const name = String(displayName || '').trim().slice(0, 50) || 'User';
  for (let i = 0; i < 5; i++) {
    const username = 'user' + String(crypto.randomInt(0, 1e8)).padStart(8, '0'); // never ends in "bot"
    try {
      return { user: await db.user.create({ data: { username, displayName: name, passwordHash, phone } }), created: true };
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      const again = await db.user.findUnique({ where: { phone } }); // two requests raced on the same phone
      if (again) return { user: again, created: false };
    }
  }
  throw new PhoneError(500, 'Could not create the account');
}
