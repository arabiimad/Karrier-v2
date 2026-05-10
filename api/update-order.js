require('./_env');
const crypto = require('crypto');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const { Resend } = require('resend');
const { generateToken, hashToken, decryptSecret } = require('./_credentials');

const VALID_STATUSES = ['pending', 'pending_payment', 'awaiting_credentials', 'activating', 'done', 'refunded'];
const LINK_TTL_MS = 72 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { action, session_id } = req.body || {};
      if (action === 'credential_link') {
        return await createCredentialLink(session_id, res);
      }
      if (action === 'reveal_credentials') {
        return await revealCredentials(session_id, res);
      }
      return res.status(400).json({ error: 'Invalid action' });
    } catch (error) {
      console.error('Order action error:', error.message);
      return res.status(500).json({ error: 'Order action failed' });
    }
  }
  
  // DELETE - Supprimer une commande
  if (req.method === 'DELETE') {
    try {
      verifyAuth(req);
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { session_id } = req.query;

      if (!session_id) {
        return res.status(400).json({ error: 'Missing session_id' });
      }

      const data = await kvStore.get(`order:${session_id}`);
      if (!data) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = typeof data === 'string' ? JSON.parse(data) : data;
      if (order.credentialLink && order.credentialLink.tokenHash) {
        await kvStore.del(`credential-token:${order.credentialLink.tokenHash}`);
      }

      await kvStore.del(`order:${session_id}`);

      const indexData = await kvStore.get('orders:index');
      if (indexData) {
        const allIds = typeof indexData === 'string' ? JSON.parse(indexData) : indexData;
        const updatedIds = allIds.filter(id => id !== session_id);
        await kvStore.set('orders:index', JSON.stringify(updatedIds));
      }

      await logAction(kvStore, {
        action: 'order_deleted',
        sessionId: session_id,
        timestamp: new Date().toISOString()
      });

      console.log(`[Order] Deleted: ${session_id}`);
      return res.status(200).json({ success: true, message: 'Order deleted successfully' });

    } catch (error) {
      console.error('Delete order error:', error.message);
      return res.status(500).json({ error: 'Failed to delete order' });
    }
  }
  
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

    // Activation: set dates and generate referral code when transitioning to 'done'
    if (status === 'done' && previousStatus !== 'done') {
      order.activatedAt = new Date().toISOString();
      order.expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      order.referralCode = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
      order.customerReferralCode = order.referralCode;

      // Store referral in KV with correct structure
      await kvStore.set('referral:' + order.referralCode, JSON.stringify({
        referrerEmail: order.customerEmail,
        referrerName: order.customerEmail ? order.customerEmail.split('@')[0] : 'Client',
        referralCount: 0,
        referrals: [],
        rewardMode: 'promo',
        pendingBalance: 0,
        transferRequests: [],
        sessionId: session_id,
        plan: order.plan,
        createdAt: new Date().toISOString()
      }));

      // Create email mapping for easy lookup
      await kvStore.set(`referral:email:${order.customerEmail.toLowerCase()}`, order.referralCode);

      // Update referrals index
      const refIndexData = await kvStore.get('referrals:index');
      const refIndex = refIndexData ? (typeof refIndexData === 'string' ? JSON.parse(refIndexData) : refIndexData) : [];
      refIndex.push(order.referralCode);
      await kvStore.set('referrals:index', JSON.stringify(refIndex));

      // Si cette commande a utilisé un code de parrainage, notifier le parrain
      if (order.referralCode && order.referralCode.startsWith('REF')) {
        try {
          const referralData = await kvStore.get(`referral:${order.referralCode}`);
          if (referralData) {
            const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;
            
            // Trouver le filleul dans la liste
            const referee = referral.referrals?.find(r => r.email === order.customerEmail.toLowerCase());
            if (referee && referee.referrerPromoCode) {
              // Envoyer l'email au parrain
              await sendReferrerEmail({
                referrerEmail: referral.referrerEmail,
                referrerName: referral.referrerName,
                referrerPromoCode: referee.referrerPromoCode,
                referrerMode: referral.rewardMode,
                referrerBalance: referral.pendingBalance,
                refereeName: referee.name || order.customerEmail.split('@')[0],
                referralCode: order.referralCode
              });
            }
          }
        } catch (err) {
          console.error('[Referral] Error sending referrer notification:', err);
        }
      }
      await rewardReferrerIfNeeded(order);
      deleteCredentials(order);
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

    res.status(200).json({ success: true, order: sanitizeOrder(order) });

  } catch (error) {
    console.error('Update order error:', error.message);
    res.status(500).json({ error: 'Failed to update order' });
  }
};

