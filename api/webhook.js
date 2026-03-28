require('./_env');
const Stripe = require('stripe');
const kvStore = require('./_kv');
const { formatPlan, getSiteUrl, buildEmailHtml } = require('./_email');

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
  // Idempotency — skip if order already exists
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
    promoCode: session.metadata?.promoCode || '',
    mode: session.mode || 'payment',
    amount: (session.amount_total || 0) / 100,
    currency: session.currency || 'eur',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Store order first (acts as idempotency lock)
  await kvStore.set(`order:${session.id}`, JSON.stringify(order));

  // Fix race condition — check for duplicates before adding to index
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

  // Track promo usage if a promo code was applied
  if (order.promoCode) {
    try {
      const pKey = `promo:${order.promoCode.toUpperCase()}`;
      const pData = await kvStore.get(pKey);
      if (pData) {
        const promo = typeof pData === 'string' ? JSON.parse(pData) : pData;
        promo.usedCount = (promo.usedCount || 0) + 1;
        await kvStore.set(pKey, JSON.stringify(promo));
      }
    } catch (promoErr) {
      console.error('Promo usage tracking error:', promoErr.message);
    }
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
    const siteUrl = getSiteUrl();

    const content = `
      <p style="margin:0 0 16px;color:#374151;font-size:16px;line-height:1.7">Votre paiement n'a pas pu être traité. Cela peut être dû à un solde insuffisant ou une carte expirée.</p>
      <p style="margin:0 0 24px;color:#374151;font-size:16px;line-height:1.7">Vous pouvez réessayer en cliquant ci-dessous :</p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center">
          <a href="${siteUrl}/#pricing" style="display:inline-block;background:#1565C0;color:#ffffff;font-size:15px;font-weight:600;padding:14px 36px;border-radius:8px;text-decoration:none">Réessayer le paiement</a>
        </td></tr>
      </table>
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      reply_to: 'contact@kareer.pro',
      to: email,
      subject: 'Problème avec votre paiement — Kareer',
      text: 'Votre paiement n\'a pas pu être traité. Réessayez sur kareer.pro',
      headers: { 'List-Unsubscribe': '<mailto:contact@kareer.pro?subject=unsubscribe>' },
      html: buildEmailHtml({
        siteUrl,
        headerColor: '#DC2626',
        title: 'Paiement échoué',
        preheader: 'Votre paiement n\'a pas pu être traité. Réessayez en cliquant ici.',
        content,
        footer: 'Vous recevez cet email car un paiement a été tenté sur kareer.pro.'
      })
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
    const siteUrl = getSiteUrl();
    const planLabel = formatPlan(order.plan, order.audience, lang);
    const shortId = (order.sessionId || '').slice(-8).toUpperCase();
    const isFr = lang === 'fr';

    const t = isFr ? {
      subject: `Commande confirmée — Réf. ${shortId}`,
      preheader: 'Votre paiement a été reçu. Activation LinkedIn Premium sous 24-48h.',
      title: 'Commande confirmée !',
      body: 'Votre paiement a bien été reçu. Notre équipe active votre compte LinkedIn Premium dans les prochaines heures.',
      stepsTitle: 'Prochaines étapes',
      step1: 'Vérification de vos informations LinkedIn',
      step2: 'Activation de votre compte (24–48h)',
      step3: 'Email de confirmation dès que c\'est prêt',
      delay: '⏱ Délai estimé : 24 à 48 heures',
      track: 'Suivre ma commande →',
      planLbl: 'Plan',
      amountLbl: 'Montant payé',
      refLbl: 'Référence',
      contact: 'Une question ? Répondez à cet email ou écrivez à contact@kareer.pro',
      footer: 'Vous recevez cet email car vous avez passé une commande sur kareer.pro.'
    } : {
      subject: `Order confirmed — Ref. ${shortId}`,
      preheader: 'Your payment has been received. LinkedIn Premium activation within 24-48h.',
      title: 'Order confirmed!',
      body: 'Your payment has been received. Our team will activate your LinkedIn Premium account within the next few hours.',
      stepsTitle: 'Next steps',
      step1: 'Verification of your LinkedIn information',
      step2: 'Account activation (24–48h)',
      step3: 'Confirmation email once it\'s ready',
      delay: '⏱ Estimated time: 24 to 48 hours',
      track: 'Track my order →',
      planLbl: 'Plan',
      amountLbl: 'Amount paid',
      refLbl: 'Reference',
      contact: 'Questions? Reply to this email or write to contact@kareer.pro',
      footer: 'You received this email because you placed an order on kareer.pro.'
    };

    const plainText = [
      t.title, '',
      t.body, '',
      `${t.planLbl}: ${planLabel}`,
      `${t.amountLbl}: ${order.amount}€`,
      `${t.refLbl}: #${shortId}`, '',
      `${t.track} ${siteUrl}/suivi?id=${order.sessionId}`, '',
      t.contact
    ].join('\n');

    const content = `
      <p style="margin:0 0 20px;color:#374151;font-size:16px;line-height:1.7">${t.body}</p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin:0 0 24px">
        <tr style="background:#f9fafb">
          <td style="padding:12px 16px;color:#6b7280;font-size:14px;font-weight:600;width:45%;border-bottom:1px solid #e5e7eb">${t.planLbl}</td>
          <td style="padding:12px 16px;color:#111827;font-size:14px;font-weight:700;border-bottom:1px solid #e5e7eb">${planLabel}</td>
        </tr>
        <tr>
          <td style="padding:12px 16px;color:#6b7280;font-size:14px;font-weight:600;border-bottom:1px solid #e5e7eb">${t.amountLbl}</td>
          <td style="padding:12px 16px;color:#111827;font-size:14px;font-weight:700;border-bottom:1px solid #e5e7eb">${order.amount}€</td>
        </tr>
        <tr style="background:#f9fafb">
          <td style="padding:12px 16px;color:#6b7280;font-size:14px;font-weight:600">${t.refLbl}</td>
          <td style="padding:12px 16px;color:#111827;font-size:14px;font-weight:700">#${shortId}</td>
        </tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eff6ff;border-radius:10px;margin:0 0 24px">
        <tr><td style="padding:20px">
          <p style="margin:0 0 12px;color:#1e40af;font-size:15px;font-weight:700">${t.stepsTitle}</p>
          <p style="margin:0 0 8px;color:#1e3a8a;font-size:14px">① ${t.step1}</p>
          <p style="margin:0 0 8px;color:#1e3a8a;font-size:14px">② ${t.step2}</p>
          <p style="margin:0 0 12px;color:#1e3a8a;font-size:14px">③ ${t.step3}</p>
          <p style="margin:0;color:#3b82f6;font-size:13px;font-weight:500">${t.delay}</p>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">
        <tr><td align="center">
          <a href="${siteUrl}/suivi?id=${order.sessionId}" style="display:inline-block;background:#1565C0;color:#ffffff;font-size:15px;font-weight:600;padding:14px 36px;border-radius:8px;text-decoration:none">${t.track}</a>
        </td></tr>
      </table>
      <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6">${t.contact}</p>
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      reply_to: 'contact@kareer.pro',
      to: order.customerEmail,
      subject: t.subject,
      text: plainText,
      headers: {
        'List-Unsubscribe': '<mailto:contact@kareer.pro?subject=unsubscribe>',
        'X-Entity-Ref-ID': order.sessionId || ''
      },
      html: buildEmailHtml({
        siteUrl,
        headerColor: '#1565C0',
        title: t.title,
        preheader: t.preheader,
        content,
        footer: t.footer
      })
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
}

async function sendEmailNotification(order) {
  if (!process.env.RESEND_API_KEY) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const siteUrl = getSiteUrl();
    const planLabel = formatPlan(order.plan, order.audience, 'fr');

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com',
      subject: `🆕 Commande — ${planLabel} — ${order.amount}€`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#1565C0;margin:0 0 16px">Nouvelle commande Kareer</h2>
          <table style="border-collapse:collapse;width:100%;font-size:14px">
            <tr><td style="padding:10px;border:1px solid #ddd;background:#f9f9f9;font-weight:600;width:40%">Plan</td><td style="padding:10px;border:1px solid #ddd">${planLabel}</td></tr>
            <tr><td style="padding:10px;border:1px solid #ddd;background:#f9f9f9;font-weight:600">Montant</td><td style="padding:10px;border:1px solid #ddd">${order.amount}€</td></tr>
            <tr><td style="padding:10px;border:1px solid #ddd;background:#f9f9f9;font-weight:600">Email client</td><td style="padding:10px;border:1px solid #ddd">${order.customerEmail}</td></tr>
            <tr><td style="padding:10px;border:1px solid #ddd;background:#f9f9f9;font-weight:600">Email LinkedIn</td><td style="padding:10px;border:1px solid #ddd">${order.linkedinEmail}</td></tr>
            <tr><td style="padding:10px;border:1px solid #ddd;background:#f9f9f9;font-weight:600">Mot de passe</td><td style="padding:10px;border:1px solid #ddd">Voir le dashboard</td></tr>
          </table>
          <br>
          <a href="${siteUrl}/admin" style="display:inline-block;background:#1565C0;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600">Ouvrir le Dashboard</a>
        </div>
      `
    });
  } catch (error) {
    console.error('Admin email error:', error.message);
  }
}

async function sendTelegramNotification(order) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  try {
    const planLabel = formatPlan(order.plan, order.audience, 'fr');
    const siteUrl = getSiteUrl();

    const text = [
      `🎉 *Nouvelle commande*`,
      ``,
      `📦 *Plan:* ${planLabel}`,
      `💰 *Montant:* ${order.amount}€`,
      `📧 *Email:* ${order.customerEmail}`,
      `🔑 *LinkedIn:* ${order.linkedinEmail}`,
      ``,
      `👉 [Dashboard](${siteUrl}/admin)`
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
