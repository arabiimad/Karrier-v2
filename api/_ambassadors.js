// Ambassador accounts: students, content creators, people sharing with colleagues.
// They do not need to be customers. Each account is stored by email, has its own
// custom code, and amounts set by the team (discount for buyers, reward per paid order).

const kvStore = require('./_kv');
const { sendEmail } = require('./_email');
const customerEmails = require('./_customer-emails');

const DEFAULT_DISCOUNT = 10;
const DEFAULT_REWARD = 10;
// Prefixes used by other codes (referral, balance codes, promo codes, order numbers).
const RESERVED_PREFIX = /^(REF|SOLDE|PARRAIN|KAREER|KR)/;

function parse(data) {
  if (!data) return null;
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch (e) { return null; }
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function getAmbassador(email) {
  if (!email) return null;
  return parse(await kvStore.get(`ambassador:${String(email).toLowerCase()}`));
}

async function saveAmbassador(account) {
  await kvStore.set(`ambassador:${account.email}`, JSON.stringify(account));
}

async function getAmbassadorByCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const email = await kvStore.get(`ambassador-code:${normalized}`);
  return email ? getAmbassador(typeof email === 'string' ? email : String(email)) : null;
}

function isActive(account) {
  return !!account && account.status === 'active';
}

// A custom code must be 4 to 20 letters or digits, and free across every kind of code.
async function checkCode(code, email) {
  const normalized = normalizeCode(code);
  if (normalized.length < 4 || normalized.length > 20) return { ok: false, error: 'code_format' };
  if (RESERVED_PREFIX.test(normalized)) return { ok: false, error: 'code_reserved' };
  const owner = await kvStore.get(`ambassador-code:${normalized}`);
  if (owner && String(owner) !== String(email)) return { ok: false, error: 'code_taken' };
  if (await kvStore.get(`promo:${normalized}`) || await kvStore.get(`referral:${normalized}`)) return { ok: false, error: 'code_taken' };
  return { ok: true, code: normalized };
}

// Points the account to a new code and frees the old one.
async function setCode(account, code) {
  if (account.code && account.code !== code) await kvStore.del(`ambassador-code:${account.code}`);
  account.code = code;
  await kvStore.set(`ambassador-code:${code}`, account.email);
}

async function listAmbassadors() {
  const keys = await kvStore.keys('ambassador:*');
  const accounts = [];
  for (const key of keys) {
    if (!key.startsWith('ambassador:')) continue;
    const account = parse(await kvStore.get(key));
    if (account && account.email) accounts.push(account);
  }
  return accounts;
}

// Called when an order becomes paid. Free orders earn nothing. Never throws.
async function creditAmbassador(order) {
  if (!order.usedAmbassadorCode || order.ambassadorRewardedAt || !(Number(order.amount) > 0)) return false;
  try {
    // The order was placed while the code was active: a later pause does not cancel the reward.
    const account = await getAmbassador(order.ambassadorEmail);
    if (!account || !['active', 'paused'].includes(account.status)) return false;
    account.referrals = account.referrals || [];
    if (account.referrals.some(r => r.orderId === order.sessionId)) return false;

    const reward = Number(order.ambassadorReward != null ? order.ambassadorReward : account.reward || DEFAULT_REWARD);
    const now = new Date().toISOString();
    account.pendingBalance = Math.round((Number(account.pendingBalance || 0) + reward) * 100) / 100;
    account.referrals.push({ email: String(order.customerEmail || '').toLowerCase(), usedAt: order.createdAt || now, paidAt: now, orderId: order.sessionId, reward });
    account.referralCount = (account.referralCount || 0) + 1;
    await saveAmbassador(account);
    order.ambassadorRewardedAt = now;

    await sendEmail({
      to: account.email,
      ...customerEmails.programReward({ program: 'ambassador', language: account.language, code: account.code, amount: reward, balance: account.pendingBalance })
    });
    return true;
  } catch (err) {
    console.error('[Ambassador] Credit failed:', err.message);
    return false;
  }
}

// Called when a paid order is refunded: the reward leaves the balance (never below zero).
async function reverseAmbassadorCredit(order) {
  if (!order.ambassadorRewardedAt || order.ambassadorRewardReversedAt) return false;
  try {
    const account = await getAmbassador(order.ambassadorEmail);
    if (!account) return false;
    const now = new Date().toISOString();
    const entry = (account.referrals || []).find(r => r.orderId === order.sessionId && !r.reversedAt);
    const reward = entry ? Number(entry.reward || 0) : Number(order.ambassadorReward || 0);
    if (entry) entry.reversedAt = now;
    account.pendingBalance = Math.max(0, Math.round((Number(account.pendingBalance || 0) - reward) * 100) / 100);
    account.referralCount = Math.max(0, (account.referralCount || 0) - 1);
    await saveAmbassador(account);
    order.ambassadorRewardReversedAt = now;
    return true;
  } catch (err) {
    console.error('[Ambassador] Reversal failed:', err.message);
    return false;
  }
}

module.exports = {
  DEFAULT_DISCOUNT,
  DEFAULT_REWARD,
  checkCode,
  creditAmbassador,
  getAmbassador,
  getAmbassadorByCode,
  isActive,
  listAmbassadors,
  normalizeCode,
  reverseAmbassadorCredit,
  saveAmbassador,
  setCode
};
