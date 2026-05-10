require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const checkRate = rateLimit({ windowMs: 60000, max: 10 });

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Allow Vercel cron (GET with ?action=...) or admin POST
  const isCron = req.method === 'GET' && ['renewal_reminders', 'monthly_report', 'process_pending', 'cleanup_credentials'].includes(req.query.action);

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
    const action = isCron ? req.query.action : req.body?.action;
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
      case 'cleanup_credentials':
        result = await cleanupExpiredCredentials();
        break;
      case 'renewal_reminders':
        result = await sendRenewalReminders((req.body && req.body.days_before) || 30);
        break;
      case 'monthly_report':
        result = await sendMonthlyReport();
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
  const credentialsCleanup = await cleanupExpiredCredentials();
  const indexData = await kvStore.get('orders:index');
  const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
  
  let processed = 0;
  const results = [];

  for (const id of allIds) {
    const data = await kvStore.get(`order:${id}`);
    if (!data) continue;
    
    const order = typeof data === 'string' ? JSON.parse(data) : data;
    
    if (order.status === 'pending' && (order.hasCredentials || order.linkedinPassword || (order.credentials && order.credentials.linkedinPassword))) {
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

  return { processed, credentialsCleaned: credentialsCleanup.cleaned, results };
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
        pending_payment: 'Votre paiement est en attente de validation.',
        awaiting_credentials: 'Votre paiement est valide. Nous attendons vos identifiants via le lien securise.',
        activating: 'Votre compte LinkedIn est en cours d\'activation.',
        done: 'Votre compte LinkedIn Premium est activé !',
        refunded: 'Votre commande a été remboursée.'
      },
      en: {
        pending: 'Your order is pending processing.',
        pending_payment: 'Your payment is waiting for validation.',
        awaiting_credentials: 'Your payment is confirmed. We are waiting for your credentials through the secure link.',
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
          <img src="https://kareer.pro/kareer-logo.png" alt="Karrier" style="width:60px;margin-bottom:20px">
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

  const validStatuses = ['pending', 'pending_payment', 'awaiting_credentials', 'activating', 'done', 'refunded'];
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
      if (toStatus === 'done') {
        deleteCredentials(order);
      }
      await kvStore.set(`order:${id}`, JSON.stringify(order));
      updated++;
    }
  }

  return { updated, fromStatus, toStatus };
}

async function cleanupExpiredCredentials() {
  const indexData = await kvStore.get('orders:index');
  const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
  let cleaned = 0;

  for (const id of allIds) {
    const data = await kvStore.get(`order:${id}`);
    if (!data) continue;

    const order = typeof data === 'string' ? JSON.parse(data) : data;
    const expiresAt = order.credentials && order.credentials.expiresAt;
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      deleteCredentials(order);
      order.updatedAt = new Date().toISOString();
      await kvStore.set(`order:${id}`, JSON.stringify(order));
      cleaned++;
    }
  }

  return { cleaned };
}

