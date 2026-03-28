require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const { formatPlan, getSiteUrl } = require('./_email');
const checkRate = rateLimit({ windowMs: 60000, max: 10 });

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vercel Cron support: GET request with CRON_SECRET
  const isCron = req.method === 'GET'
    && process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;

  if (isCron) {
    try {
      const result = await processPendingOrders();
      return res.status(200).json({ success: true, result });
    } catch (error) {
      console.error('Cron error:', error.message);
      return res.status(500).json({ error: 'Cron failed' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rate = checkRate(req);
  if (!rate.allowed) {
    return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter: rate.retryAfter });
  }

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { action, session_id } = req.body;

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
      case 'create_promo':
        result = await createPromo(req.body);
        break;
      case 'list_promos':
        result = await listPromos();
        break;
      case 'delete_promo':
        result = await deletePromo(req.body.code);
        break;
      case 'toggle_promo':
        result = await togglePromo(req.body.code);
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
        await sendActivationEmail(order);
        processed++;
        results.push({ id, action: 'moved_to_activating', emailSent: !!order.customerEmail });
      }
    }
  }

  return { processed, results };
}

async function sendActivationEmail(order) {
  if (!process.env.RESEND_API_KEY || !order.customerEmail) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const lang = order.language || 'fr';
    const siteUrl = getSiteUrl();
    const planLabel = formatPlan(order.plan, order.audience, lang);

    const t = lang === 'fr' ? {
      subject: 'Votre compte est en cours d\'activation — Kareer',
      title: 'Activation en cours !',
      body: 'Nous avons bien reçu vos informations et votre compte LinkedIn Premium est en cours d\'activation. Vous recevrez une confirmation dès que ce sera terminé.',
      delay: 'Délai estimé : sous 24h',
      track: 'Suivre ma commande'
    } : {
      subject: 'Your account is being activated — Kareer',
      title: 'Activation in progress!',
      body: 'We have received your information and your LinkedIn Premium account is being activated. You will receive a confirmation once it\'s done.',
      delay: 'Estimated time: within 24h',
      track: 'Track my order'
    };

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      reply_to: 'contact@kareer.pro',
      to: order.customerEmail,
      subject: t.subject,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#1565C0,#42A5F5);padding:40px 32px;text-align:center">
            <img src="${siteUrl}/karrier-logo.png" alt="Kareer" style="width:48px;height:48px;margin-bottom:16px;border-radius:8px">
            <h1 style="color:#fff;margin:0;font-size:24px">${t.title}</h1>
          </div>
          <div style="padding:32px">
            <p style="color:#333;font-size:16px;line-height:1.6">${t.body}</p>
            <table style="width:100%;border-collapse:collapse;margin:24px 0">
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Plan</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${planLabel}</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">${lang === 'fr' ? 'Montant' : 'Amount'}</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.amount}€</td></tr>
            </table>
            <div style="background:#f0f7ff;border-radius:10px;padding:16px;margin:24px 0;text-align:center">
              <p style="color:#1565C0;font-weight:600;margin:0">⏱️ ${t.delay}</p>
            </div>
            <div style="text-align:center;margin-top:24px">
              <a href="${siteUrl}/suivi?id=${order.sessionId}" style="background:#1565C0;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">${t.track}</a>
            </div>
          </div>
          <div style="background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#999">
            Kareer — LinkedIn Premium ${lang === 'fr' ? 'à prix réduit' : 'at reduced price'} · <a href="mailto:contact@kareer.pro" style="color:#1565C0;text-decoration:none">contact@kareer.pro</a>
          </div>
        </div>
      `
    });
  } catch (error) {
    console.error('Activation email error:', error.message);
  }
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

    const siteUrl = process.env.SITE_URL || 'https://www.kareer.pro';

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      reply_to: 'contact@kareer.pro',
      to: order.customerEmail,
      subject: lang === 'fr' ? 'Mise à jour de votre commande Kareer' : 'Kareer Order Update',
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#1565C0,#42A5F5);padding:32px;text-align:center">
            <img src="${siteUrl}/karrier-logo.png" alt="Kareer" style="width:48px;height:48px;margin-bottom:12px;border-radius:8px">
            <h1 style="color:#fff;margin:0;font-size:22px">${lang === 'fr' ? 'Mise à jour de votre commande' : 'Order Update'}</h1>
          </div>
          <div style="padding:32px">
            <table style="width:100%;border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">${lang === 'fr' ? 'Statut' : 'Status'}</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${messages[order.status]}</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Plan</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.plan} (${order.audience})</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">${lang === 'fr' ? 'Montant' : 'Amount'}</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.amount}€</td></tr>
            </table>
            <div style="text-align:center;margin-top:24px">
              <a href="${siteUrl}/suivi?id=${sessionId}" style="background:#1565C0;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">
                ${lang === 'fr' ? 'Suivre ma commande' : 'Track my order'}
              </a>
            </div>
          </div>
          <div style="background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#999">
            Kareer — LinkedIn Premium ${lang === 'fr' ? 'à prix réduit' : 'at reduced price'} · <a href="mailto:contact@kareer.pro" style="color:#1565C0;text-decoration:none">contact@kareer.pro</a>
          </div>
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

// ===== Promo Code Management =====

async function createPromo(data) {
  const code = (data.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code || !data.discount) throw new Error('Code et remise requis');
  const existing = await kvStore.get(`promo:${code}`);
  if (existing) throw new Error('Ce code existe déjà');
  const promo = {
    code,
    discount: parseInt(data.discount),
    type: 'fixed',
    maxUses: parseInt(data.maxUses) || 0,
    usedCount: 0,
    active: true,
    description: data.description || '',
    createdAt: new Date().toISOString(),
    expiresAt: data.expiresAt || null
  };
  await kvStore.set(`promo:${code}`, JSON.stringify(promo));
  const idx = await kvStore.get('promos:index');
  const codes = idx ? (typeof idx === 'string' ? JSON.parse(idx) : idx) : [];
  if (!codes.includes(code)) {
    codes.unshift(code);
    await kvStore.set('promos:index', JSON.stringify(codes));
  }
  return promo;
}

async function listPromos() {
  const idx = await kvStore.get('promos:index');
  const codes = idx ? (typeof idx === 'string' ? JSON.parse(idx) : idx) : [];
  const promos = [];
  for (const c of codes) {
    const d = await kvStore.get(`promo:${c}`);
    if (d) promos.push(typeof d === 'string' ? JSON.parse(d) : d);
  }
  return promos;
}

async function deletePromo(code) {
  const normalizedCode = (code || '').trim().toUpperCase();
  const k = `promo:${normalizedCode}`;
  if (typeof kvStore.del === 'function') {
    await kvStore.del(k);
  } else {
    await kvStore.set(k, null);
  }
  const idx = await kvStore.get('promos:index');
  const codes = idx ? (typeof idx === 'string' ? JSON.parse(idx) : idx) : [];
  const filtered = codes.filter(c => c !== normalizedCode);
  await kvStore.set('promos:index', JSON.stringify(filtered));
  return { deleted: normalizedCode };
}

async function togglePromo(code) {
  const normalizedCode = (code || '').trim().toUpperCase();
  const k = `promo:${normalizedCode}`;
  const d = await kvStore.get(k);
  if (!d) throw new Error('Code introuvable');
  const promo = typeof d === 'string' ? JSON.parse(d) : d;
  promo.active = !promo.active;
  await kvStore.set(k, JSON.stringify(promo));
  return promo;
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