async function createCredentialLink(sessionId, res) {
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const data = await kvStore.get(`order:${sessionId}`);
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
  order.credentialLink = { tokenHash, sentAt: now, expiresAt, usedAt: null };
  order.credentialLinkSentAt = now;
  order.updatedAt = now;

  await kvStore.set(`credential-token:${tokenHash}`, sessionId);
  await kvStore.set(`order:${sessionId}`, JSON.stringify(order));
  await logAction(kvStore, { action: 'credential_link_created', sessionId, timestamp: now });

  const emailSent = await sendCredentialLinkEmail(order, link, expiresAt);
  return res.status(200).json({ success: true, link, expiresAt, emailSent });
}

async function revealCredentials(sessionId, res) {
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const data = await kvStore.get(`order:${sessionId}`);
  if (!data) return res.status(404).json({ error: 'Order not found' });

  const order = typeof data === 'string' ? JSON.parse(data) : data;
  let linkedinPassword = null;
  let source = 'encrypted';

  if (order.credentials && order.credentials.linkedinPassword) {
    linkedinPassword = decryptSecret(order.credentials.linkedinPassword);
  } else if (order.linkedinPassword) {
    linkedinPassword = order.linkedinPassword;
    source = 'legacy_plaintext';
  }

  if (!linkedinPassword) {
    return res.status(404).json({ error: 'No credentials available' });
  }

  await logAction(kvStore, {
    action: 'credentials_revealed',
    sessionId,
    source,
    timestamp: new Date().toISOString()
  });

  return res.status(200).json({
    success: true,
    linkedinEmail: order.linkedinEmail,
    linkedinPassword
  });
}

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

async function rewardReferrerIfNeeded(order) {
  if (!order.usedReferralCode || order.referrerRewardedAt || !order.customerEmail) return;

  try {
    const usedCode = String(order.usedReferralCode).toUpperCase();
    const referralData = await kvStore.get(`referral:${usedCode}`);
    if (!referralData) return;

    const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;
    const customerEmail = order.customerEmail.toLowerCase();
    if (referral.referrerEmail && referral.referrerEmail.toLowerCase() === customerEmail) return;

    referral.referrals = referral.referrals || [];
    const alreadyRecorded = referral.referrals.some(r => String(r.email || '').toLowerCase() === customerEmail);
    let referrerPromoCode = null;

    if (!alreadyRecorded) {
      if (referral.rewardMode === 'transfer') {
        referral.pendingBalance = (referral.pendingBalance || 0) + 10;
      } else {
        referrerPromoCode = 'PARRAIN' + crypto.randomBytes(4).toString('hex').toUpperCase();
        await kvStore.set(`promo:${referrerPromoCode}`, JSON.stringify({
          type: 'fixed',
          value: 10,
          description: `Recompense parrainage de ${customerEmail}`,
          maxUses: 1,
          expiresAt: null,
          minAmount: 0,
          applicablePlans: 'all',
          active: true,
          usedCount: 0,
          createdAt: new Date().toISOString(),
          usageHistory: [],
          referralCode: usedCode,
          referralType: 'referrer'
        }));
      }

      referral.referrals.push({
        email: customerEmail,
        name: customerEmail.split('@')[0],
        usedAt: new Date().toISOString(),
        orderId: order.sessionId,
        referrerPromoCode
      });
      referral.referralCount = (referral.referralCount || 0) + 1;
      referral.lastReferralAt = new Date().toISOString();
      await kvStore.set(`referral:${usedCode}`, JSON.stringify(referral));
    }

    const latestReferee = referral.referrals.find(r => String(r.email || '').toLowerCase() === customerEmail);
    if (latestReferee && latestReferee.referrerPromoCode) {
      await sendReferrerEmail({
        referrerEmail: referral.referrerEmail,
        referrerName: referral.referrerName,
        referrerPromoCode: latestReferee.referrerPromoCode,
        referrerMode: referral.rewardMode,
        referrerBalance: referral.pendingBalance,
        refereeName: latestReferee.name || customerEmail.split('@')[0],
        referralCode: usedCode
      });
    }

    order.referrerRewardedAt = new Date().toISOString();
  } catch (err) {
    console.error('[Referral] Error rewarding referrer:', err.message);
  }
}

