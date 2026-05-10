require('./_env');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const { getPlan } = require('./_plans');
const {
  buildEmailHtml,
  detailTable,
  emailButton,
  escapeHtml,
  formatAudience,
  formatCurrency,
  formatPlan,
  getSiteUrl,
  stepsBox
} = require('./_email');
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
      orderId,
      planId,
      linkedinEmail,
      customerEmail,
      language = 'fr',
      referralCode,
      promoCode,
    } = req.body;

    if (!orderId || !planId || !linkedinEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const planInfo = getPlan(planId);
    if (!planInfo) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const sessionId = orderId || `kareer_${planId}_${Date.now()}`;
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
      plan: planId,
      planLabel: planInfo.planLabel,
      audience: planInfo.audience,
      originalAmount: planInfo.amount,
      amount: Math.max(0, amount),
      currency: planInfo.currency,
      discounts,
      promoCode: normalizedPromoCode,
      usedReferralCode: normalizedReferralCode,
      linkedinEmail,
      customerEmail: customerEmail || linkedinEmail,
      language,
      status: 'pending_payment',
      source: 'checkout-whatsapp',
      hasCredentials: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Save order to KV
    await kvStore.set(`order:${sessionId}`, JSON.stringify(order));

    // Update index
    const indexData = await kvStore.get('orders:index');
    const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
    if (!allIds.includes(sessionId)) {
      allIds.unshift(sessionId);
      await kvStore.set('orders:index', JSON.stringify(allIds));
    }

    console.log(`[Order] Created: ${sessionId} - ${planId} ${order.amount}${order.currency} (${linkedinEmail})`);

    // Send emails in background (don't block response)
    sendWelcomeEmail(order).catch(e => console.error('Welcome email error:', e.message));
    sendAdminNotification(order).catch(e => console.error('Admin notif error:', e.message));

    res.status(200).json({
      success: true,
      orderId: sessionId,
      amount: order.amount,
      currency: order.currency,
      status: order.status
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
  const referralData = await kvStore.get(`referral:${referralCode}`);
  if (!referralData) {
    const error = new Error('Invalid referral code');
    error.statusCode = 400;
    throw error;
  }

  const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;
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

async function sendWelcomeEmail(order) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[Email] RESEND_API_KEY not configured');
    return;
  }
  if (!order.customerEmail) {
    console.log('[Email] No customer email in order:', order.sessionId);
    return;
  }

  console.log(`[Email] Sending welcome email to ${order.customerEmail} (${order.language})`);

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const lang = order.language || 'fr';
    const siteUrl = getSiteUrl();
    
    console.log('[Email] Resend initialized, preparing email content');

    const t = lang === 'fr' ? {
      subject: 'Commande reçue — Kareer',
      title: 'Commande enregistrée',
      preheader: 'Votre commande est enregistrée. Le paiement se fait maintenant via WhatsApp.',
      body: 'Votre commande est bien enregistrée. Payez via WhatsApp ; après validation du paiement, vous recevrez un lien sécurisé pour transmettre votre mot de passe LinkedIn.',
      stepsTitle: 'Prochaines étapes',
      steps: [
        'Vous finalisez le paiement avec notre équipe sur WhatsApp.',
        'Nous validons le paiement et vous envoyons un lien sécurisé.',
        'Vous transmettez vos identifiants, puis nous lançons l’activation.'
      ],
      delay: 'Délai estimé : 24 à 48 heures après réception des identifiants.',
      amount: 'Montant',
      order: 'Commande',
      contact: 'Procéder au paiement sur WhatsApp',
      footer: 'Vous recevez cet email car vous avez commencé une commande sur kareer.pro.'
    } : lang === 'es' ? {
      subject: 'Pedido recibido — Kareer',
      title: 'Pedido registrado',
      preheader: 'Tu pedido está registrado. El pago se finaliza por WhatsApp.',
      body: 'Tu pedido está registrado. Paga por WhatsApp; después de la validación recibirás un enlace seguro para enviar tu contraseña de LinkedIn.',
      stepsTitle: 'Próximos pasos',
      steps: [
        'Finalizas el pago con nuestro equipo por WhatsApp.',
        'Validamos el pago y enviamos el enlace seguro.',
        'Envías tus credenciales y empezamos la activación.'
      ],
      delay: 'Tiempo estimado: 24 a 48 horas después de recibir tus credenciales.',
      amount: 'Monto',
      order: 'Pedido',
      contact: 'Pagar por WhatsApp',
      footer: 'Recibes este email porque has iniciado un pedido en kareer.pro.'
    } : lang === 'de' ? {
      subject: 'Bestellung erhalten — Kareer',
      title: 'Bestellung registriert',
      preheader: 'Ihre Bestellung ist registriert. Die Zahlung erfolgt über WhatsApp.',
      body: 'Ihre Bestellung wurde registriert. Zahlen Sie über WhatsApp. Nach der Bestätigung erhalten Sie einen sicheren Link für Ihr LinkedIn-Passwort.',
      stepsTitle: 'Nächste Schritte',
      steps: [
        'Sie schließen die Zahlung mit unserem Team über WhatsApp ab.',
        'Wir bestätigen Ihre Zahlung und senden den sicheren Link.',
        'Sie senden Ihre Zugangsdaten, dann starten wir die Aktivierung.'
      ],
      delay: 'Geschätzte Zeit: 24 bis 48 Stunden nach Erhalt der Zugangsdaten.',
      amount: 'Betrag',
      order: 'Bestellung',
      contact: 'Über WhatsApp bezahlen',
      footer: 'Sie erhalten diese E-Mail, weil Sie eine Bestellung auf kareer.pro gestartet haben.'
    } : {
      subject: 'Order received — Kareer',
      title: 'Order registered',
      preheader: 'Your order is registered. Payment is completed through WhatsApp.',
      body: 'Your order is registered. Pay through WhatsApp; after validation you will receive a secure link to submit your LinkedIn password.',
      stepsTitle: 'Next steps',
      steps: [
        'You complete payment with our team on WhatsApp.',
        'We validate your payment and send the secure link.',
        'You submit your credentials, then we start activation.'
      ],
      delay: 'Estimated time: 24 to 48 hours after receiving your credentials.',
      amount: 'Amount',
      order: 'Order',
      contact: 'Pay on WhatsApp',
      footer: 'You are receiving this email because you started an order on kareer.pro.'
    };

    const content = `
      <p style="margin:0 0 18px;color:#1f2937;font-size:16px;line-height:1.6">${escapeHtml(t.body)}</p>
      ${detailTable([
        { label: 'Plan', value: order.planLabel ? `${order.planLabel} · ${formatAudience(order.audience, lang)}` : formatPlan(order.plan, order.audience, lang) },
        { label: t.amount, value: formatCurrency(order.amount, order.currency || 'EUR', lang) },
        { label: t.order, value: order.sessionId }
      ])}
      ${stepsBox(t.stepsTitle, t.steps, t.delay)}
      ${emailButton(t.contact, 'https://wa.me/212651064637', { color: '#22C55E' })}
    `;

    console.log('[Email] Calling resend.emails.send...');
    const emailResult = await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject: t.subject,
      html: buildEmailHtml({
        siteUrl,
        title: t.title,
        preheader: t.preheader,
        content,
        footer: t.footer,
        lang
      }),
      text: `${t.title}\n\n${t.body}\n\nPlan: ${formatPlan(order.plan, order.audience, lang)}\n${t.amount}: ${formatCurrency(order.amount, order.currency || 'EUR', lang)}\n${t.order}: ${order.sessionId}\n\n${t.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n${t.contact}: https://wa.me/212651064637`
    });
    
    console.log(`[Email] Welcome email sent successfully to ${order.customerEmail}`, emailResult);
  } catch (error) {
    console.error('[Email] Error sending welcome email:', error.message);
    console.error('[Email] Full error:', error);
  }
}

