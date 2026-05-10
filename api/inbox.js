require('./_env');
const crypto = require('crypto');
const { Resend } = require('resend');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');
const {
  buildEmailHtml,
  detailTable,
  emailButton,
  escapeHtml,
  getSiteUrl
} = require('./_email');

const INBOX_INDEX = 'inbox:index';
const INBOX_LOG_LIMIT = 500;
const DEFAULT_MAILBOXES = ['notifications@kareer.pro', 'contact@kareer.pro'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      verifyAuth(req);
      return await handleAdminGet(req, res);
    }

    if (req.method === 'POST') {
      const rawBody = await readRawBody(req);
      const body = parseJson(rawBody);
      const isAdminAction = !!(req.headers.authorization && body && body.action);

      if (isAdminAction) {
        verifyAuth(req);
        return await handleAdminAction(body, res);
      }

      return await handleInboundWebhook(req, rawBody, body, res);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Inbox error:', error.message);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Inbox error' });
  }
};

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(rawBody) {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    const err = new Error('Invalid JSON payload');
    err.statusCode = 400;
    throw err;
  }
}

async function handleAdminGet(req, res) {
  const { id, limit = 50, page = 1 } = req.query || {};

  if (id) {
    const item = await getInboxItem(id);
    if (!item) return res.status(404).json({ error: 'Message not found' });
    return res.status(200).json({ success: true, item: sanitizeInboxItem(item, true) });
  }

  const index = await getInboxIndex();
  const perPage = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const currentPage = Math.max(parseInt(page, 10) || 1, 1);
  const start = (currentPage - 1) * perPage;
  const ids = index.slice(start, start + perPage);
  const items = [];

  for (const messageId of ids) {
    const item = await getInboxItem(messageId);
    if (item) items.push(sanitizeInboxItem(item, false));
  }

  return res.status(200).json({
    success: true,
    items,
    page: currentPage,
    total: index.length,
    totalPages: Math.max(1, Math.ceil(index.length / perPage))
  });
}

async function handleAdminAction(body, res) {
  const { action, id } = body || {};
  if (!id) return res.status(400).json({ error: 'Missing message id' });

  const item = await getInboxItem(id);
  if (!item) return res.status(404).json({ error: 'Message not found' });

  if (action === 'mark_read') {
    item.read = true;
    item.updatedAt = new Date().toISOString();
    await saveInboxItem(item);
    return res.status(200).json({ success: true, item: sanitizeInboxItem(item, true) });
  }

  if (action === 'archive') {
    item.archived = true;
    item.updatedAt = new Date().toISOString();
    await saveInboxItem(item);
    return res.status(200).json({ success: true, item: sanitizeInboxItem(item, true) });
  }

  if (action === 'reply') {
    return await replyToInboxMessage(item, body, res);
  }

  return res.status(400).json({ error: 'Invalid action' });
}

async function handleInboundWebhook(req, rawBody, event, res) {
  assertInboundSecret(req);

  if (!event || event.type !== 'email.received') {
    return res.status(200).json({ success: true, ignored: true });
  }

  const emailId = event.data?.email_id || event.data?.id || event.data?.email?.id;
  const email = await loadReceivedEmail(emailId, event.data || {});
  const item = await buildInboxItem(email, event);

  if (!isAllowedMailbox(item.to)) {
    return res.status(200).json({ success: true, ignored: true, reason: 'recipient_not_allowed' });
  }

  const existing = await getInboxItem(item.id);
  if (existing) {
    return res.status(200).json({ success: true, duplicate: true, id: item.id });
  }

  await saveInboxItem(item);
  await prependInboxIndex(item.id);
  await notifyAdmin(item);

  return res.status(200).json({ success: true, id: item.id });
}

function assertInboundSecret(req) {
  const expected = process.env.INBOUND_EMAIL_SECRET || process.env.RESEND_INBOUND_SECRET;
  const provided = (req.query && req.query.secret) || req.headers['x-inbound-secret'];

  if (!expected) {
    if (process.env.VERCEL_ENV === 'production') {
      const error = new Error('INBOUND_EMAIL_SECRET is missing');
      error.statusCode = 500;
      throw error;
    }
    return;
  }

  if (provided !== expected) {
    const error = new Error('Unauthorized inbound webhook');
    error.statusCode = 401;
    throw error;
  }
}

