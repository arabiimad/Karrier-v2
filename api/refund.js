require('./_env');
const Stripe = require('stripe');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const { isPaid } = require('./_payment');
const rateLimit = require('./_rate-limit');
const { sendEmail } = require('./_email');
const customerEmails = require('./_customer-emails');
const { ensureReference } = require('./_orders');
const { reverseReferrerCredit } = require('./_referrals');
const { reverseAmbassadorCredit } = require('./_ambassadors');
const checkRate = rateLimit({ windowMs: 60000, max: 10 });

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rate = checkRate(req);
  if (!rate.allowed) {
    return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter: rate.retryAfter });
  }

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { session_id, reason } = req.body;

    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    const data = await kvStore.get(`order:${session_id}`);
    if (!data) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = typeof data === 'string' ? JSON.parse(data) : data;

    if (order.status === 'refunded') {
      return res.status(400).json({ error: 'Order already refunded' });
    }

    // WhatsApp orders are paid outside the site, so the money goes back the same way.
    // Here we only record the refund and tell the customer.
    if (!order.paymentIntentId) {
      if (!isPaid(order)) {
        return res.status(400).json({ error: 'Order is not paid' });
      }
      await ensureReference(order);
      order.status = 'refunded';
      order.refundMethod = 'manual';
      order.refundReason = reason || 'requested_by_customer';
      order.refundedAt = new Date().toISOString();
      order.updatedAt = order.refundedAt;
      await reverseReferrerCredit(order);
      await reverseAmbassadorCredit(order);
      await kvStore.set(`order:${session_id}`, JSON.stringify(order));
      const mail = await sendRefundEmail(order);
      return res.status(200).json({
        success: true,
        emailSent: mail.sent,
        refund: { id: 'manual', amount: order.amount, status: 'recorded', manual: true },
        order
      });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const refund = await stripe.refunds.create({
      payment_intent: order.paymentIntentId,
      reason: reason || 'requested_by_customer',
      metadata: {
        session_id,
        admin_refund: 'true'
      }
    });

    order.status = 'refunded';
    order.refundId = refund.id;
    order.refundedAt = new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    await reverseReferrerCredit(order);
    await reverseAmbassadorCredit(order);

    await kvStore.set(`order:${session_id}`, JSON.stringify(order));

    await sendRefundEmail(order);

    return res.status(200).json({
      success: true,
      refund: {
        id: refund.id,
        amount: refund.amount / 100,
        status: refund.status
      },
      order
    });
  } catch (error) {
    console.error('Refund error:', error.message);
    return res.status(500).json({ error: error.message || 'Failed to process refund' });
  }
};

function sendRefundEmail(order) {
  return sendEmail({ to: order.customerEmail, ...customerEmails.refunded(order) });
}
