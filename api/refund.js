require('./_env');
const Stripe = require('stripe');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const {
  buildEmailHtml,
  detailTable,
  emailButton,
  escapeHtml,
  formatCurrency,
  formatPlan,
  getSiteUrl
} = require('./_email');
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

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

    if (!order.paymentIntentId) {
      return res.status(400).json({ error: 'No payment intent found' });
    }

    if (order.status === 'refunded') {
      return res.status(400).json({ error: 'Order already refunded' });
    }

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

    await kvStore.set(`order:${session_id}`, JSON.stringify(order));

    if (process.env.RESEND_API_KEY && order.customerEmail) {
      await sendRefundEmail(order);
    }

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

async function sendRefundEmail(order) {
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const lang = order.language || 'fr';
    const siteUrl = getSiteUrl();
    const t = lang === 'fr' ? {
      subject: 'Remboursement effectué — Kareer',
      title: 'Remboursement effectué',
      message: 'Votre commande a été remboursée. Le montant sera crédité sur votre compte dans un délai habituel de 5 à 10 jours ouvrés.',
      amount: 'Montant remboursé',
      order: 'Commande',
      contact: 'Nous contacter'
    } : {
      subject: 'Refund processed — Kareer',
      title: 'Refund processed',
      message: 'Your order has been refunded. The amount will be credited to your account within the usual 5 to 10 business days.',
      amount: 'Refunded amount',
      order: 'Order',
      contact: 'Contact us'
    };

    const content = `
      <p style="margin:0 0 18px;color:#1f2937;font-size:16px;line-height:1.6">${escapeHtml(t.message)}</p>
      ${detailTable([
        { label: 'Plan', value: formatPlan(order.plan, order.audience, lang) },
        { label: t.amount, value: formatCurrency(order.amount, order.currency || 'EUR', lang) },
        { label: t.order, value: order.sessionId }
      ])}
      ${emailButton(t.contact, 'mailto:contact@kareer.pro')}
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject: t.subject,
      html: buildEmailHtml({
        siteUrl,
        headerColor: '#0f766e',
        title: t.title,
        preheader: t.message,
        content,
        lang
      }),
      text: `${t.title}\n\n${t.message}\n\nPlan: ${formatPlan(order.plan, order.audience, lang)}\n${t.amount}: ${formatCurrency(order.amount, order.currency || 'EUR', lang)}\n${t.order}: ${order.sessionId}`
    });
  } catch (error) {
    console.error('Refund email error:', error.message);
  }
}
