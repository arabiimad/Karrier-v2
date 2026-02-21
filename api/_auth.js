// Shared authentication module — used by all admin API endpoints
require('./_env');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;

if (!SECRET || SECRET.length < 32) {
  console.error('[AUTH] JWT_SECRET is missing or too short (min 32 chars)');
}

/**
 * Verify admin JWT token from Authorization header.
 * Throws if invalid or missing.
 */
function verifyAuth(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  if (!SECRET || SECRET.length < 32) {
    throw new Error('Server misconfigured');
  }
  return jwt.verify(auth.substring(7), SECRET);
}

module.exports = { verifyAuth };
