// Referral accounts: one code per person, a balance in euros, and the people they referred.
// A referral earns REWARD euros once the referred order is paid; a refund takes it back.

const crypto = require('crypto');
const kvStore = require('./_kv');
const { sendEmail } = require('./_email');
const customerEmails = require('./_customer-emails');

const REWARD = 10;

function parseValue(data) {
  if (!data) return null;
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch (e) { return data; }
}

// Accounts created before statuses existed are active.
function isActive(referral) {
  return !!referral && (!referral.status || referral.status === 'active');
}

async function getReferral(code) {
  if (!code) return null;
  return parseValue(await kvStore.get(`referral:${String(code).toUpperCase()}`));
}

async function saveReferral(code, referral) {
  await kvStore.set(`referral:${String(code).toUpperCase()}`, JSON.stringify(referral));
}

// referral:email:<email> should hold a code. An old bug stored the whole referral there;
// find the real code again and repair the mapping.
async function codeForEmail(email) {
  const key = `referral:email:${String(email || '').toLowerCase()}`;
  const value = parseValue(await kvStore.get(key));
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.code) return value.code;
  const keys = await kvStore.keys('referral:REF*');
  for (const refKey of keys) {
    const referral = parseValue(await kvStore.get(refKey));
    if (referral && String(referral.referrerEmail || '').toLowerCase() === String(email).toLowerCase()) {
      const code = refKey.replace('referral:', '');
      await kvStore.set(key, code);
      return code;
    }
  }
  return null;
}

async function newReferralCode() {
  let code;
  do {
    code = 'REF' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  } while (await kvStore.get(`referral:${code}`));
  return code;
}

// Creates the account (status and fields given by the caller) and its email mapping.
async function createReferral(email, fields) {
  const normalized = String(email || '').trim().toLowerCase();
  const code = await newReferralCode();
  const referral = {
    referrerEmail: normalized,
    referrerName: normalized.split('@')[0],
    status: 'active',
    referralCount: 0,
    referrals: [],
    pendingBalance: 0,
    transferRequests: [],
    balanceCodes: [],
    createdAt: new Date().toISOString(),
    ...fields
  };
  await saveReferral(code, referral);
  await kvStore.set(`referral:email:${normalized}`, code);
  const index = parseValue(await kvStore.get('referrals:index')) || [];
  if (!index.includes(code)) index.push(code);
  await kvStore.set('referrals:index', JSON.stringify(index));
  return { code, referral };
}

// Every activated customer gets a code, reusing the one they may already have.
async function ensureReferralCode(order) {
  const email = String(order.customerEmail || '').trim().toLowerCase();
  if (!email) return;
  const existing = await codeForEmail(email);
  if (existing && await getReferral(existing)) {
    order.referralCode = existing;
    order.customerReferralCode = existing;
    return;
  }
  const { code } = await createReferral(email, {
    source: 'customer',
    language: order.language || 'fr',
    sessionId: order.sessionId,
    plan: order.plan
  });
  order.referralCode = code;
  order.customerReferralCode = code;
}

// Called when an order becomes paid. Free orders earn nothing. Never throws.
async function creditReferrer(order) {
  if (!order.usedReferralCode || order.referrerRewardedAt || !(Number(order.amount) > 0)) return false;
  try {
    const code = String(order.usedReferralCode).toUpperCase();
    const referral = await getReferral(code);
    if (!isActive(referral)) return false;

    const customerEmail = String(order.customerEmail || '').toLowerCase();
    if (referral.referrerEmail && referral.referrerEmail.toLowerCase() === customerEmail) return false;
    referral.referrals = referral.referrals || [];
    if (referral.referrals.some(r => r.orderId === order.sessionId)) return false;

    const now = new Date().toISOString();
    referral.pendingBalance = Number(referral.pendingBalance || 0) + REWARD;
    referral.referrals.push({ email: customerEmail, usedAt: order.createdAt || now, paidAt: now, orderId: order.sessionId, reward: REWARD });
    referral.referralCount = (referral.referralCount || 0) + 1;
    referral.lastReferralAt = now;
    await saveReferral(code, referral);
    order.referrerRewardedAt = now;

    if (referral.referrerEmail) {
      await sendEmail({
        to: referral.referrerEmail,
        ...customerEmails.programReward({ program: 'referral', language: referral.language, code, amount: REWARD, balance: referral.pendingBalance })
      });
    }
    return true;
  } catch (err) {
    console.error('[Referral] Credit failed:', err.message);
    return false;
  }
}

// Called when a paid order is refunded: the 10 € leave the balance (never below zero).
async function reverseReferrerCredit(order) {
  if (!order.referrerRewardedAt || order.referrerRewardReversedAt || !order.usedReferralCode) return false;
  try {
    const code = String(order.usedReferralCode).toUpperCase();
    const referral = await getReferral(code);
    if (!referral) return false;
    const now = new Date().toISOString();
    const entry = (referral.referrals || []).find(r => r.orderId === order.sessionId && !r.reversedAt);
    if (entry) entry.reversedAt = now;
    referral.pendingBalance = Math.max(0, Number(referral.pendingBalance || 0) - REWARD);
    referral.referralCount = Math.max(0, (referral.referralCount || 0) - 1);
    await saveReferral(code, referral);
    order.referrerRewardReversedAt = now;
    return true;
  } catch (err) {
    console.error('[Referral] Reversal failed:', err.message);
    return false;
  }
}

module.exports = {
  REWARD,
  codeForEmail,
  createReferral,
  creditReferrer,
  ensureReferralCode,
  getReferral,
  isActive,
  parseValue,
  reverseReferrerCredit,
  saveReferral
};
