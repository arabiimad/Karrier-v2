require('./_env');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const { getPlan } = require('./_plans');
const crypto = require('crypto');
const { sendEmail } = require('./_email');
const customerEmails = require('./_customer-emails');
const { alertTeam, newReference } = require('./_orders');
const { getReferral, isActive } = require('./_referrals');
const checkRate = rateLimit({ windowMs: 60000, max: 15 });

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rate = checkRate(req);
  if (!rate.allowed) {
    return res.status(429).json({ error: 'Too many requests', retryAfter: rate.retryAfter });
  }

  try {
    const {
      planId,
      linkedinEmail,
      customerEmail,
      language = 'fr',
      referralCode,
      promoCode,
    } = req.body;

    if (!planId || !linkedinEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(String(linkedinEmail).trim()) || (customerEmail && !emailPattern.test(String(customerEmail).trim()))) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const planInfo = getPlan(planId);
    if (!planInfo) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    // Ids are made here, never taken from the browser, so an order cannot be overwritten.
    const sessionId = `kareer_${planId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const reference = await newReference();
    let amount = planInfo.amount;
    const discounts = [];
    let normalizedPromoCode = null;
    let normalizedReferralCode = null;

    if (referralCode) {
      const referralResult = await validateReferralCode(referralCode, customerEmail || linkedinEmail);
      amount = Math.max(0, amount - 10);
      normalizedReferralCode = referralResult.code;
      discounts.push({ type: 'referral', code: referralResult.code, amount: 10 });
    }

    if (promoCode) {
      const promoResult = await applyPromoCode({
        code: promoCode,
        plan: planInfo,
        orderId: sessionId,
        amount
      });
      amount -= promoResult.discount;
      normalizedPromoCode = promoResult.code;
      discounts.push({ type: 'promo', code: promoResult.code, amount: promoResult.discount });
    }

    const order = {
      sessionId,
      reference,
      plan: planId,
      planLabel: planInfo.planLabel,
      audience: planInfo.audience,
      originalAmount: planInfo.amount,
      amount: Math.max(0, amount),
      currency: planInfo.currency,
      discounts,
      promoCode: normalizedPromoCode,
      usedReferralCode: normalizedReferralCode,
      linkedinEmail: String(linkedinEmail).trim(),
      customerEmail: String(customerEmail || linkedinEmail).trim(),
      language: ['fr', 'en', 'es', 'de'].includes(language) ? language : 'fr',
      status: 'pending_payment',
      source: 'checkout-whatsapp',
      paymentFlow: 'after_activation',
      hasCredentials: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Fully covered by a code (for example a referral balance): nothing will be due.
    if (order.amount === 0) {
      order.paid = true;
      order.paidAt = order.createdAt;
      order.paymentMethod = 'Code de réduction';
    }

    await kvStore.set(`order:${sessionId}`, JSON.stringify(order));
    await kvStore.set(`order-ref:${reference}`, sessionId);

    // Update index
    const indexData = await kvStore.get('orders:index');
    const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
    if (!allIds.includes(sessionId)) {
      allIds.unshift(sessionId);
      await kvStore.set('orders:index', JSON.stringify(allIds));
    }

    console.log(`[Order] Created: ${reference} ${sessionId} - ${planId} ${order.amount}${order.currency}`);

    // Wait for the emails: a serverless function can be frozen as soon as it answers.
    const confirmation = customerEmails.orderReceived(order);
    const [customerMail] = await Promise.allSettled([
      sendEmail({ to: order.customerEmail, ...confirmation }),
      alertTeam('new_order', order)
    ]);

    res.status(200).json({
      success: true,
      orderId: sessionId,
      reference,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      emailSent: customerMail.status === 'fulfilled' && customerMail.value.sent
    });

  } catch (error) {
    console.error('Create order error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to create order' });
  }
};

async function applyPromoCode({ code, plan, orderId, amount }) {
  const promoCode = String(code || '').toUpperCase().trim();
  if (!promoCode) {
    const error = new Error('Invalid promo code');
    error.statusCode = 400;
    throw error;
  }

  const promoData = await kvStore.get(`promo:${promoCode}`);
  if (!promoData) {
    const error = new Error('Invalid promo code');
    error.statusCode = 400;
    throw error;
  }

  const promo = typeof promoData === 'string' ? JSON.parse(promoData) : promoData;
  if (!promo.active) {
    const error = new Error('Promo code disabled');
    error.statusCode = 400;
    throw error;
  }
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
    const error = new Error('Promo code expired');
    error.statusCode = 400;
    throw error;
  }
  if (promo.maxUses && promo.usedCount >= promo.maxUses) {
    const error = new Error('Promo code exhausted');
    error.statusCode = 400;
    throw error;
  }
  if (promo.minAmount && amount < promo.minAmount) {
    const error = new Error(`Minimum amount required: ${promo.minAmount}`);
    error.statusCode = 400;
    throw error;
  }

  const applicablePlans = promo.applicablePlans || 'all';
  if (applicablePlans !== 'all') {
    const allowedPlans = String(applicablePlans).split(',').map(p => p.trim());
    if (!allowedPlans.includes(plan.plan)) {
      const error = new Error('Promo code not applicable to this plan');
      error.statusCode = 400;
      throw error;
    }
  }

  let discount = 0;
  if (promo.type === 'percentage') {
    discount = Math.round((amount * Number(promo.value || promo.discount || 0)) / 100);
  } else if (promo.type === 'fixed') {
    discount = Number(promo.value || promo.discount || 0);
  } else {
    discount = Number(promo.discount || 0);
  }
  discount = Math.max(0, Math.min(discount, amount));

  promo.usedCount = (promo.usedCount || 0) + 1;
  promo.lastUsedAt = new Date().toISOString();
  promo.usageHistory = promo.usageHistory || [];
  promo.usageHistory.push({ orderId, amount, discount, usedAt: new Date().toISOString() });
  await kvStore.set(`promo:${promoCode}`, JSON.stringify(promo));

  return { code: promoCode, discount };
}

async function validateReferralCode(code, customerEmail) {
  const referralCode = String(code || '').toUpperCase().trim();
  const referral = await getReferral(referralCode);
  // Codes waiting for the team's approval (or refused) do not give the discount.
  if (!referral || !isActive(referral)) {
    const error = new Error('Invalid referral code');
    error.statusCode = 400;
    throw error;
  }

  const email = String(customerEmail || '').toLowerCase();
  if (referral.referrerEmail && referral.referrerEmail.toLowerCase() === email) {
    const error = new Error('Self-referral is not allowed');
    error.statusCode = 400;
    throw error;
  }
  const alreadyUsed = (referral.referrals || []).some(r => String(r.email || '').toLowerCase() === email);
  if (alreadyUsed) {
    const error = new Error('Referral code already used by this email');
    error.statusCode = 400;
    throw error;
  }

  return { code: referralCode };
}