async function loadReceivedEmail(emailId, fallback) {
  if (!emailId || !process.env.RESEND_API_KEY) return fallback;

  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }
  });

  if (!response.ok) {
    console.error('Failed to retrieve received email:', response.status, await response.text().catch(() => ''));
    return fallback;
  }

  return await response.json();
}

async function buildInboxItem(email, event) {
  const now = new Date().toISOString();
  const to = normalizeAddressList(email.to || event.data?.to || []);
  const from = email.from || event.data?.from || '';
  const fromEmail = extractEmail(from);
  const replyToList = normalizeAddressList(email.reply_to || email.replyTo || event.data?.reply_to || []);
  const subject = email.subject || event.data?.subject || '(sans objet)';
  const text = String(email.text || htmlToText(email.html || '') || '').trim();
  const id = email.id || event.data?.email_id || hash(`${from}|${to.join(',')}|${subject}|${email.created_at || now}`);
  const orderMatches = await findOrderMatches(fromEmail);

  return {
    id,
    resendEmailId: email.id || event.data?.email_id || null,
    eventId: event.id || null,
    from,
    fromEmail,
    replyTo: replyToList[0] || fromEmail,
    to,
    mailbox: pickMailbox(to),
    subject,
    text,
    html: email.html || '',
    headers: email.headers || {},
    messageId: email.message_id || email.messageId || '',
    attachments: Array.isArray(email.attachments) ? email.attachments.map(summarizeAttachment) : [],
    orderMatches,
    read: false,
    archived: false,
    status: 'new',
    messages: [{
      direction: 'incoming',
      from,
      to,
      subject,
      text,
      createdAt: email.created_at || now
    }],
    receivedAt: email.created_at || now,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeAddressList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(item => String(item || '').trim()).filter(Boolean);
}

function extractEmail(value) {
  const input = String(value || '').trim();
  const bracket = input.match(/<([^>]+)>/);
  return (bracket ? bracket[1] : input).trim().toLowerCase();
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function summarizeAttachment(attachment) {
  return {
    id: attachment.id || '',
    filename: attachment.filename || 'attachment',
    contentType: attachment.content_type || attachment.contentType || '',
    size: attachment.size || null
  };
}

function allowedMailboxes() {
  return String(process.env.INBOX_ALLOWED_RECIPIENTS || DEFAULT_MAILBOXES.join(','))
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedMailbox(recipients) {
  const allowed = allowedMailboxes();
  return normalizeAddressList(recipients).some(address => allowed.includes(extractEmail(address)));
}

function pickMailbox(recipients) {
  const allowed = allowedMailboxes();
  const found = normalizeAddressList(recipients).map(extractEmail).find(address => allowed.includes(address));
  return found || allowed[0] || 'contact@kareer.pro';
}

async function findOrderMatches(email) {
  if (!email) return [];

  try {
    const orders = await kvStore.getAllOrders(order => {
      const customerEmail = String(order.customerEmail || '').toLowerCase();
      const linkedinEmail = String(order.linkedinEmail || '').toLowerCase();
      return customerEmail === email || linkedinEmail === email;
    });

    return orders.slice(0, 5).map(order => ({
      sessionId: order.sessionId,
      status: order.status,
      plan: order.plan,
      amount: order.amount,
      customerEmail: order.customerEmail,
      linkedinEmail: order.linkedinEmail
    }));
  } catch (error) {
    console.error('Order match error:', error.message);
    return [];
  }
}

async function replyToInboxMessage(item, body, res) {
  const message = String(body.message || body.text || '').trim();
  if (!message) return res.status(400).json({ error: 'Message requis' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const mailbox = allowedMailboxes().includes(String(body.fromAddress || '').toLowerCase())
    ? String(body.fromAddress).toLowerCase()
    : item.mailbox || 'contact@kareer.pro';
  const recipient = item.replyTo || item.fromEmail;
  const subject = /^re:/i.test(item.subject || '') ? item.subject : `Re: ${item.subject || '(sans objet)'}`;
  const siteUrl = getSiteUrl();
  const content = `
    ${message.split(/\n{2,}/).map(paragraph =>
      `<p style="margin:0 0 16px;color:#1f2937;font-size:16px;line-height:1.6">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`
    ).join('')}
  `;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: `Kareer <${mailbox}>`,
    to: recipient,
    subject,
    html: buildEmailHtml({
      siteUrl,
      title: 'Réponse de Kareer',
      preheader: message.slice(0, 120),
      content,
      footer: 'Vous recevez cet email car vous avez contacté Kareer.',
      lang: 'fr'
    }),
    text: message,
    replyTo: mailbox,
    headers: item.messageId ? { 'In-Reply-To': item.messageId, References: item.messageId } : undefined
  });

  const now = new Date().toISOString();
  item.messages = item.messages || [];
  item.messages.push({
    direction: 'outgoing',
    from: mailbox,
    to: recipient,
    subject,
    text: message,
    resendId: result && result.id ? result.id : null,
    createdAt: now
  });
  item.status = 'replied';
  item.read = true;
  item.repliedAt = now;
  item.updatedAt = now;
  await saveInboxItem(item);

  return res.status(200).json({ success: true, item: sanitizeInboxItem(item, true) });
}

async function notifyAdmin(item) {
  if (!process.env.RESEND_API_KEY) return false;

  const adminEmail = process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com';
  const siteUrl = getSiteUrl();
  const preview = (item.text || '(message sans texte)').slice(0, 800);
  const content = `
    <p style="margin:0 0 18px;color:#1f2937;font-size:16px;line-height:1.6">Un client a répondu à ${escapeHtml(item.mailbox)}.</p>
    ${detailTable([
      { label: 'De', value: item.from },
      { label: 'À', value: item.to.join(', ') },
      { label: 'Sujet', value: item.subject },
      { label: 'Message', value: preview }
    ])}
    ${item.orderMatches && item.orderMatches.length ? `<p style="margin:0 0 16px;color:#64748b;font-size:13px;line-height:1.6">Commande liée possible : ${escapeHtml(item.orderMatches[0].sessionId)} (${escapeHtml(item.orderMatches[0].status)})</p>` : ''}
    ${emailButton('Ouvrir la boîte de réception', `${siteUrl}/admin`)}
  `;

  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: 'Kareer Inbox <notifications@kareer.pro>',
    to: adminEmail,
    subject: `Nouveau message client — ${item.subject}`,
    html: buildEmailHtml({
      siteUrl,
      title: 'Nouveau message client',
      preheader: `${item.fromEmail}: ${item.subject}`,
      content,
      footer: 'Notification interne Kareer.',
      lang: 'fr'
    }),
    text: `Nouveau message client\n\nDe: ${item.from}\nÀ: ${item.to.join(', ')}\nSujet: ${item.subject}\n\n${preview}\n\nAdmin: ${siteUrl}/admin`
  });

  return true;
}

async function getInboxItem(id) {
  const data = await kvStore.get(`inbox:${id}`);
  return data ? (typeof data === 'string' ? JSON.parse(data) : data) : null;
}

async function saveInboxItem(item) {
  await kvStore.set(`inbox:${item.id}`, JSON.stringify(item));
}

async function getInboxIndex() {
  const data = await kvStore.get(INBOX_INDEX);
  return data ? (typeof data === 'string' ? JSON.parse(data) : data) : [];
}

async function prependInboxIndex(id) {
  const index = await getInboxIndex();
  const updated = [id].concat(index.filter(existingId => existingId !== id)).slice(0, INBOX_LOG_LIMIT);
  await kvStore.set(INBOX_INDEX, JSON.stringify(updated));
}

function sanitizeInboxItem(item, includeDetail) {
  const messages = item.messages || [];
  const latest = messages[messages.length - 1] || {};
  const base = {
    id: item.id,
    from: item.from,
    fromEmail: item.fromEmail,
    replyTo: item.replyTo,
    to: item.to,
    mailbox: item.mailbox,
    subject: item.subject,
    preview: (latest.text || item.text || '').slice(0, 180),
    text: includeDetail ? item.text : undefined,
    attachments: item.attachments || [],
    orderMatches: item.orderMatches || [],
    read: !!item.read,
    archived: !!item.archived,
    status: item.status || 'new',
    receivedAt: item.receivedAt,
    updatedAt: item.updatedAt,
    messages: includeDetail ? messages : undefined
  };
  return JSON.parse(JSON.stringify(base));
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

module.exports.config = {
  api: { bodyParser: false }
};
