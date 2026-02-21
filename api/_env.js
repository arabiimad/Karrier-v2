// Load .env.local for local development
try {
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env.local') });
} catch (e) {
  // dotenv not available in production (Vercel handles env vars)
}

// Validate critical environment variables at startup
const REQUIRED = ['JWT_SECRET', 'ADMIN_PASSWORD_HASH'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[ENV] Missing critical env vars: ${missing.join(', ')}`);
}
const OPTIONAL = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY'];
const missingOpt = OPTIONAL.filter(k => !process.env[k]);
if (missingOpt.length > 0) {
  console.warn(`[ENV] Optional env vars not set: ${missingOpt.join(', ')}`);
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.error('[ENV] JWT_SECRET should be at least 32 characters');
}
