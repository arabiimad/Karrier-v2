require('./_env');
const Stripe = require('stripe');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
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

    res.status(200).json({ 
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
    res.status(500).json({ error: error.message || 'Failed to process refund' });
  }
};

async function sendRefundEmail(order) {
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const lang = order.language || 'fr';
    const subject = lang === 'fr' ? 'Remboursement effectué - Karrier' : 'Refund Processed - Karrier';
    const title = lang === 'fr' ? 'Votre remboursement a été effectué' : 'Your refund has been processed';
    const message = lang === 'fr' 
      ? `Votre commande pour ${order.plan} (${order.audience}) a été remboursée. Le montant de ${order.amount}€ sera crédité sur votre compte dans 5-10 jours ouvrés.`
      : `Your order for ${order.plan} (${order.audience}) has been refunded. The amount of ${order.amount}€ will be credited to your account within 5-10 business days.`;

    await resend.emails.send({
      from: 'Karrier <notifications@karrier.pro>',
      to: order.customerEmail,
      subject,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <img src="https://karrier.pro/karrier-logo.png" alt="Karrier" style="width:60px;margin-bottom:20px">
          <h2>${title}</h2>
          <p>${message}</p>
          <p><strong>${lang === 'fr' ? 'Montant remboursé' : 'Refunded amount'}:</strong> ${order.amount}€</p>
          <p>${lang === 'fr' ? 'Si vous avez des questions, n\'hésitez pas à nous contacter.' : 'If you have any questions, please contact us.'}</p>
        </div>
      `
    });
  } catch (error) {
    console.error('Refund email error:', error.message);
  }
}
