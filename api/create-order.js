require('./_env');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const { getPlan } = require('./_plans');
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
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';
    
    console.log('[Email] Resend initialized, preparing email content');

  const t = lang === 'fr' ? {
    subject: 'Confirmez votre commande — Kareer',
    title: 'Merci pour votre commande !',
    body: 'Votre commande a été enregistrée avec succès. Pour finaliser votre achat et procéder à l\'activation de votre compte LinkedIn Premium, merci de procéder au paiement via WhatsApp.',
    steps_title: 'Prochaines étapes',
    step1: 'Contactez-nous sur WhatsApp pour le paiement',
    step2: 'Nous validons votre paiement (quelques minutes)',
    step3: 'Activation de votre compte Premium (24-48h)',
    delay: 'Délai total estimé : 24 à 48 heures après paiement',
    contact: 'Procéder au paiement sur WhatsApp'
  } : lang === 'es' ? {
    subject: 'Pedido recibido — Kareer',
    title: '¡Gracias por tu pedido!',
    body: 'Hemos recibido tu pedido. Nuestro equipo procederá a la activación de tu cuenta LinkedIn Premium en las próximas 24 a 48 horas.',
    steps_title: 'Próximos pasos',
    step1: 'Verificamos tus datos de LinkedIn',
    step2: 'Activación de tu cuenta Premium (24-48h)',
    step3: 'Recibirás un email de confirmación',
    delay: 'Tiempo estimado: 24 a 48 horas',
    contact: '¿Una pregunta? Contáctanos por WhatsApp'
  } : lang === 'de' ? {
    subject: 'Bestätigen Sie Ihre Bestellung — Kareer',
    title: 'Vielen Dank für Ihre Bestellung!',
    body: 'Ihre Bestellung wurde erfolgreich registriert. Um Ihren Kauf abzuschließen und die Aktivierung Ihres LinkedIn Premium-Kontos zu starten, zahlen Sie bitte über WhatsApp.',
    steps_title: 'Nächste Schritte',
    step1: 'Kontaktieren Sie uns auf WhatsApp für die Zahlung',
    step2: 'Wir bestätigen Ihre Zahlung (wenige Minuten)',
    step3: 'Aktivierung Ihres Premium-Kontos (24-48h)',
    delay: 'Geschätzte Gesamtzeit: 24 bis 48 Stunden nach Zahlung',
    contact: 'Zur Zahlung auf WhatsApp'
  } : {
    subject: 'Order received — Kareer',
    title: 'Thank you for your order!',
    body: 'We have received your order. Our team will activate your LinkedIn Premium account within the next 24 to 48 hours.',
    steps_title: 'Next steps',
    step1: 'We verify your LinkedIn information',
    step2: 'Premium account activation (24-48h)',
    step3: 'You will receive a confirmation email',
    delay: 'Estimated time: 24 to 48 hours',
    contact: 'Any questions? Contact us on WhatsApp'
  };

    if (lang === 'fr') {
      t.body = 'Votre commande a ete enregistree. Payez via WhatsApp, puis apres validation vous recevrez un lien securise pour transmettre votre mot de passe LinkedIn.';
      t.step1 = 'Contactez-nous sur WhatsApp pour le paiement';
      t.step2 = 'Nous validons votre paiement et envoyons le lien securise';
      t.step3 = 'Vous transmettez vos identifiants, puis nous activons le compte';
      t.delay = 'Delai estime : 24 a 48 heures apres reception des identifiants';
    } else if (lang === 'de') {
      t.body = 'Ihre Bestellung wurde registriert. Zahlen Sie per WhatsApp. Nach der Bestatigung erhalten Sie einen sicheren Link fur Ihr LinkedIn-Passwort.';
      t.step2 = 'Wir bestatigen Ihre Zahlung und senden den sicheren Link';
      t.step3 = 'Sie senden Ihre Zugangsdaten, dann starten wir die Aktivierung';
    } else if (lang === 'es') {
      t.body = 'Tu pedido esta registrado. Paga por WhatsApp; despues de la validacion recibiras un enlace seguro para enviar tu contrasena de LinkedIn.';
      t.step2 = 'Validamos el pago y enviamos el enlace seguro';
      t.step3 = 'Envias tus credenciales y activamos la cuenta';
    } else {
      t.body = 'Your order is registered. Pay through WhatsApp; after validation you will receive a secure link to submit your LinkedIn password.';
      t.step2 = 'We validate your payment and send the secure link';
      t.step3 = 'You submit your credentials, then we activate the account';
    }

    console.log('[Email] Calling resend.emails.send...');
    const emailResult = await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject: t.subject,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
          <div style="background:linear-gradient(135deg,#1565C0,#42A5F5);padding:40px 32px;text-align:center">
            <img src="${siteUrl}/kareer-logo.png" alt="Kareer" style="width:48px;height:48px;margin-bottom:16px">
            <h1 style="color:#fff;margin:0;font-size:24px">${t.title}</h1>
          </div>
          <div style="padding:32px">
            <p style="color:#333;font-size:16px;line-height:1.6">${t.body}</p>
            <table style="width:100%;border-collapse:collapse;margin:24px 0">
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Plan</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.planLabel} (${order.audience})</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">${lang === 'fr' ? 'Montant' : lang === 'es' ? 'Monto' : lang === 'de' ? 'Betrag' : 'Amount'}</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.amount}€</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">${lang === 'fr' ? 'Commande' : lang === 'es' ? 'Pedido' : lang === 'de' ? 'Bestellung' : 'Order'}</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600;font-size:12px;color:#666">${order.sessionId}</td></tr>
            </table>
            <div style="background:#f0f7ff;border-radius:10px;padding:20px;margin:24px 0">
              <h3 style="color:#1565C0;margin:0 0 12px;font-size:15px">${t.steps_title}</h3>
              <p style="margin:6px 0;color:#333;font-size:14px">1️⃣ ${t.step1}</p>
              <p style="margin:6px 0;color:#333;font-size:14px">2️⃣ ${t.step2}</p>
              <p style="margin:6px 0;color:#333;font-size:14px">3️⃣ ${t.step3}</p>
              <p style="margin:12px 0 0;color:#666;font-size:13px;font-style:italic">⏱️ ${t.delay}</p>
            </div>
            <div style="text-align:center;margin-top:24px">
              <a href="https://wa.me/212651064637" style="background:#25D366;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">💬 ${t.contact}</a>
            </div>
          </div>
          <div style="background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#999">
            Kareer — LinkedIn Premium ${lang === 'fr' ? 'à prix réduit' : lang === 'es' ? 'a precio reducido' : lang === 'de' ? 'zum reduzierten Preis' : 'at reduced price'}
          </div>
        </div>
      `
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

  await resend.emails.send({
    from: 'Kareer <notifications@kareer.pro>',
    to: adminEmail,
    subject: `🛒 Nouvelle commande — ${order.planLabel} — ${order.amount}€`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#1565C0">🛒 Nouvelle commande WhatsApp</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Plan</strong></td><td style="padding:8px;border:1px solid #ddd">${order.planLabel} (${order.audience})</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Montant</strong></td><td style="padding:8px;border:1px solid #ddd">${order.amount}€</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email client</strong></td><td style="padding:8px;border:1px solid #ddd">${order.customerEmail}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Email LinkedIn</strong></td><td style="padding:8px;border:1px solid #ddd">${order.linkedinEmail}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>ID</strong></td><td style="padding:8px;border:1px solid #ddd">${order.sessionId}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Date</strong></td><td style="padding:8px;border:1px solid #ddd">${order.createdAt}</td></tr>
        </table>
        <br>
        <a href="https://kareer.pro/admin" style="background:#1565C0;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block">Ouvrir le Dashboard</a>
      </div>
    `
  });
}
