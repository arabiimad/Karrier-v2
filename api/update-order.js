require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');

const VALID_STATUSES = ['pending', 'activating', 'done', 'refunded'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { session_id, status, note } = req.body;

    if (!session_id || !status) {
      return res.status(400).json({ error: 'Missing session_id or status' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(', ')}` });
    }

    const data = await kvStore.get(`order:${session_id}`);
    if (!data) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = typeof data === 'string' ? JSON.parse(data) : data;
    const previousStatus = order.status;
    order.status = status;
    order.updatedAt = new Date().toISOString();

    if (note) {
      if (!order.notes) order.notes = [];
      order.notes.push({ text: note, date: new Date().toISOString(), by: 'admin' });
    }

    await kvStore.set(`order:${session_id}`, JSON.stringify(order));

    await logAction(kvStore, {
      action: 'status_change',
      sessionId: session_id,
      from: previousStatus,
      to: status,
      timestamp: new Date().toISOString()
    });

    if (previousStatus !== status) {
      await sendStatusEmail(order, previousStatus, status);
    }

    res.status(200).json({ success: true, order });

  } catch (error) {
    console.error('Update order error:', error.message);
    res.status(500).json({ error: 'Failed to update order' });
  }
};

async function sendStatusEmail(order, fromStatus, toStatus) {
  if (!process.env.RESEND_API_KEY || !order.customerEmail) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const lang = order.language || 'fr';
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';

    const messages = {
      fr: {
        activating: { subject: 'Votre compte est en cours d\'activation', title: 'Activation en cours !', body: 'Nous avons bien reçu vos informations et votre compte LinkedIn Premium est en cours d\'activation. Vous recevrez une confirmation dès que ce sera terminé.' },
        done: { subject: 'Votre compte LinkedIn Premium est activé !', title: 'C\'est fait !', body: 'Votre compte LinkedIn Premium a été activé avec succès. Vous pouvez dès maintenant profiter de toutes les fonctionnalités Premium sur LinkedIn.' },
        refunded: { subject: 'Votre remboursement a été effectué', title: 'Remboursement confirmé', body: 'Votre commande a été remboursée. Le montant sera crédité sur votre compte dans 5-10 jours ouvrés.' },
        pending: { subject: 'Mise à jour de votre commande', title: 'Commande en attente', body: 'Votre commande est en attente de traitement. Nous reviendrons vers vous rapidement.' }
      },
      en: {
        activating: { subject: 'Your account is being activated', title: 'Activation in progress!', body: 'We have received your information and your LinkedIn Premium account is being activated. You will receive a confirmation once it\'s done.' },
        done: { subject: 'Your LinkedIn Premium account is activated!', title: 'All done!', body: 'Your LinkedIn Premium account has been successfully activated. You can now enjoy all Premium features on LinkedIn.' },
        refunded: { subject: 'Your refund has been processed', title: 'Refund confirmed', body: 'Your order has been refunded. The amount will be credited to your account within 5-10 business days.' },
        pending: { subject: 'Order update', title: 'Order pending', body: 'Your order is pending processing. We will get back to you shortly.' }
      }
    };

    const t = (messages[lang] || messages.fr)[toStatus];
    if (!t) return;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject: t.subject,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
          <div style="background:#1565C0;padding:32px;text-align:center">
            <img src="${siteUrl}/karrier-logo.png" alt="Karrier" style="width:48px;height:48px;margin-bottom:12px">
            <h1 style="color:#ffffff;margin:0;font-size:22px">${t.title}</h1>
          </div>
          <div style="padding:32px">
            <p style="color:#333;font-size:16px;line-height:1.6">${t.body}</p>
            <table style="width:100%;border-collapse:collapse;margin:24px 0">
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Plan</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.plan} (${order.audience})</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">${lang === 'fr' ? 'Montant' : 'Amount'}</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.amount}€</td></tr>
            </table>
            <div style="text-align:center;margin-top:24px">
              <a href="${siteUrl}/suivi?id=${order.sessionId}" style="background:#1565C0;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">${lang === 'fr' ? 'Suivre ma commande' : 'Track my order'}</a>
            </div>
          </div>
          <div style="background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#999">
            Karrier — LinkedIn Premium ${lang === 'fr' ? 'à prix réduit' : 'at reduced price'}
          </div>
        </div>
      `
    });
  } catch (error) {
    console.error('Status email error:', error.message);
  }
}

async function logAction(kv, entry) {
  try {
    const logData = await kv.get('audit:log');
    const logs = logData ? (typeof logData === 'string' ? JSON.parse(logData) : logData) : [];
    logs.unshift(entry);
    if (logs.length > 500) logs.length = 500;
    await kv.set('audit:log', JSON.stringify(logs));
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}
