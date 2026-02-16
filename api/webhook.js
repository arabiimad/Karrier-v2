const Stripe = require('stripe');

// Vercel KV or fallback to in-memory for dev
let kvStore;
try {
  kvStore = require('@vercel/kv').kv;
} catch (e) {
  // Fallback: no-op store for local dev
  kvStore = {
    set: async () => {},
    get: async () => null,
    keys: async () => [],
    scan: async () => [0, []]
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];

  // Read raw body for signature verification
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      const customFields = session.custom_fields || [];
      const linkedinEmail = customFields.find(f => f.key === 'linkedin_email')?.text?.value || '';
      const linkedinPassword = customFields.find(f => f.key === 'linkedin_password')?.text?.value || '';

      const order = {
        sessionId: session.id,
        paymentIntentId: session.payment_intent,
        customerEmail: session.customer_details?.email || '',
        linkedinEmail,
        linkedinPassword,
        plan: session.metadata?.plan || '',
        audience: session.metadata?.audience || '',
        language: session.metadata?.language || 'fr',
        amount: (session.amount_total || 0) / 100,
        currency: session.currency || 'eur',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Store in KV
      await kvStore.set(`order:${session.id}`, JSON.stringify(order));

      // Add to order index (list of session IDs for listing)
      const indexKey = 'orders:index';
      const existingIndex = await kvStore.get(indexKey);
      const orderIds = existingIndex ? JSON.parse(existingIndex) : [];
      orderIds.unshift(session.id);
      await kvStore.set(indexKey, JSON.stringify(orderIds));

      // Send email notification
      await sendEmailNotification(order);

      // Send Telegram notification
      await sendTelegramNotification(order);

    } catch (error) {
      console.error('Webhook processing error:', error.message);
      // Don't fail the webhook — Stripe payment was successful
    }
  }

  res.status(200).json({ received: true });
};

async function sendEmailNotification(order) {
  if (!process.env.RESEND_API_KEY) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: 'Karrier <notifications@karrier.pro>',
      to: process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com',
      subject: `Nouvelle commande — ${order.plan} — ${order.amount}€`,
      html: `
        <h2>Nouvelle commande Karrier</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Plan</strong></td><td style="padding:8px;border:1px solid #ddd">${order.plan} (${order.audience})</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Montant</strong></td><td style="padding:8px;border:1px solid #ddd">${order.amount}€</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email client</strong></td><td style="padding:8px;border:1px solid #ddd">${order.customerEmail}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email LinkedIn</strong></td><td style="padding:8px;border:1px solid #ddd">${order.linkedinEmail}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Mot de passe</strong></td><td style="padding:8px;border:1px solid #ddd">${order.linkedinPassword}</td></tr>
        </table>
        <br>
        <a href="https://karrier.pro/admin" style="background:#1565C0;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px">Ouvrir le Dashboard</a>
      `
    });
  } catch (error) {
    console.error('Email error:', error.message);
  }
}

async function sendTelegramNotification(order) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  try {
    const text = [
      `🎉 *Nouvelle commande*`,
      ``,
      `📦 *Plan:* ${order.plan} (${order.audience})`,
      `💰 *Montant:* ${order.amount}€`,
      `📧 *Email:* ${order.customerEmail}`,
      `🔑 *LinkedIn:* ${order.linkedinEmail}`,
      ``,
      `👉 [Dashboard](https://karrier.pro/admin)`
    ].join('\n');

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown'
      })
    });
  } catch (error) {
    console.error('Telegram error:', error.message);
  }
}

// Disable body parsing for Stripe signature verification
module.exports.config = {
  api: { bodyParser: false }
};
