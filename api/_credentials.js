const crypto = require('crypto');

const TOKEN_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const encoded = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is not configured');
  }

  let key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    key = Buffer.from(encoded, 'hex');
  }
  if (key.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be a 32-byte base64 or hex value');
  }
  return key;
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function encryptSecret(value) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptSecret(payload) {
  if (!payload || !payload.iv || !payload.tag || !payload.ciphertext) {
    throw new Error('Encrypted credential payload is invalid');
  }
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

function isExpired(isoDate) {
  return !!isoDate && new Date(isoDate).getTime() <= Date.now();
}

module.exports = {
  generateToken,
  hashToken,
  encryptSecret,
  decryptSecret,
  isExpired
};