function deleteCredentials(order) {
  if (order.credentials || order.linkedinPassword || order.hasCredentials) {
    delete order.credentials;
    delete order.linkedinPassword;
    order.hasCredentials = false;
    order.credentialsDeletedAt = new Date().toISOString();
  }
}

function sanitizeOrder(order) {
  const copy = { ...order };
  copy.hasCredentials = !!(order.credentials && order.credentials.linkedinPassword) || !!order.linkedinPassword || !!order.hasCredentials;
  delete copy.credentials;
  delete copy.linkedinPassword;
  if (copy.credentialLink) {
    copy.credentialLink = {
      sentAt: copy.credentialLink.sentAt,
      expiresAt: copy.credentialLink.expiresAt,
      usedAt: copy.credentialLink.usedAt || null
    };
  }
  return copy;
}

async function sendStatusEmail(order, fromStatus, toStatus) {
  if (!process.env.RESEND_API_KEY || !order.customerEmail) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const lang = order.language || 'fr';
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';

    const messages = {
      fr: {
        activating: { subject: 'Votre compte est en cours d\'activation', title: 'Activation en cours !', body: 'Nous avons bien reçu votre paiement et votre compte LinkedIn Premium est en cours d\'activation. Vous recevrez une confirmation dès que ce sera terminé.' },
        done: { subject: 'Votre compte LinkedIn Premium est activé !', title: 'C\'est fait !', body: 'Votre compte LinkedIn Premium a été activé avec succès. Vous pouvez dès maintenant profiter de toutes les fonctionnalités Premium sur LinkedIn.' },
        refunded: { subject: 'Votre remboursement a été effectué', title: 'Remboursement confirmé', body: 'Votre commande a été remboursée. Le montant sera crédité sur votre compte dans 5-10 jours ouvrés.' },
        pending: { subject: 'Paiement en cours de vérification', title: 'Paiement en attente', body: 'Nous avons bien reçu votre demande de paiement. Notre équipe est en train de vérifier votre paiement. Vous recevrez une confirmation dès que ce sera validé.' }
      },
      en: {
        activating: { subject: 'Your account is being activated', title: 'Activation in progress!', body: 'We have received your payment and your LinkedIn Premium account is being activated. You will receive a confirmation once it\'s done.' },
        done: { subject: 'Your LinkedIn Premium account is activated!', title: 'All done!', body: 'Your LinkedIn Premium account has been successfully activated. You can now enjoy all Premium features on LinkedIn.' },
        refunded: { subject: 'Your refund has been processed', title: 'Refund confirmed', body: 'Your order has been refunded. The amount will be credited to your account within 5-10 business days.' },
        pending: { subject: 'Payment verification in progress', title: 'Payment pending', body: 'We have received your payment request. Our team is verifying your payment. You will receive a confirmation once it\'s validated.' }
      },
      es: {
        activating: { subject: 'Tu cuenta está siendo activada', title: '¡Activación en curso!', body: 'Hemos recibido tu pago y tu cuenta LinkedIn Premium está siendo activada. Recibirás una confirmación cuando esté lista.' },
        done: { subject: '¡Tu cuenta LinkedIn Premium está activada!', title: '¡Listo!', body: 'Tu cuenta LinkedIn Premium ha sido activada con éxito. Ya puedes disfrutar de todas las funciones Premium en LinkedIn.' },
        refunded: { subject: 'Tu reembolso ha sido procesado', title: 'Reembolso confirmado', body: 'Tu pedido ha sido reembolsado. El monto será acreditado en tu cuenta en 5-10 días hábiles.' },
        pending: { subject: 'Verificación de pago en curso', title: 'Pago pendiente', body: 'Hemos recibido tu solicitud de pago. Nuestro equipo está verificando tu pago. Recibirás una confirmación una vez validado.' }
      },
      de: {
        activating: { subject: 'Ihr Konto wird aktiviert', title: 'Aktivierung läuft!', body: 'Wir haben Ihre Zahlung erhalten und Ihr LinkedIn Premium-Konto wird aktiviert. Sie erhalten eine Bestätigung, sobald es fertig ist.' },
        done: { subject: 'Ihr LinkedIn Premium-Konto ist aktiviert!', title: 'Fertig!', body: 'Ihr LinkedIn Premium-Konto wurde erfolgreich aktiviert. Sie können jetzt alle Premium-Funktionen auf LinkedIn nutzen.' },
        refunded: { subject: 'Ihre Rückerstattung wurde bearbeitet', title: 'Rückerstattung bestätigt', body: 'Ihre Bestellung wurde erstattet. Der Betrag wird innerhalb von 5-10 Werktagen auf Ihrem Konto gutgeschrieben.' },
        pending: { subject: 'Zahlungsüberprüfung läuft', title: 'Zahlung ausstehend', body: 'Wir haben Ihre Zahlungsanfrage erhalten. Unser Team überprüft Ihre Zahlung. Sie erhalten eine Bestätigung, sobald sie validiert ist.' }
      }
    };

    messages.fr.pending_payment = messages.fr.pending;
    messages.fr.awaiting_credentials = {
      subject: 'Paiement valide - identifiants demandes',
      title: 'Paiement valide',
      body: 'Votre paiement est valide. Vous allez recevoir un lien securise pour transmettre votre mot de passe LinkedIn.'
    };
    messages.en.pending_payment = messages.en.pending;
    messages.en.awaiting_credentials = {
      subject: 'Payment confirmed - credentials requested',
      title: 'Payment confirmed',
      body: 'Your payment is confirmed. You will receive a secure link to submit your LinkedIn password.'
    };
    messages.es.pending_payment = messages.es.pending;
    messages.es.awaiting_credentials = messages.en.awaiting_credentials;
    messages.de.pending_payment = messages.de.pending;
    messages.de.awaiting_credentials = messages.en.awaiting_credentials;

    const t = (messages[lang] || messages.fr)[toStatus];
    if (!t) return;

    const referralSection = (toStatus === 'done' && order.referralCode) ? `
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px;margin-top:24px">
              <h3 style="color:#15803d;margin:0 0 8px;font-size:15px">${lang === 'fr' ? '🎁 Parrainez vos amis et gagnez !' : lang === 'es' ? '🎁 ¡Refiere amigos y gana!' : lang === 'de' ? '🎁 Freunde werben und verdienen!' : '🎁 Refer friends and earn!'}</h3>
              <p style="color:#166534;font-size:13px;margin:0 0 12px">${lang === 'fr' ? 'Partagez votre code de parrainage et obtenez des avantages exclusifs.' : lang === 'es' ? 'Comparte tu código de referido y obtén beneficios exclusivos.' : lang === 'de' ? 'Teilen Sie Ihren Empfehlungscode und erhalten Sie exklusive Vorteile.' : 'Share your referral code and get exclusive benefits.'}</p>
              <div style="background:#fff;border:1px solid #bbf7d0;border-radius:8px;padding:12px;text-align:center;font-size:20px;font-weight:800;letter-spacing:4px;color:#15803d">${order.referralCode}</div>
              <p style="text-align:center;margin:10px 0 0;font-size:12px;color:#166534">
                <a href="${siteUrl}/?ref=${order.referralCode}" style="color:#15803d">${siteUrl}/?ref=${order.referralCode}</a>
              </p>
            </div>` : '';

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: order.customerEmail,
      subject: t.subject,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
          <div style="background:#1565C0;padding:32px;text-align:center">
            <img src="${siteUrl}/kareer-logo.png" alt="Kareer" style="width:48px;height:48px;margin-bottom:12px">
            <h1 style="color:#ffffff;margin:0;font-size:22px">${t.title}</h1>
          </div>
          <div style="padding:32px">
            <p style="color:#333;font-size:16px;line-height:1.6">${t.body}</p>
            <table style="width:100%;border-collapse:collapse;margin:24px 0">
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">Plan</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.plan} (${order.audience})</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;color:#666">${lang === 'fr' ? 'Montant' : lang === 'es' ? 'Monto' : lang === 'de' ? 'Betrag' : 'Amount'}</td><td style="padding:10px;border-bottom:1px solid #eee;font-weight:600">${order.amount}€</td></tr>
            </table>
            ${referralSection}
            <div style="text-align:center;margin-top:24px">
              <a href="${siteUrl}/suivi?id=${order.sessionId}" style="background:#1565C0;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">${lang === 'fr' ? 'Suivre ma commande' : lang === 'es' ? 'Seguir mi pedido' : lang === 'de' ? 'Meine Bestellung verfolgen' : 'Track my order'}</a>
            </div>
          </div>
          <div style="background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#999">
            Kareer — LinkedIn Premium ${lang === 'fr' ? 'à prix réduit' : lang === 'es' ? 'a precio reducido' : lang === 'de' ? 'zum reduzierten Preis' : 'at reduced price'}
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

// Fonction pour envoyer l'email au parrain quand la commande du filleul est terminée
async function sendReferrerEmail(data) {
  if (!process.env.RESEND_API_KEY) return;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';
    const { buildEmailHtml } = require('./_email');

    const referrerContent = data.referrerMode === 'transfer' 
      ? `
        <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px">
          Félicitations ! <strong>${data.refereeName}</strong> a terminé sa commande en utilisant votre code de parrainage <strong>${data.referralCode}</strong>.
        </p>
        <div style="background:linear-gradient(135deg, rgba(21,101,192,0.1), rgba(139,92,246,0.1));border-radius:12px;padding:24px;margin:24px 0;text-align:center">
          <div style="font-size:14px;color:#64748b;margin-bottom:8px">💰 Votre nouveau solde</div>
          <div style="font-size:2.5rem;font-weight:800;background:linear-gradient(135deg, #1565C0, #8B5CF6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${data.referrerBalance}€</div>
          <div style="font-size:13px;color:#64748b;margin-top:8px">+10€ ajoutés à votre solde</div>
        </div>
        <p style="color:#64748b;font-size:14px;line-height:1.6;margin:20px 0">
          Continuez à parrainer pour augmenter vos gains, ou demandez un virement bancaire dès maintenant.<br>
          <strong style="color:#f59e0b">⚠️ Attention :</strong> Demander un virement réinitialisera votre solde de parrainage à 0€.
        </p>
        <div style="text-align:center;margin-top:28px">
          <a href="${siteUrl}/parrainage.html" style="background:linear-gradient(135deg, #1565C0, #8B5CF6);color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">
            💸 Gérer mes gains
          </a>
        </div>
      `
      : `
        <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px">
          Félicitations ! <strong>${data.refereeName}</strong> a terminé sa commande en utilisant votre code de parrainage <strong>${data.referralCode}</strong>.
        </p>
        <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:12px;padding:24px;margin:24px 0;text-align:center">
          <div style="font-size:14px;color:#166534;margin-bottom:12px">🎁 Votre code promo de récompense</div>
          <div style="background:#fff;border:2px dashed #86efac;border-radius:8px;padding:16px;margin:12px 0">
            <div style="font-size:24px;font-weight:800;letter-spacing:3px;color:#15803d;font-family:monospace">${data.referrerPromoCode}</div>
          </div>
          <div style="font-size:15px;color:#15803d;font-weight:600;margin-top:12px">Valeur : 10€ de réduction</div>
        </div>
        <p style="color:#64748b;font-size:14px;line-height:1.6;margin:20px 0">
          Utilisez ce code lors de votre prochaine commande pour bénéficier de 10€ de réduction immédiate.
        </p>
        <p style="color:#64748b;font-size:14px;line-height:1.6;margin:20px 0">
          💡 <strong>Continuez à parrainer</strong> pour cumuler encore plus de réductions ! Vous pouvez aussi choisir de recevoir vos gains par virement bancaire depuis votre page de parrainage.
        </p>
        <div style="text-align:center;margin-top:28px">
          <a href="${siteUrl}/#pricing" style="background:linear-gradient(135deg, #1565C0, #8B5CF6);color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;font-size:15px;margin-right:12px">
            🛒 Commander maintenant
          </a>
          <a href="${siteUrl}/parrainage.html" style="background:#fff;color:#1565C0;border:2px solid #1565C0;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">
            👥 Mes parrainages
          </a>
        </div>
      `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: data.referrerEmail,
      subject: '🎉 Parrainage validé ! Votre récompense de 10€ est prête',
      html: buildEmailHtml({
        siteUrl,
        headerColor: '#10b981',
        title: '🎉 Parrainage réussi !',
        preheader: 'Votre filleul a terminé sa commande',
        content: referrerContent
      })
    });
  } catch (error) {
    console.error('[Referral] Error sending referrer email:', error);
  }
}
