require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const {
  adminEmail,
  formatCurrency,
  formatOrderPlan,
  getSiteUrl,
  renderEmail,
  sendEmail
} = require('./_email');
const customerEmails = require('./_customer-emails');
const { ensureReference, issueCredentialLink } = require('./_orders');
const { countsAsRevenue, isPaymentDue } = require('./_payment');
const checkRate = rateLimit({ windowMs: 60000, max: 10 });

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Allow Vercel cron (GET with ?action=...) or admin POST
  const isCron = req.method === 'GET' && ['daily_reminders', 'renewal_reminders', 'payment_reminders', 'monthly_report', 'process_pending', 'cleanup_credentials'].includes(req.query.action);

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
      case 'send_legacy_customer_offer':
        result = await sendLegacyCustomerOffer(req.body.email, req.body.firstName || req.body.first_name || req.body.prenom);
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
      case 'payment_reminders':
        result = await sendPaymentReminders();
        break;
      case 'daily_reminders':
        result = {
          payments: await sendPaymentReminders(),
          renewals: await sendRenewalReminders(30)
        };
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
    res.status(error.statusCode || 500).json({ error: error.message || 'Automation failed' });
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

// Manual reminder from the dashboard. The content follows the step the order is stuck at.
async function sendReminder(sessionId) {
  if (!sessionId) {
    throw new Error('session_id required');
  }

  const data = await kvStore.get(`order:${sessionId}`);
  if (!data) {
    throw new Error('Order not found');
  }
  const order = typeof data === 'string' ? JSON.parse(data) : data;
  if (!order.reference) {
    await ensureReference(order);
    await kvStore.set(`order:${sessionId}`, JSON.stringify(order));
  }

  // Waiting for the password: the old link cannot be shown again, so send a fresh one.
  if (order.status === 'awaiting_credentials' && !order.hasCredentials) {
    const { link, expiresAt } = await issueCredentialLink(order);
    const mail = await sendEmail({ to: order.customerEmail, ...customerEmails.credentialLink(order, link, expiresAt) });
    return { sent: mail.sent, kind: 'new_link', email: order.customerEmail };
  }

  const reminder = customerEmails.reminder(order);
  if (!reminder) {
    return { sent: false, reason: 'Rien à relancer pour ce statut', email: order.customerEmail };
  }
  const mail = await sendEmail({ to: order.customerEmail, ...reminder });
  if (mail.sent) {
    order.reminders = (order.reminders || []).concat([{ at: new Date().toISOString(), status: order.status, by: 'admin' }]);
    order.updatedAt = new Date().toISOString();
    await kvStore.set(`order:${sessionId}`, JSON.stringify(order));
  }
  return { sent: mail.sent, kind: order.status === 'done' ? 'payment' : 'order', email: order.customerEmail };
}

// Automatic payment reminders: 24 h after activation, then once more 3 days later.
const PAYMENT_REMINDER_STEPS_H = [24, 96];

