require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const rateLimit = require('./_rate-limit');
const checkRate = rateLimit({ windowMs: 60000, max: 10 });

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
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
      from: 'Karrier <notifications@karrier.pro>',
      to: order.customerEmail,
      subject: lang === 'fr' ? 'Mise à jour de votre commande Karrier' : 'Karrier Order Update',
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <img src="https://karrier.pro/karrier-logo.png" alt="Karrier" style="width:60px;margin-bottom:20px">
          <h2>${lang === 'fr' ? 'Mise à jour de votre commande' : 'Order Update'}</h2>
          <p><strong>${lang === 'fr' ? 'Statut' : 'Status'}:</strong> ${messages[order.status]}</p>
          <p><strong>${lang === 'fr' ? 'Plan' : 'Plan'}:</strong> ${order.plan} (${order.audience})</p>
          <p><strong>${lang === 'fr' ? 'Montant' : 'Amount'}:</strong> ${order.amount}€</p>
          <br>
          <a href="https://karrier.pro/api/order-status?session_id=${sessionId}" 
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
