require('./_env');
const Stripe = require('stripe');
const kvStore = require('./_kv');

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

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object);
        break;

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;

      default:
        console.log('Unhandled event type:', event.type);
    }
  } catch (error) {
    console.error('Webhook processing error:', error.message);
  }

  res.status(200).json({ received: true });
};

async function handleCheckoutCompleted(session) {
  // A4: Idempotency — skip if order already exists
  const existing = await kvStore.get(`order:${session.id}`);
  if (existing) {
    console.log(`[Webhook] Order ${session.id} already exists, skipping`);
    return;
  }

  const customFields = session.custom_fields || [];
  const linkedinEmail = customFields.find(f => f.key === 'linkedin_email')?.text?.value || '';
  const linkedinPassword = customFields.find(f => f.key === 'linkedin_password')?.text?.value || '';

  const order = {
    sessionId: session.id,
    paymentIntentId: session.payment_intent,
    subscriptionId: session.subscription || null,
    customerId: session.customer || null,
    customerEmail: session.customer_details?.email || '',
    linkedinEmail,
    linkedinPassword,
    plan: session.metadata?.plan || '',
    audience: session.metadata?.audience || '',
    language: session.metadata?.language || 'fr',
    mode: session.mode || 'payment',
    amount: (session.amount_total || 0) / 100,
    currency: session.currency || 'eur',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Store order first (acts as idempotency lock)
  await kvStore.set(`order:${session.id}`, JSON.stringify(order));

  // A5: Fix race condition — check for duplicates before adding to index
  const indexKey = 'orders:index';
  const existingIndex = await kvStore.get(indexKey);
  const orderIds = existingIndex ? (typeof existingIndex === 'string' ? JSON.parse(existingIndex) : existingIndex) : [];
  if (!orderIds.includes(session.id)) {
    orderIds.unshift(session.id);
    await kvStore.set(indexKey, JSON.stringify(orderIds));
  }

  if (session.subscription) {
    await kvStore.set(`sub:${session.subscription}`, JSON.stringify({
      sessionId: session.id,
      customerId: session.customer,
      status: 'active',
      createdAt: new Date().toISOString()
    }));
  }

  await sendEmailNotification(order);
  await sendTelegramNotification(order);
  await sendWelcomeEmail(order);
}

async function handlePaymentFailed(paymentIntent) {
  const email = paymentIntent.last_payment_error?.payment_method?.billing_details?.email
    || paymentIntent.receipt_email || '';

  if (!email || !process.env.RESEND_API_KEY) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: email,
      subject: 'Problème avec votre paiement — Karrier',
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
          <div style="background:#EF4444;padding:32px;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:22px">Paiement échoué</h1>
          </div>
          <div style="padding:32px">
            <p style="color:#333;font-size:16px;line-height:1.6">Votre paiement n'a pas pu être traité. Cela peut être dû à un solde insuffisant ou une carte expirée.</p>
            <p style="color:#333;font-size:16px;line-height:1.6">Vous pouvez réessayer en cliquant ci-dessous :</p>
            <div style="text-align:center;margin-top:24px">
              <a href="${siteUrl}/#pricing" style="background:#1565C0;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">Réessayer le paiement</a>
            </div>
          </div>
          <div style="background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#999">
            Si le problème persiste, contactez-nous à <a href="mailto:contact@kareer.pro" style="color:#1565C0">contact@kareer.pro</a>
          </div>
        </div>
      `
    });

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `❌ *Paiement échoué*\n📧 ${email}\n💰 ${(paymentIntent.amount || 0) / 100}€\n❗ ${paymentIntent.last_payment_error?.message || 'Erreur inconnue'}`,
          parse_mode: 'Markdown'
        })
      });
    }
  } catch (error) {
    console.error('Payment failed notification error:', error.message);
  }
}

async function sendWelcomeEmail(order) {
  if (!process.env.RESEND_API_KEY || !order.customerEmail) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const lang = order.language || 'fr';
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';

    const t = lang === 'fr' ? {
      subject: 'Bienvenue chez Karrier ! Votre commande est confirmée',
      title: 'Merci pour votre commande !',
      body: 'Nous avons bien reçu votre paiement. Notre équipe va procéder à l\'activation de votre compte LinkedIn Premium dans les prochaines heures.',
      steps_title: 'Prochaines étapes',
      step1: 'Nous vérifions vos informations LinkedIn',
      step2: 'Activation de votre compte Premium (24-48h)',
      step3: 'Vous recevrez un email de confirmation',
      track: 'Suivre ma commande',
      delay: 'Délai estimé : 24 à 48 heures'
    } : {
      subject: 'Welcome to Karrier! Your order is confirmed',
      title: 'Thank you for your order!',
      body: 'We have received your payment. Our team will activate your LinkedIn Premium account within the next few hours.',
      steps_title: 'Next steps',
      step1: 'We verify your LinkedIn information',
      step2: 'Premium account activation (24-48h)',
      step3: 'You will receive a confirmation email',
      track: 'Track my order',
      delay: 'Estimated time: 24 to 48 hours'
    };

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject: t.subject,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#1565C0,#42A5F5);padding:40px 32px;text-align:center">
            <img src="${siteUrl}/kareer-logo.png" alt="Karrier" style="width:48px;height:48px;margin-bottom:16px">
            <h1 style="color:#fff;margin:0;font-size:24px">${t.title}</h1>
          </div>
          <div style="padding:32px">
            <p style="color:#333;font-size:16px;line-height:1.6">${t.body}</p>
            <table style="width:100%;border-collapse:collapse;margin:24px 0">
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Plan</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.plan} (${order.audience})</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">${lang === 'fr' ? 'Montant' : 'Amount'}</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.amount}€</td></tr>
            </table>
            <div style="background:#f0f7ff;border-radius:10px;padding:20px;margin:24px 0">
              <h3 style="color:#1565C0;margin:0 0 12px;font-size:15px">${t.steps_title}</h3>
              <p style="margin:6px 0;color:#333;font-size:14px">1️⃣ ${t.step1}</p>
              <p style="margin:6px 0;color:#333;font-size:14px">2️⃣ ${t.step2}</p>
              <p style="margin:6px 0;color:#333;font-size:14px">3️⃣ ${t.step3}</p>
              <p style="margin:12px 0 0;color:#666;font-size:13px;font-style:italic">⏱️ ${t.delay}</p>
            </div>
            <div style="text-align:center;margin-top:24px">
              <a href="${siteUrl}/suivi?id=${order.sessionId}" style="background:#1565C0;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">${t.track}</a>
            </div>
          </div>
          <div style="background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#999">
            Karrier — LinkedIn Premium ${lang === 'fr' ? 'à prix réduit' : 'at reduced price'}
          </div>
        </div>
      `
    });
  } catch (error) {
    console.error('Welcome email error:', error.message);
  }
}

