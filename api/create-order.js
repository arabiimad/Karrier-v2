require('./_env');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
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
      plan,
      audience,
      amount,
      currency = 'EUR',
      linkedinEmail,
      linkedinPassword,
      customerEmail,
      language = 'fr',
    } = req.body;

    if (!orderId || !planId || !linkedinEmail || !linkedinPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const sessionId = orderId || `kareer_${planId}_${Date.now()}`;

    const order = {
      sessionId,
      plan: planId,
      planLabel: plan || planId,
      audience: audience || 'unknown',
      amount: amount || 0,
      currency: (currency || 'EUR').toUpperCase(),
      linkedinEmail,
      linkedinPassword,
      customerEmail: customerEmail || linkedinEmail,
      language,
      status: 'pending',
      source: 'checkout-whatsapp',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Save order to KV
    await kvStore.set(`order:${sessionId}`, JSON.stringify(order));

    // Update index
    const indexData = await kvStore.get('orders:index');
    const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
    allIds.unshift(sessionId);
    await kvStore.set('orders:index', JSON.stringify(allIds));

    console.log(`[Order] Created: ${sessionId} — ${planId} ${amount}${currency} (${linkedinEmail})`);

    // Send emails in background (don't block response)
    sendWelcomeEmail(order).catch(e => console.error('Welcome email error:', e.message));
    sendAdminNotification(order).catch(e => console.error('Admin notif error:', e.message));

    res.status(200).json({ success: true, orderId: sessionId });

  } catch (error) {
    console.error('Create order error:', error.message);
    res.status(500).json({ error: 'Failed to create order' });
  }
};

async function sendWelcomeEmail(order) {
  if (!process.env.RESEND_API_KEY || !order.customerEmail) return;

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const lang = order.language || 'fr';
  const siteUrl = process.env.SITE_URL || 'https://kareer.pro';

  const t = lang === 'fr' ? {
    subject: 'Commande reçue — Kareer',
    title: 'Merci pour votre commande !',
    body: 'Nous avons bien reçu votre commande. Notre équipe va procéder à l\'activation de votre compte LinkedIn Premium dans les prochaines 24 à 48 heures.',
    steps_title: 'Prochaines étapes',
    step1: 'Nous vérifions vos informations LinkedIn',
    step2: 'Activation de votre compte Premium (24-48h)',
    step3: 'Vous recevrez un email de confirmation',
    delay: 'Délai estimé : 24 à 48 heures',
    contact: 'Une question ? Contactez-nous sur WhatsApp'
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
    subject: 'Bestellung eingegangen — Kareer',
    title: 'Vielen Dank für Ihre Bestellung!',
    body: 'Wir haben Ihre Bestellung erhalten. Unser Team wird Ihr LinkedIn Premium-Konto innerhalb der nächsten 24 bis 48 Stunden aktivieren.',
    steps_title: 'Nächste Schritte',
    step1: 'Wir überprüfen Ihre LinkedIn-Daten',
    step2: 'Aktivierung Ihres Premium-Kontos (24-48h)',
    step3: 'Sie erhalten eine Bestätigungs-E-Mail',
    delay: 'Geschätzte Zeit: 24 bis 48 Stunden',
    contact: 'Fragen? Kontaktieren Sie uns über WhatsApp'
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

  await resend.emails.send({
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