function deleteCredentials(order) {
  delete order.credentials;
  delete order.linkedinPassword;
  order.hasCredentials = false;
  order.credentialsDeletedAt = new Date().toISOString();
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

async function sendMonthlyReport() {
  if (!process.env.RESEND_API_KEY) {
    return { sent: false, reason: 'No RESEND_API_KEY configured' };
  }

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const adminEmail = process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com';

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed; report is for previous month
  const reportMonth = month === 0 ? 11 : month - 1;
  const reportYear = month === 0 ? year - 1 : year;

  const monthNames = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const monthLabel = monthNames[reportMonth];

  const startOfMonth = new Date(reportYear, reportMonth, 1).getTime();
  const endOfMonth = new Date(reportYear, reportMonth + 1, 0, 23, 59, 59, 999).getTime();

  const indexData = await kvStore.get('orders:index');
  const allIds = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];

  const stats = {
    total: 0,
    revenue: 0,
    byPlan: {},
    byStatus: { pending: 0, activating: 0, done: 0, refunded: 0 },
    refunds: 0,
    refundRevenue: 0
  };

  for (const id of allIds) {
    const data = await kvStore.get(`order:${id}`);
    if (!data) continue;
    const order = typeof data === 'string' ? JSON.parse(data) : data;
    const createdAt = new Date(order.createdAt).getTime();
    if (createdAt < startOfMonth || createdAt > endOfMonth) continue;

    stats.total++;
    const amount = parseFloat(order.amount) || 0;

    if (order.status !== 'refunded') {
      stats.revenue += amount;
    }

    stats.byStatus[order.status] = (stats.byStatus[order.status] || 0) + 1;

    const planKey = order.plan || 'Inconnu';
    if (!stats.byPlan[planKey]) stats.byPlan[planKey] = { count: 0, revenue: 0 };
    if (order.status !== 'refunded') {
      stats.byPlan[planKey].count++;
      stats.byPlan[planKey].revenue += amount;
    }

    if (order.status === 'refunded') {
      stats.refunds++;
      stats.refundRevenue += amount;
    }
  }

  const refundRate = stats.total > 0 ? ((stats.refunds / stats.total) * 100).toFixed(1) : '0.0';

  const planRows = Object.entries(stats.byPlan).map(([plan, d]) =>
    `<tr><td style="padding:10px;border-bottom:1px solid #eee">${plan}</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:center">${d.count}</td><td style="padding:10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${d.revenue.toFixed(2)}€</td></tr>`
  ).join('');

  const html = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:650px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <div style="background:linear-gradient(135deg,#1565C0,#1e40af);padding:32px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:22px">📊 Rapport mensuel Kareer</h1>
        <p style="color:#bfdbfe;margin:8px 0 0;font-size:15px">${monthLabel} ${reportYear}</p>
      </div>
      <div style="padding:32px">
        <h2 style="color:#1e293b;font-size:16px;margin:0 0 16px">Résumé du mois</h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <tr style="background:#f8fafc">
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;color:#475569">Commandes totales</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-size:20px;font-weight:800;color:#1e293b">${stats.total}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;color:#475569">Revenu net</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-size:20px;font-weight:800;color:#10b981">${stats.revenue.toFixed(2)}€</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;color:#475569">En attente</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">${stats.byStatus.pending || 0}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;color:#475569">En activation</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0">${stats.byStatus.activating || 0}</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;color:#475569">Terminées</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;color:#10b981;font-weight:700">${stats.byStatus.done || 0}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;color:#475569">Remboursements</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;color:#ef4444">${stats.refunds} (${stats.refundRevenue.toFixed(2)}€)</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:12px 16px;border:1px solid #e2e8f0;font-weight:600;color:#475569">Taux de remboursement</td>
            <td style="padding:12px 16px;border:1px solid #e2e8f0;color:${parseFloat(refundRate) > 10 ? '#ef4444' : '#64748b'}">${refundRate}%</td>
          </tr>
        </table>

        <h2 style="color:#1e293b;font-size:16px;margin:0 0 12px">Répartition par plan</h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <thead>
            <tr style="background:#f1f5f9">
              <th style="padding:10px;text-align:left;border-bottom:2px solid #e2e8f0;color:#475569;font-size:13px">Plan</th>
              <th style="padding:10px;text-align:center;border-bottom:2px solid #e2e8f0;color:#475569;font-size:13px">Commandes</th>
              <th style="padding:10px;text-align:right;border-bottom:2px solid #e2e8f0;color:#475569;font-size:13px">Revenu</th>
            </tr>
          </thead>
          <tbody>${planRows || '<tr><td colspan="3" style="padding:10px;text-align:center;color:#94a3b8">Aucune donnée</td></tr>'}</tbody>
        </table>
      </div>
      <div style="background:#f8fafc;padding:20px;text-align:center;font-size:13px;color:#94a3b8">
        Rapport automatique Kareer · ${monthLabel} ${reportYear}
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: adminEmail,
      subject: `Rapport mensuel Kareer — ${monthLabel} ${reportYear}`,
      html
    });
    return { sent: true, stats };
  } catch (e) {
    console.error('Monthly report email error:', e.message);
    return { sent: false, error: e.message, stats };
  }
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
                <img src="${siteUrl}/kareer-logo.png" alt="Kareer" style="width:48px;height:48px;margin-bottom:16px">
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
