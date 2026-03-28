require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const { formatPlan, getSiteUrl, buildEmailHtml } = require('./_email');

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
    const siteUrl = getSiteUrl();
    const planLabel = formatPlan(order.plan, order.audience, lang);
    const isFr = lang === 'fr';

    const configs = {
      fr: {
        activating: {
          subject: 'Activation de votre compte LinkedIn Premium en cours',
          preheader: 'Notre équipe travaille sur votre compte. Délai estimé : sous 24h.',
          title: 'Activation en cours !',
          headerColor: '#1565C0',
          body: 'Bonne nouvelle ! Notre équipe a commencé l\'activation de votre compte LinkedIn Premium. Vous recevrez une confirmation dès que ce sera terminé.',
          badge: '⚡ En cours d\'activation',
          badgeBg: '#eff6ff', badgeColor: '#1e40af'
        },
        done: {
          subject: 'Votre accès LinkedIn Premium est prêt',
          preheader: 'Votre compte LinkedIn Premium est maintenant actif. Connectez-vous !',
          title: 'C\'est activé ! 🎉',
          headerColor: '#059669',
          body: 'Votre compte LinkedIn Premium a été activé avec succès. Vous pouvez dès maintenant vous connecter à LinkedIn et profiter de toutes les fonctionnalités Premium.',
          badge: '✅ Compte activé',
          badgeBg: '#ecfdf5', badgeColor: '#065f46'
        },
        refunded: {
          subject: 'Remboursement confirmé — Kareer',
          preheader: 'Votre remboursement a été traité. Le crédit arrive sous 5-10 jours.',
          title: 'Remboursement confirmé',
          headerColor: '#6b7280',
          body: 'Votre commande a été remboursée intégralement. Le montant sera crédité sur votre compte bancaire dans un délai de 5 à 10 jours ouvrés.',
          badge: '💸 Remboursé',
          badgeBg: '#f9fafb', badgeColor: '#374151'
        },
        pending: {
          subject: 'Mise à jour de votre commande — Kareer',
          preheader: 'Votre commande est en cours de traitement.',
          title: 'Commande en attente',
          headerColor: '#d97706',
          body: 'Votre commande est en cours de traitement. Notre équipe revient vers vous très rapidement.',
          badge: '⏳ En attente',
          badgeBg: '#fffbeb', badgeColor: '#92400e'
        }
      },
      en: {
        activating: {
          subject: 'Your LinkedIn Premium account is being activated',
          preheader: 'Our team is working on your account. Estimated time: within 24h.',
          title: 'Activation in progress!',
          headerColor: '#1565C0',
          body: 'Good news! Our team has started activating your LinkedIn Premium account. You will receive a confirmation once it\'s done.',
          badge: '⚡ Activating',
          badgeBg: '#eff6ff', badgeColor: '#1e40af'
        },
        done: {
          subject: 'Your LinkedIn Premium access is ready',
          preheader: 'Your LinkedIn Premium account is now active. Log in!',
          title: 'It\'s activated! 🎉',
          headerColor: '#059669',
          body: 'Your LinkedIn Premium account has been successfully activated. You can now log in to LinkedIn and enjoy all Premium features.',
          badge: '✅ Account activated',
          badgeBg: '#ecfdf5', badgeColor: '#065f46'
        },
        refunded: {
          subject: 'Refund confirmed — Kareer',
          preheader: 'Your refund has been processed. Credit arrives in 5-10 days.',
          title: 'Refund confirmed',
          headerColor: '#6b7280',
          body: 'Your order has been fully refunded. The amount will be credited to your bank account within 5-10 business days.',
          badge: '💸 Refunded',
          badgeBg: '#f9fafb', badgeColor: '#374151'
        },
        pending: {
          subject: 'Order update — Kareer',
          preheader: 'Your order is being processed.',
          title: 'Order pending',
          headerColor: '#d97706',
          body: 'Your order is being processed. Our team will get back to you very soon.',
          badge: '⏳ Pending',
          badgeBg: '#fffbeb', badgeColor: '#92400e'
        }
      }
    };

    const t = (configs[lang] || configs.fr)[toStatus];
    if (!t) return;

    const trackLabel = isFr ? 'Suivre ma commande →' : 'Track my order →';
    const amountLabel = isFr ? 'Montant' : 'Amount';
    const planLbl = isFr ? 'Plan' : 'Plan';
    const contactLine = isFr
      ? 'Une question ? Répondez à cet email ou écrivez à contact@kareer.pro'
      : 'Questions? Reply to this email or write to contact@kareer.pro';
    const footer = isFr
      ? 'Vous recevez cet email car vous avez passé une commande sur kareer.pro.'
      : 'You received this email because you placed an order on kareer.pro.';

    const plainText = [
      t.title, '',
      t.body, '',
      `${planLbl}: ${planLabel}`,
      `${amountLabel}: ${order.amount}€`, '',
      `${trackLabel} ${siteUrl}/suivi?id=${order.sessionId}`, '',
      contactLine
    ].join('\n');

    const content = `
      <p style="margin:0 0 20px;color:#374151;font-size:16px;line-height:1.7">${t.body}</p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.badgeBg};border-radius:8px;margin:0 0 24px">
        <tr><td style="padding:14px 20px;text-align:center">
          <span style="color:${t.badgeColor};font-size:15px;font-weight:700">${t.badge}</span>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin:0 0 24px">
        <tr style="background:#f9fafb">
          <td style="padding:12px 16px;color:#6b7280;font-size:14px;font-weight:600;width:45%;border-bottom:1px solid #e5e7eb">${planLbl}</td>
          <td style="padding:12px 16px;color:#111827;font-size:14px;font-weight:700;border-bottom:1px solid #e5e7eb">${planLabel}</td>
        </tr>
        <tr>
          <td style="padding:12px 16px;color:#6b7280;font-size:14px;font-weight:600">${amountLabel}</td>
          <td style="padding:12px 16px;color:#111827;font-size:14px;font-weight:700">${order.amount}€</td>
        </tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">
        <tr><td align="center">
          <a href="${siteUrl}/suivi?id=${order.sessionId}" style="display:inline-block;background:${t.headerColor};color:#ffffff;font-size:15px;font-weight:600;padding:14px 36px;border-radius:8px;text-decoration:none">${trackLabel}</a>
        </td></tr>
      </table>
      <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6">${contactLine}</p>
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      reply_to: 'contact@kareer.pro',
      to: order.customerEmail,
      subject: t.subject,
      text: plainText,
      headers: {
        'List-Unsubscribe': '<mailto:contact@kareer.pro?subject=unsubscribe>',
        'X-Entity-Ref-ID': order.sessionId || ''
      },
      html: buildEmailHtml({
        siteUrl,
        headerColor: t.headerColor,
        title: t.title,
        preheader: t.preheader,
        content,
        footer
      })
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
