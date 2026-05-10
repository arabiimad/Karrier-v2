require('./_env');
const { Resend } = require('resend');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const { generateToken, hashToken } = require('./_credentials');

const LINK_TTL_MS = 72 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

    const data = await kvStore.get(`order:${session_id}`);
    if (!data) return res.status(404).json({ error: 'Order not found' });

    const order = typeof data === 'string' ? JSON.parse(data) : data;
    if (order.status === 'done' || order.status === 'refunded') {
      return res.status(400).json({ error: 'Cannot request credentials for this status' });
    }
    if (order.hasCredentials || (order.credentials && order.credentials.linkedinPassword)) {
      return res.status(400).json({ error: 'Credentials already received' });
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';
    const link = `${siteUrl.replace(/\/$/, '')}/credentials.html?token=${encodeURIComponent(token)}`;

    if (order.credentialLink && order.credentialLink.tokenHash) {
      await kvStore.del(`credential-token:${order.credentialLink.tokenHash}`);
    }

    order.status = 'awaiting_credentials';
    order.credentialLink = {
      tokenHash,
      sentAt: now,
      expiresAt,
      usedAt: null
    };
    order.credentialLinkSentAt = now;
    order.updatedAt = now;

    await kvStore.set(`credential-token:${tokenHash}`, session_id);
    await kvStore.set(`order:${session_id}`, JSON.stringify(order));
    await logAction({
      action: 'credential_link_created',
      sessionId: session_id,
      timestamp: now
    });

    const emailSent = await sendCredentialLinkEmail(order, link, expiresAt);

    res.status(200).json({
      success: true,
      link,
      expiresAt,
      emailSent
    });
  } catch (error) {
    console.error('Credential link error:', error.message);
    res.status(500).json({ error: 'Failed to create credential link' });
  }
};

async function sendCredentialLinkEmail(order, link, expiresAt) {
  if (!process.env.RESEND_API_KEY || !order.customerEmail) return false;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const lang = order.language || 'fr';
    const isFr = lang === 'fr';
    const subject = isFr
      ? 'Lien securise pour votre activation Kareer'
      : 'Secure link for your Kareer activation';

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
          <div style="background:#1565C0;padding:28px;text-align:center">
            <img src="${process.env.SITE_URL || 'https://kareer.pro'}/kareer-logo.png" alt="Kareer" style="width:48px;height:48px;margin-bottom:10px">
            <h1 style="margin:0;color:#fff;font-size:22px">${isFr ? 'Paiement valide' : 'Payment confirmed'}</h1>
          </div>
          <div style="padding:28px;color:#1f2937">
            <p>${isFr ? 'Votre paiement a ete valide. Pour demarrer l activation, transmettez votre mot de passe LinkedIn via le lien securise ci-dessous.' : 'Your payment has been confirmed. To start activation, submit your LinkedIn password through the secure link below.'}</p>
            <p style="font-size:14px;color:#64748b">${isFr ? 'Le lien expire le' : 'The link expires on'} ${new Date(expiresAt).toLocaleString('fr-FR')}.</p>
            <div style="text-align:center;margin:26px 0">
              <a href="${link}" style="background:#1565C0;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;display:inline-block">${isFr ? 'Transmettre mes identifiants' : 'Submit my credentials'}</a>
            </div>
            <p style="font-size:13px;color:#64748b">${isFr ? 'Votre mot de passe est chiffre cote serveur, accessible uniquement a l equipe d activation, puis supprime apres activation.' : 'Your password is encrypted server-side, available only to the activation team, then deleted after activation.'}</p>
          </div>
        </div>
      `
    });

    return true;
  } catch (error) {
    console.error('Credential email error:', error.message);
    return false;
  }
}

async function logAction(entry) {
  try {
    const logData = await kvStore.get('audit:log');
    const logs = logData ? (typeof logData === 'string' ? JSON.parse(logData) : logData) : [];
    logs.unshift(entry);
    if (logs.length > 500) logs.length = 500;
    await kvStore.set('audit:log', JSON.stringify(logs));
  } catch (e) {
    console.error('Credential audit error:', e.message);
  }
}