async function sendAdminNotification(order) {
  if (!process.env.RESEND_API_KEY) return;

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const adminEmail = process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com';
  const siteUrl = getSiteUrl();
  const plan = order.planLabel ? `${order.planLabel} · ${formatAudience(order.audience, 'fr')}` : formatPlan(order.plan, order.audience, 'fr');
  const content = `
    <p style="margin:0 0 18px;color:#1f2937;font-size:16px;line-height:1.6">Une nouvelle commande WhatsApp vient d’être créée.</p>
    ${detailTable([
      { label: 'Plan', value: plan },
      { label: 'Montant', value: formatCurrency(order.amount, order.currency || 'EUR', 'fr') },
      { label: 'Email client', value: order.customerEmail },
      { label: 'Email LinkedIn', value: order.linkedinEmail },
      { label: 'Commande', value: order.sessionId },
      { label: 'Date', value: new Date(order.createdAt).toLocaleString('fr-FR') }
    ])}
    ${emailButton('Ouvrir le dashboard', `${siteUrl}/admin`)}
  `;

  await resend.emails.send({
    from: 'Kareer <notifications@kareer.pro>',
    to: adminEmail,
    subject: `Nouvelle commande — ${plan} — ${formatCurrency(order.amount, order.currency || 'EUR', 'fr')}`,
    html: buildEmailHtml({
      siteUrl,
      title: 'Nouvelle commande WhatsApp',
      preheader: `${plan} — ${formatCurrency(order.amount, order.currency || 'EUR', 'fr')}`,
      content,
      footer: 'Notification interne Kareer.',
      lang: 'fr'
    }),
    text: `Nouvelle commande WhatsApp\n\nPlan: ${plan}\nMontant: ${formatCurrency(order.amount, order.currency || 'EUR', 'fr')}\nEmail client: ${order.customerEmail}\nEmail LinkedIn: ${order.linkedinEmail}\nCommande: ${order.sessionId}\nAdmin: ${siteUrl}/admin`
  });
}
