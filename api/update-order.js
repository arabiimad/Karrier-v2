require('./_env');
const crypto = require('crypto');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const { decryptSecret } = require('./_credentials');
const { sendEmail } = require('./_email');
const customerEmails = require('./_customer-emails');
const { ensureReference, issueCredentialLink } = require('./_orders');
const { isPaid } = require('./_payment');

const VALID_STATUSES = ['pending', 'pending_payment', 'awaiting_credentials', 'activating', 'done', 'refunded'];

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
      if (action === 'mark_paid') {
        return await markPaid(session_id, req.body, res);
      }
      if (action === 'add_note') {
        return await addNote(session_id, req.body, res);
      }
      if (action === 'set_student_verified') {
        return await setStudentVerified(session_id, req.body, res);
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
    const { session_id, status, note, notify } = req.body;

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
    await ensureReference(order);
    const previousStatus = order.status;
    const wasPaid = isPaid(order);
    order.status = status;
    order.updatedAt = new Date().toISOString();

    if (note) {
      if (!order.notes) order.notes = [];
      order.notes.push({ text: note, date: new Date().toISOString(), by: 'admin' });
    }

    // Activation: 12 months of Premium, a referral code for the customer, reward for whoever referred them.
    if (status === 'done' && previousStatus !== 'done') {
      order.activatedAt = new Date().toISOString();
      order.expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      if (!order.referralCode) await ensureReferralCode(order);
      await rewardReferrerIfNeeded(order);
      deleteCredentials(order);
    }
    if (status === 'refunded' && previousStatus !== 'refunded' && !order.refundedAt) {
      order.refundedAt = new Date().toISOString();
    }

    await kvStore.set(`order:${session_id}`, JSON.stringify(order));

    await logAction(kvStore, {
      action: 'status_change',
      sessionId: session_id,
      from: previousStatus,
      to: status,
      timestamp: new Date().toISOString()
    });

    let emailSent = false;
    if (previousStatus !== status && notify !== false) {
      const mail = await sendStatusEmail(order, status, wasPaid);
      emailSent = !!mail.sent;
    }

    res.status(200).json({ success: true, emailSent, order: sanitizeOrder(order) });

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

  await ensureReference(order);
  const { link, expiresAt } = await issueCredentialLink(order);
  const mail = await sendEmail({ to: order.customerEmail, ...customerEmails.credentialLink(order, link, expiresAt) });
  return res.status(200).json({ success: true, link, expiresAt, emailSent: mail.sent });
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

// The customer's own code, reused if they already have one from an earlier order.
async function ensureReferralCode(order) {
  const email = String(order.customerEmail || '').trim().toLowerCase();
  if (!email) return;
  const existing = await kvStore.get(`referral:email:${email}`);
  if (typeof existing === 'string' && /^REF[A-Z0-9]{4,}$/.test(existing) && await kvStore.get(`referral:${existing}`)) {
    order.referralCode = existing;
    order.customerReferralCode = existing;
    return;
  }

  let code;
  do {
    code = 'REF' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  } while (await kvStore.get(`referral:${code}`));

  order.referralCode = code;
  order.customerReferralCode = code;
  await kvStore.set(`referral:${code}`, JSON.stringify({
    referrerEmail: email,
    referrerName: email.split('@')[0],
    language: order.language || 'fr',
    referralCount: 0,
    referrals: [],
    rewardMode: 'promo',
    pendingBalance: 0,
    transferRequests: [],
    sessionId: order.sessionId,
    plan: order.plan,
    createdAt: new Date().toISOString()
  }));
  await kvStore.set(`referral:email:${email}`, code);

  const refIndexData = await kvStore.get('referrals:index');
  const refIndex = refIndexData ? (typeof refIndexData === 'string' ? JSON.parse(refIndexData) : refIndexData) : [];
  if (!refIndex.includes(code)) refIndex.push(code);
  await kvStore.set('referrals:index', JSON.stringify(refIndex));
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

    if (!alreadyRecorded && referral.referrerEmail) {
      await sendEmail({
        to: referral.referrerEmail,
        ...customerEmails.referralReward({
          language: referral.language,
          code: usedCode,
          mode: referral.rewardMode,
          promoCode: referrerPromoCode,
          balance: referral.pendingBalance
        })
      });
    }

    order.referrerRewardedAt = new Date().toISOString();
  } catch (err) {
    console.error('[Referral] Error rewarding referrer:', err.message);
  }
}

async function markPaid(sessionId, body, res) {
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const data = await kvStore.get(`order:${sessionId}`);
  if (!data) return res.status(404).json({ error: 'Order not found' });

  const order = typeof data === 'string' ? JSON.parse(data) : data;
  const paid = body.paid !== false;
  const wasPaid = isPaid(order);
  await ensureReference(order);
  const now = new Date().toISOString();

  order.paid = paid;
  order.paidAt = paid ? (order.paidAt || now) : null;
  if (paid && body.method) order.paymentMethod = String(body.method).trim().slice(0, 60);
  if (!paid) delete order.paymentMethod;
  order.updatedAt = now;

  // The customer's receipt, sent once per order: unmarking and marking again does not resend it.
  let receiptSent = false;
  if (paid && !wasPaid && !order.receiptSentAt && body.notify !== false) {
    const mail = await sendEmail({ to: order.customerEmail, ...customerEmails.paymentReceived(order) });
    receiptSent = !!mail.sent;
    if (receiptSent) order.receiptSentAt = now;
  }

  await kvStore.set(`order:${sessionId}`, JSON.stringify(order));
  await logAction(kvStore, {
    action: paid ? 'marked_paid' : 'marked_unpaid',
    sessionId,
    timestamp: now
  });

  return res.status(200).json({ success: true, receiptSent, order: sanitizeOrder(order) });
}

async function loadOrder(sessionId) {
  if (!sessionId) return null;
  const data = await kvStore.get(`order:${sessionId}`);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : data;
}

async function addNote(sessionId, body, res) {
  const order = await loadOrder(sessionId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const text = String(body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Empty note' });

  const now = new Date().toISOString();
  if (!Array.isArray(order.notes)) order.notes = [];
  order.notes.push({ text, date: now, by: 'admin' });
  order.updatedAt = now;
  await kvStore.set(`order:${sessionId}`, JSON.stringify(order));
  return res.status(200).json({ success: true, order: sanitizeOrder(order) });
}

async function setStudentVerified(sessionId, body, res) {
  const order = await loadOrder(sessionId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const now = new Date().toISOString();
  order.studentVerified = body.verified !== false;
  order.studentVerifiedAt = order.studentVerified ? now : null;
  order.updatedAt = now;
  await kvStore.set(`order:${sessionId}`, JSON.stringify(order));
  await logAction(kvStore, {
    action: order.studentVerified ? 'student_verified' : 'student_unverified',
    sessionId,
    timestamp: now
  });
  return res.status(200).json({ success: true, order: sanitizeOrder(order) });
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
  copy.isPaid = isPaid(order);
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

// Only the steps the customer cares about get an email. Internal statuses stay quiet.
async function sendStatusEmail(order, toStatus, wasPaid) {
  let mail = null;
  if (toStatus === 'activating') mail = customerEmails.activationStarted(order, { credentialsReceived: false });
  else if (toStatus === 'done') mail = customerEmails.activated(order);
  else if (toStatus === 'refunded') mail = customerEmails.refunded(order, { cancelled: !wasPaid });
  if (!mail) return { sent: false, reason: 'no_email_for_status' };
  return sendEmail({ to: order.customerEmail, ...mail });
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
