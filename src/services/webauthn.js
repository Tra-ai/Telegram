// Minimal WebAuthn (passkey) verification with no extra dependencies.
// Registration uses attestation "none"; we read the credential public key and verify assertions with node:crypto.
import crypto from 'node:crypto';

export class PasskeyError extends Error {}
const fail = (m) => { throw new PasskeyError(m); };
export const b64u = { enc: (b) => Buffer.from(b).toString('base64url'), dec: (s) => Buffer.from(String(s ?? ''), 'base64url') };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---- tiny CBOR decoder (ints, byte/text strings, arrays, maps, true/false/null) ----
function cborRead(buf, off, depth = 0) {
  if (depth > 8 || off >= buf.length) fail('Bad CBOR');
  const ib = buf[off++], major = ib >> 5, info = ib & 31;
  if (major === 7) { if (info === 20) return [false, off]; if (info === 21) return [true, off]; if (info === 22 || info === 23) return [null, off]; fail('Unsupported CBOR'); }
  let n = info;
  if (info === 24) { n = buf[off]; off += 1; } else if (info === 25) { n = buf.readUInt16BE(off); off += 2; } else if (info === 26) { n = buf.readUInt32BE(off); off += 4; } else if (info > 26) fail('Unsupported CBOR length');
  switch (major) {
    case 0: return [n, off];
    case 1: return [-1 - n, off];
    case 2: case 3: {
      if (off + n > buf.length) fail('Bad CBOR');
      const v = buf.subarray(off, off + n);
      return [major === 3 ? v.toString('utf8') : v, off + n];
    }
    case 4: { if (n > 1000) fail('Bad CBOR'); const a = []; for (let i = 0; i < n; i++) { let v; [v, off] = cborRead(buf, off, depth + 1); a.push(v); } return [a, off]; }
    case 5: { if (n > 1000) fail('Bad CBOR'); const m = new Map(); for (let i = 0; i < n; i++) { let k, v; [k, off] = cborRead(buf, off, depth + 1); [v, off] = cborRead(buf, off, depth + 1); m.set(k, v); } return [m, off]; }
    default: fail('Unsupported CBOR');
  }
}

function parseAuthData(buf) {
  if (buf.length < 37) fail('Bad authenticator data');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], counter: buf.readUInt32BE(33), att: null };
  if (out.flags & 0x40) {
    if (buf.length < 55) fail('Bad authenticator data');
    const idLen = buf.readUInt16BE(53);
    if (idLen < 16 || idLen > 1024 || 55 + idLen > buf.length) fail('Bad credential id');
    out.att = { credId: buf.subarray(55, 55 + idLen), cose: cborRead(buf, 55 + idLen)[0] };
  }
  return out;
}

function coseToJwk(c) {
  if (!(c instanceof Map)) fail('Bad public key');
  const kty = c.get(1), alg = c.get(3);
  if (kty === 2 && alg === -7 && c.get(-1) === 1) {
    const x = c.get(-2), y = c.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) fail('Bad public key');
    return { kty: 'EC', crv: 'P-256', x: b64u.enc(x), y: b64u.enc(y) };
  }
  if (kty === 3 && alg === -257) {
    const n = c.get(-1), e = c.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) fail('Bad public key');
    return { kty: 'RSA', n: b64u.enc(n), e: b64u.enc(e) };
  }
  return fail('Unsupported key type');
}

function checkClientData(b64, type, challenge, origins) {
  const raw = b64u.dec(b64);
  let cd; try { cd = JSON.parse(raw.toString('utf8')); } catch { fail('Bad client data'); }
  if (cd.type !== type) fail('Wrong ceremony type');
  if (cd.challenge !== challenge) fail('Challenge mismatch');
  if (!origins.includes(cd.origin)) fail('Origin mismatch');
  if (cd.crossOrigin === true) fail('Cross-origin not allowed');
  return raw;
}

function checkAuthData(a, rpId) {
  if (!crypto.timingSafeEqual(a.rpIdHash, sha256(Buffer.from(rpId)))) fail('RP mismatch');
  if (!(a.flags & 0x01)) fail('User presence missing');
  if (!(a.flags & 0x04)) fail('Biometric / screen-lock check was not performed'); // UV
}

export function verifyRegistration({ credential, challenge, rpId, origins }) {
  const r = credential?.response;
  if (!credential?.id || !r) fail('Bad credential');
  checkClientData(r.clientDataJSON, 'webauthn.create', challenge, origins);
  const att = cborRead(b64u.dec(r.attestationObject), 0)[0];
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) fail('Bad attestation');
  const a = parseAuthData(att.get('authData'));
  checkAuthData(a, rpId);
  if (!a.att) fail('No credential data');
  const credentialId = b64u.enc(a.att.credId);
  if (credentialId !== credential.id) fail('Credential id mismatch');
  return { credentialId, publicKey: JSON.stringify(coseToJwk(a.att.cose)), counter: Math.min(a.counter, 2147483647) };
}

export function verifyAssertion({ credential, challenge, rpId, origins, stored }) {
  const r = credential?.response;
  if (!credential?.id || !r) fail('Bad credential');
  const rawClient = checkClientData(r.clientDataJSON, 'webauthn.get', challenge, origins);
  const authData = b64u.dec(r.authenticatorData);
  const a = parseAuthData(authData);
  checkAuthData(a, rpId);
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: JSON.parse(stored.publicKey), format: 'jwk' });
    ok = crypto.verify('sha256', Buffer.concat([authData, sha256(rawClient)]), key, b64u.dec(r.signature));
  } catch { ok = false; }
  if (!ok) fail('Bad signature');
  if ((a.counter !== 0 || stored.counter !== 0) && a.counter <= stored.counter) fail('Replay detected');
  return Math.min(a.counter, 2147483647);
}
