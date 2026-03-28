require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const checkRate = rateLimit({ windowMs: 60000, max: 10 });

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Allow Vercel cron (GET with ?action=renewal_reminders) or admin POST
  const isCron = req.method === 'GET' && req.query.action === 'renewal_reminders';

  if (!isCron && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rate = checkRate(req);
  if (!rate.allowed) {
    return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter: rate.retryAfter });
  }
  
  if (isCron) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized cron' });
    }
  } else {
    try {
      verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const action = isCron ? 'renewal_reminders' : req.body?.action;
    const session_id = req.body?.session_id;

    if (!action) {
      return res.status(400).json({ error: 'Missing action' });
    }

    let result;
    switch (action) {
      case 'process_pending':
        result = await processPendingOrders();
        break;
      case 'send_reminder':
        result = await sendReminder(session_id);
        break;
      case 'bulk_update':
        result = await bulkUpdateStatus(req.body.from_status, req.body.to_status);
        break;
      case 'cleanup_old':
        result = await cleanupOldOrders(req.body.days || 90);
        break;
      case 'renewal_reminders':
        result = await sendRenewalReminders(req.body.days_before || 30);
        break;
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    res.status(200).json({ success: true, result });

  } catch (error) {
    console.error('Automation error:', error.message);
    res.status(500).json({ error: 'Automation failed' });
  }
};

async function processPendingOrders() {
  const indexData = await kvStore.get('orders:index');
  const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
  
  let processed = 0;
  const results = [];

  for (const id of allIds) {
    const data = await kvStore.get(`order:${id}`);
    if (!data) continue;
    
    const order = typeof data === 'string' ? JSON.parse(data) : data;
    
    if (order.status === 'pending') {
      const hoursSinceCreation = (Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceCreation > 24) {
        order.status = 'activating';
        order.updatedAt = new Date().toISOString();
        await kvStore.set(`order:${id}`, JSON.stringify(order));
        processed++;
        results.push({ id, action: 'moved_to_activating' });
      }
    }
  }

  return { processed, results };
}

async function sendReminder(sessionId) {
  if (!sessionId) {
    throw new Error('session_id required');
  }

  const data = await kvStore.get(`order:${sessionId}`);
  if (!data) {
    throw new Error('Order not found');
  }

  const order = typeof data === 'string' ? JSON.parse(data) : data;

  if (process.env.RESEND_API_KEY && order.customerEmail) {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const statusMessages = {
      fr: {
        pending: 'Votre commande est en attente de traitement.',
        activating: 'Votre compte LinkedIn est en cours d\'activation.',
        done: 'Votre compte LinkedIn Premium est activé !',
        refunded: 'Votre commande a été remboursée.'
      },
      en: {
        pending: 'Your order is pending processing.',
        activating: 'Your LinkedIn account is being activated.',
        done: 'Your LinkedIn Premium account is activated!',
        refunded: 'Your order has been refunded.'
      }
    };

    const lang = order.language || 'fr';
    const messages = statusMessages[lang] || statusMessages.fr;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject: lang === 'fr' ? 'Mise à jour de votre commande Karrier' : 'Karrier Order Update',
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <img src="https://kareer.pro/karrier-logo.png" alt="Karrier" style="width:60px;margin-bottom:20px">
          <h2>${lang === 'fr' ? 'Mise à jour de votre commande' : 'Order Update'}</h2>
          <p><strong>${lang === 'fr' ? 'Statut' : 'Status'}:</strong> ${messages[order.status]}</p>
          <p><strong>${lang === 'fr' ? 'Plan' : 'Plan'}:</strong> ${order.plan} (${order.audience})</p>
          <p><strong>${lang === 'fr' ? 'Montant' : 'Amount'}:</strong> ${order.amount}€</p>
          <br>
          <a href="https://kareer.pro/api/order-status?session_id=${sessionId}" 
             style="background:#1565C0;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block">
            ${lang === 'fr' ? 'Voir le statut' : 'View Status'}
          </a>
        </div>
      `
    });

    return { sent: true, email: order.customerEmail };
  }

  return { sent: false, reason: 'No email configured' };
}

async function bulkUpdateStatus(fromStatus, toStatus) {
  if (!fromStatus || !toStatus) {
    throw new Error('from_status and to_status required');
  }

  const validStatuses = ['pending', 'activating', 'done', 'refunded'];
  if (!validStatuses.includes(fromStatus) || !validStatuses.includes(toStatus)) {
    throw new Error('Invalid status');
  }

  const indexData = await kvStore.get('orders:index');
  const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
  
  let updated = 0;

  for (const id of allIds) {
    const data = await kvStore.get(`order:${id}`);
    if (!data) continue;
    
    const order = typeof data === 'string' ? JSON.parse(data) : data;
    
    if (order.status === fromStatus) {
      order.status = toStatus;
      order.updatedAt = new Date().toISOString();
      await kvStore.set(`order:${id}`, JSON.stringify(order));
      updated++;
    }
  }

  return { updated, fromStatus, toStatus };
}

async function cleanupOldOrders(days) {
  const indexData = await kvStore.get('orders:index');
  const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  
  let cleaned = 0;
  const newIndex = [];

  for (const id of allIds) {
    const data = await kvStore.get(`order:${id}`);
    if (!data) continue;
    
    const order = typeof data === 'string' ? JSON.parse(data) : data;
    const orderDate = new Date(order.createdAt);
    
    if (orderDate < cutoffDate && (order.status === 'done' || order.status === 'refunded')) {
      cleaned++;
    } else {
      newIndex.push(id);
    }
  }

  await kvStore.set('orders:index', JSON.stringify(newIndex));

  return { cleaned, totalRemaining: newIndex.length };
}

async function sendRenewalReminders(daysBefore) {
  if (!process.env.RESEND_API_KEY) {
    return { sent: 0, reason: 'No RESEND_API_KEY configured' };
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const siteUrl = process.env.SITE_URL || 'https://kareer.pro';

  const indexData = await kvStore.get('orders:index');
  const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];

  const now = Date.now();
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const windowMs = daysBefore * 24 * 60 * 60 * 1000;

  let sent = 0;
  const results = [];

  for (const id of allIds) {
    const data = await kvStore.get(`order:${id}`);
    if (!data) continue;

    const order = typeof data === 'string' ? JSON.parse(data) : data;

    // Only remind completed orders
    if (order.status !== 'done') continue;
    if (!order.customerEmail) continue;

    // Already sent renewal reminder
    if (order.renewalReminderSent) continue;

    const createdAt = new Date(order.createdAt).getTime();
    const timeSinceOrder = now - createdAt;

    // Check if order is within the renewal window (1 year - daysBefore to 1 year + 7 days)
    if (timeSinceOrder >= (oneYearMs - windowMs) && timeSinceOrder <= (oneYearMs + 7 * 24 * 60 * 60 * 1000)) {
      const lang = order.language || 'fr';

      const t = lang === 'fr' ? {
        subject: 'Votre abonnement LinkedIn Premium arrive à expiration — Kareer',
        title: 'Renouvelez votre LinkedIn Premium',
        body: `Votre abonnement LinkedIn Premium (${order.planLabel || order.plan}) arrive bientôt à expiration. Renouvelez maintenant pour continuer à profiter de toutes les fonctionnalités Premium sans interruption.`,
        benefit1: 'Même prix avantageux garanti',
        benefit2: 'Activation rapide (24-48h)',
        benefit3: 'Support WhatsApp dédié',
        cta: 'Renouveler maintenant',
        footer: 'Cet email vous est envoyé car votre abonnement arrive à échéance.'
      } : lang === 'es' ? {
        subject: 'Tu suscripción LinkedIn Premium está por vencer — Kareer',
        title: 'Renueva tu LinkedIn Premium',
        body: `Tu suscripción LinkedIn Premium (${order.planLabel || order.plan}) está por vencer. Renueva ahora para seguir disfrutando de todas las funciones Premium sin interrupción.`,
        benefit1: 'Mismo precio ventajoso garantizado',
        benefit2: 'Activación rápida (24-48h)',
        benefit3: 'Soporte WhatsApp dedicado',
        cta: 'Renovar ahora',
        footer: 'Este email se envía porque tu suscripción está por vencer.'
      } : lang === 'de' ? {
        subject: 'Ihr LinkedIn Premium-Abonnement läuft bald ab — Kareer',
        title: 'Erneuern Sie Ihr LinkedIn Premium',
        body: `Ihr LinkedIn Premium-Abonnement (${order.planLabel || order.plan}) läuft bald ab. Erneuern Sie jetzt, um alle Premium-Funktionen ohne Unterbrechung zu nutzen.`,
        benefit1: 'Gleicher günstiger Preis garantiert',
        benefit2: 'Schnelle Aktivierung (24-48h)',
        benefit3: 'Persönlicher WhatsApp-Support',
        cta: 'Jetzt erneuern',
        footer: 'Diese E-Mail wird gesendet, weil Ihr Abonnement bald abläuft.'
      } : {
        subject: 'Your LinkedIn Premium subscription is expiring — Kareer',
        title: 'Renew your LinkedIn Premium',
        body: `Your LinkedIn Premium subscription (${order.planLabel || order.plan}) is about to expire. Renew now to continue enjoying all Premium features without interruption.`,
        benefit1: 'Same great price guaranteed',
        benefit2: 'Fast activation (24-48h)',
        benefit3: 'Dedicated WhatsApp support',
        cta: 'Renew now',
        footer: 'This email is sent because your subscription is about to expire.'
      };

      try {
        await resend.emails.send({
          from: 'Kareer <notifications@kareer.pro>',
          to: order.customerEmail,
          subject: t.subject,
          html: `
            <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
              <div style="background:linear-gradient(135deg,#F59E0B,#EF4444);padding:40px 32px;text-align:center">
                <img src="${siteUrl}/karrier-logo.png" alt="Kareer" style="width:48px;height:48px;margin-bottom:16px">
                <h1 style="color:#fff;margin:0;font-size:24px">⏰ ${t.title}</h1>
              </div>
              <div style="padding:32px">
                <p style="color:#333;font-size:16px;line-height:1.6">${t.body}</p>
                <div style="background:#f0f7ff;border-radius:10px;padding:20px;margin:24px 0">
                  <p style="margin:6px 0;color:#333;font-size:14px">✅ ${t.benefit1}</p>
                  <p style="margin:6px 0;color:#333;font-size:14px">⚡ ${t.benefit2}</p>
                  <p style="margin:6px 0;color:#333;font-size:14px">💬 ${t.benefit3}</p>
                </div>
                <div style="text-align:center;margin-top:24px">
                  <a href="${siteUrl}/#pricing" style="background:#1565C0;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;font-size:16px">${t.cta}</a>
                </div>
              </div>
              <div style="background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#999">
                ${t.footer}
              </div>
            </div>
          `
        });

        // Mark as sent to avoid duplicate reminders
        order.renewalReminderSent = new Date().toISOString();
        order.updatedAt = new Date().toISOString();
        await kvStore.set(`order:${id}`, JSON.stringify(order));

        sent++;
        results.push({ id, email: order.customerEmail, plan: order.planLabel || order.plan });
      } catch (e) {
        console.error(`Renewal email error for ${id}:`, e.message);
        results.push({ id, error: e.message });
      }
    }
  }

  return { sent, results };
}
