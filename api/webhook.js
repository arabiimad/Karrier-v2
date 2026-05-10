require('./_env');
const Stripe = require('stripe');
const kvStore = require('./_kv');
const {
  buildEmailHtml,
  detailTable,
  emailButton,
  escapeHtml,
  formatCurrency,
  formatPlan,
  getSiteUrl,
  stepsBox
} = require('./_email');

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

  const order = {
    sessionId: session.id,
    paymentIntentId: session.payment_intent,
    subscriptionId: session.subscription || null,
    customerId: session.customer || null,
    customerEmail: session.customer_details?.email || '',
    linkedinEmail,
    plan: session.metadata?.plan || '',
    audience: session.metadata?.audience || '',
    language: session.metadata?.language || 'fr',
    mode: session.mode || 'payment',
    amount: (session.amount_total || 0) / 100,
    currency: session.currency || 'eur',
    status: 'awaiting_credentials',
    hasCredentials: false,
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
    const siteUrl = getSiteUrl();
    const amount = formatCurrency((paymentIntent.amount || 0) / 100, String(paymentIntent.currency || 'eur').toUpperCase(), 'fr');
    const content = `
      <p style="margin:0 0 18px;color:#1f2937;font-size:16px;line-height:1.6">
        Votre paiement n’a pas pu être traité. Cela peut venir d’un solde insuffisant, d’une carte expirée ou d’une validation bancaire non terminée.
      </p>
      ${detailTable([
        { label: 'Email', value: email },
        { label: 'Montant', value: amount }
      ])}
      <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">
        Si le problème persiste, contactez-nous et nous vous aiderons à finaliser la commande.
      </p>
      ${emailButton('Réessayer le paiement', `${siteUrl}/#pricing`)}
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: email,
      subject: 'Problème avec votre paiement — Kareer',
      html: buildEmailHtml({
        siteUrl,
        headerColor: '#dc2626',
        title: 'Paiement échoué',
        preheader: 'Votre paiement n’a pas pu être traité.',
        content,
        footer: 'Besoin d’aide ? Répondez à cet email ou contactez-nous sur WhatsApp.',
        lang: 'fr'
      }),
      text: `Paiement échoué\n\nVotre paiement n’a pas pu être traité.\nMontant: ${amount}\nRéessayer: ${siteUrl}/#pricing`
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

    const t = lang === 'fr' ? {
      subject: 'Commande confirmée — Kareer',
      title: 'Commande confirmée',
      body: 'Nous avons bien reçu votre paiement. Pour démarrer l’activation, vous recevrez un lien sécurisé si vos identifiants LinkedIn sont nécessaires.',
      stepsTitle: 'Prochaines étapes',
      steps: [
        'Nous validons les informations de commande.',
        'Vous transmettez vos identifiants via le lien sécurisé si besoin.',
        'Notre équipe lance l’activation LinkedIn Premium.'
      ],
      track: 'Suivre ma commande',
      delay: 'Délai estimé : 24 à 48 heures.'
    } : {
      subject: 'Order confirmed — Kareer',
      title: 'Order confirmed',
      body: 'We have received your payment. To start activation, you will receive a secure link if your LinkedIn credentials are required.',
      stepsTitle: 'Next steps',
      steps: [
        'We validate the order details.',
        'You submit credentials through the secure link if needed.',
        'Our team starts the LinkedIn Premium activation.'
      ],
      track: 'Track my order',
      delay: 'Estimated time: 24 to 48 hours.'
    };
    const amountLabel = lang === 'fr' ? 'Montant' : 'Amount';
    const content = `
      <p style="margin:0 0 18px;color:#1f2937;font-size:16px;line-height:1.6">${escapeHtml(t.body)}</p>
      ${detailTable([
        { label: 'Plan', value: formatPlan(order.plan, order.audience, lang) },
        { label: amountLabel, value: formatCurrency(order.amount, order.currency || 'EUR', lang) },
        { label: lang === 'fr' ? 'Commande' : 'Order', value: order.sessionId }
      ])}
      ${stepsBox(t.stepsTitle, t.steps, t.delay)}
      ${emailButton(t.track, `${siteUrl}/suivi?id=${encodeURIComponent(order.sessionId)}`)}
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject: t.subject,
      html: buildEmailHtml({
        siteUrl,
        title: t.title,
        preheader: t.body,
        content,
        lang
      }),
      text: `${t.title}\n\n${t.body}\n\nPlan: ${formatPlan(order.plan, order.audience, lang)}\n${amountLabel}: ${formatCurrency(order.amount, order.currency || 'EUR', lang)}\n${t.track}: ${siteUrl}/suivi?id=${order.sessionId}`
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
    const siteUrl = getSiteUrl();
    const plan = formatPlan(order.plan, order.audience, 'fr');
    const amount = formatCurrency(order.amount, order.currency || 'EUR', 'fr');
    const content = `
      <p style="margin:0 0 18px;color:#1f2937;font-size:16px;line-height:1.6">Une nouvelle commande Stripe vient d’être confirmée.</p>
      ${detailTable([
        { label: 'Plan', value: plan },
        { label: 'Montant', value: amount },
        { label: 'Email client', value: order.customerEmail },
        { label: 'Email LinkedIn', value: order.linkedinEmail },
        { label: 'Commande', value: order.sessionId }
      ])}
      ${emailButton('Ouvrir le dashboard', `${siteUrl}/admin`)}
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com',
      subject: `Nouvelle commande — ${plan} — ${amount}`,
      html: buildEmailHtml({
        siteUrl,
        title: 'Nouvelle commande Stripe',
        preheader: `${plan} — ${amount}`,
        content,
        footer: 'Notification interne Kareer.',
        lang: 'fr'
      }),
      text: `Nouvelle commande Stripe\n\nPlan: ${plan}\nMontant: ${amount}\nEmail client: ${order.customerEmail}\nEmail LinkedIn: ${order.linkedinEmail}\nCommande: ${order.sessionId}\nAdmin: ${siteUrl}/admin`
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