async function sendPaymentReminders() {
  const orders = await kvStore.getAllOrders(isPaymentDue);
  let sent = 0;
  const results = [];
  for (const order of orders) {
    const activatedAt = Date.parse(order.activatedAt || order.updatedAt || order.createdAt);
    if (!activatedAt) continue;
    const autoCount = (order.reminders || []).filter(r => r.by === 'auto' && r.status === 'done').length;
    const step = PAYMENT_REMINDER_STEPS_H[autoCount];
    if (step === undefined) continue;
    if (Date.now() - activatedAt < step * 3600000) continue;

    const mail = await sendEmail({ to: order.customerEmail, ...customerEmails.reminder(order) });
    if (!mail.sent) {
      results.push({ id: order.sessionId, error: mail.error || mail.reason });
      continue;
    }
    order.reminders = (order.reminders || []).concat([{ at: new Date().toISOString(), status: 'done', by: 'auto' }]);
    order.updatedAt = new Date().toISOString();
    await kvStore.set(`order:${order.sessionId}`, JSON.stringify(order));
    sent++;
    results.push({ id: order.sessionId, reminder: autoCount + 1 });
  }
  return { sent, results };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

async function ensureLegacyCustomerPromoCode() {
  const code = 'ANCIENCLIENT10';
  const key = `promo:${code}`;
  const existingData = await kvStore.get(key);
  const existing = existingData ? (typeof existingData === 'string' ? JSON.parse(existingData) : existingData) : {};
  const now = new Date().toISOString();
  const promo = {
    ...existing,
    type: 'fixed',
    value: 10,
    description: 'Offre anciens clients Kareer - 10 euros sur tous les abonnements Premium',
    maxUses: null,
    expiresAt: existing.expiresAt || null,
    minAmount: 0,
    applicablePlans: 'all',
    active: true,
    usedCount: existing.usedCount || 0,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    usageHistory: existing.usageHistory || []
  };
  await kvStore.set(key, JSON.stringify(promo));
  return { code, created: !existingData };
}

async function sendLegacyCustomerOffer(email, firstName) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedFirstName = String(firstName || '').trim().replace(/\s+/g, ' ').slice(0, 80);

  if (!isValidEmail(normalizedEmail)) {
    const error = new Error('Adresse email invalide');
    error.statusCode = 400;
    throw error;
  }
  if (!normalizedFirstName) {
    const error = new Error('Prénom requis');
    error.statusCode = 400;
    throw error;
  }

  const promo = await ensureLegacyCustomerPromoCode();

  const offerUrl = `${getSiteUrl()}/#tarifs`;
  const subject = `${normalizedFirstName}, 10 € pour reprendre LinkedIn Premium`;
  const offer = renderEmail({
    lang: 'fr',
    title: `Bonjour ${normalizedFirstName},`,
    preheader: '10 € de réduction sur tous les abonnements Premium avec le code ANCIENCLIENT10.',
    footer: 'Vous recevez cet e-mail car vous avez déjà été client Kareer.',
    blocks: [
      { type: 'p', text: 'Vous avez utilisé LinkedIn Premium avec nous l\'an dernier, et nous espérons qu\'il vous a été utile.' },
      { type: 'p', text: 'Depuis, la commande a changé : vous commandez sur kareer.pro, nous activons Premium 5 à 30 minutes après réception de vos identifiants, et vous ne payez qu\'une fois Premium actif.' },
      { type: 'code', label: 'Votre code anciens clients', code: promo.code, caption: '10 € de moins sur n\'importe quel abonnement Premium.' },
      { type: 'button', label: 'Voir les abonnements', href: offerUrl }
    ]
  });

  const mail = await sendEmail({ to: normalizedEmail, subject, html: offer.html, text: offer.text });
  if (!mail.sent) {
    const error = new Error(mail.error || 'Envoi impossible');
    error.statusCode = 502;
    throw error;
  }

  const logData = await kvStore.get('legacy-customer-offer:log');
  const logs = logData ? (typeof logData === 'string' ? JSON.parse(logData) : logData) : [];
  logs.unshift({ email: normalizedEmail, firstName: normalizedFirstName, promoCode: promo.code, sentAt: new Date().toISOString() });
  if (logs.length > 500) logs.length = 500;
  await kvStore.set('legacy-customer-offer:log', JSON.stringify(logs));

  return { sent: true, email: normalizedEmail, firstName: normalizedFirstName, promoCode: promo.code, promoCreated: promo.created };
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
  const now = new Date();
  const month = now.getMonth(); // report covers the previous month
  const reportMonth = month === 0 ? 11 : month - 1;
  const reportYear = month === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const monthNames = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const label = `${monthNames[reportMonth]} ${reportYear}`;
  const start = new Date(reportYear, reportMonth, 1).getTime();
  const end = new Date(reportYear, reportMonth + 1, 0, 23, 59, 59, 999).getTime();

  const orders = await kvStore.getAllOrders(order => {
    const createdAt = Date.parse(order.createdAt);
    return createdAt >= start && createdAt <= end;
  });

  const stats = { total: orders.length, revenue: 0, due: 0, dueCount: 0, done: 0, refunds: 0, refunded: 0, byPlan: {} };
  for (const order of orders) {
    const amount = Number(order.amount) || 0;
    const plan = formatOrderPlan(order, 'fr');
    stats.byPlan[plan] = stats.byPlan[plan] || { count: 0, revenue: 0 };
    stats.byPlan[plan].count++;
    if (countsAsRevenue(order)) {
      stats.revenue += amount;
      stats.byPlan[plan].revenue += amount;
    }
    if (isPaymentDue(order)) { stats.due += amount; stats.dueCount++; }
    if (order.status === 'done') stats.done++;
    if (order.status === 'refunded') { stats.refunds++; stats.refunded += amount; }
  }

  const euro = value => formatCurrency(value, 'EUR', 'fr');
  const planRows = Object.entries(stats.byPlan)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([plan, d]) => ({ label: `${plan} (${d.count})`, value: euro(d.revenue) }));

  const report = renderEmail({
    lang: 'fr',
    title: `Rapport de ${label}`,
    preheader: `${stats.total} commandes, ${euro(stats.revenue)} encaissés.`,
    signature: false,
    footer: 'Rapport automatique envoyé le 1er de chaque mois.',
    blocks: [
      { type: 'p', text: `Commandes passées en ${label}. Le chiffre encaissé ne compte que les commandes marquées payées.` },
      { type: 'details', rows: [
        { label: 'Commandes', value: stats.total },
        { label: 'Activées', value: stats.done },
        { label: 'Encaissé', value: euro(stats.revenue) },
        { label: 'Encore à encaisser', value: `${euro(stats.due)} (${stats.dueCount})` },
        { label: 'Remboursées ou annulées', value: `${stats.refunds} (${euro(stats.refunded)})` }
      ] },
      planRows.length ? { type: 'p', text: 'Par offre (nombre de commandes) :' } : null,
      planRows.length ? { type: 'details', rows: planRows } : null,
      { type: 'button', label: 'Ouvrir le tableau de bord', href: `${getSiteUrl()}/admin` }
    ]
  });

  const mail = await sendEmail({ to: adminEmail(), subject: `Rapport Kareer, ${label}`, html: report.html, text: report.text });
  return { sent: mail.sent, error: mail.error, stats };
}

