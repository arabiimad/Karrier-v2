// Referral page sign-in: a 6-digit code sent by email, then a short session token.
// Tokens use a key derived from JWT_SECRET, so they can never pass as admin tokens.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SCOPE = 'referral';
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 3; // per email within CODE_TTL_MS

function sessionSecret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('kareer-referral-session').digest('hex');
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(email, code) {
  return crypto.createHmac('sha256', sessionSecret()).update(`${email}:${code}`).digest('hex');
}

function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function signSession(email) {
  return jwt.sign({ scope: SCOPE, email }, sessionSecret(), { expiresIn: '2h' });
}

// Returns the verified email, or null.
function readSession(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(header.slice(7), sessionSecret());
    return decoded.scope === SCOPE && decoded.email ? decoded.email : null;
  } catch (e) {
    return null;
  }
}

module.exports = { CODE_TTL_MS, MAX_ATTEMPTS, MAX_SENDS, hashCode, newCode, normalizeEmail, readSession, sameHash, signSession };