async function handleInvoicePaid(invoice) {
  if (!invoice.subscription) return;

  const subData = await kvStore.get(`sub:${invoice.subscription}`);
  if (!subData) return;

  const sub = typeof subData === 'string' ? JSON.parse(subData) : subData;
  const orderData = await kvStore.get(`order:${sub.sessionId}`);
  if (!orderData) return;

  const order = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;

  order.lastPaymentAt = new Date().toISOString();
  order.updatedAt = new Date().toISOString();
  await kvStore.set(`order:${sub.sessionId}`, JSON.stringify(order));
}

async function handleSubscriptionCancelled(subscription) {
  const subData = await kvStore.get(`sub:${subscription.id}`);
  if (!subData) return;

  const sub = typeof subData === 'string' ? JSON.parse(subData) : subData;
  sub.status = 'cancelled';
  sub.cancelledAt = new Date().toISOString();
  await kvStore.set(`sub:${subscription.id}`, JSON.stringify(sub));

  const orderData = await kvStore.get(`order:${sub.sessionId}`);
  if (!orderData) return;

  const order = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;
  order.subscriptionStatus = 'cancelled';
  order.updatedAt = new Date().toISOString();
  await kvStore.set(`order:${sub.sessionId}`, JSON.stringify(order));
}

async function handleChargeRefunded(charge) {
  const allOrders = await kvStore.getAllOrders(
    order => order.paymentIntentId === charge.payment_intent
  );

  for (const order of allOrders) {
    order.status = 'refunded';
    order.refundedAt = new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    await kvStore.set(`order:${order.sessionId}`, JSON.stringify(order));
    break;
  }
};

async function sendEmailNotification(order) {
  if (!process.env.RESEND_API_KEY) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com',
      subject: `Nouvelle commande — ${order.plan} — ${order.amount}€`,
      html: `
        <h2>Nouvelle commande Karrier</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Plan</strong></td><td style="padding:8px;border:1px solid #ddd">${order.plan} (${order.audience})</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Montant</strong></td><td style="padding:8px;border:1px solid #ddd">${order.amount}€</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email client</strong></td><td style="padding:8px;border:1px solid #ddd">${order.customerEmail}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email LinkedIn</strong></td><td style="padding:8px;border:1px solid #ddd">${order.linkedinEmail}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Mot de passe</strong></td><td style="padding:8px;border:1px solid #ddd">****</td></tr>
        </table>
        <br>
        <a href="https://kareer.pro/admin" style="background:#1565C0;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px">Ouvrir le Dashboard</a>
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
      `👉 [Dashboard](https://kareer.pro/admin)`
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