// About 30 days before the 12 months end. Uses the activation date, not the order date.
async function sendRenewalReminders(daysBefore) {
  const windowMs = daysBefore * 24 * 60 * 60 * 1000;
  const graceMs = 7 * 24 * 60 * 60 * 1000;
  const orders = await kvStore.getAllOrders(order => order.status === 'done' && order.customerEmail && !order.renewalReminderSent);

  let sent = 0;
  const results = [];
  for (const order of orders) {
    const base = order.activatedAt || order.createdAt;
    const expiresAt = order.expiresAt ? Date.parse(order.expiresAt) : Date.parse(base) + 365 * 24 * 60 * 60 * 1000;
    if (!expiresAt) continue;
    const left = expiresAt - Date.now();
    if (left > windowMs || left < -graceMs) continue;

    const mail = await sendEmail({
      to: order.customerEmail,
      ...customerEmails.renewal({ ...order, expiresAt: new Date(expiresAt).toISOString() })
    });
    if (!mail.sent) {
      results.push({ id: order.sessionId, error: mail.error || mail.reason });
      continue;
    }
    order.renewalReminderSent = new Date().toISOString();
    order.updatedAt = order.renewalReminderSent;
    await kvStore.set(`order:${order.sessionId}`, JSON.stringify(order));
    sent++;
    results.push({ id: order.sessionId, email: order.customerEmail });
  }
  return { sent, results };
}
