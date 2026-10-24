// Order storage helpers shared by the API routes, plus the internal alerts
// the team receives at the two moments that need a fast reaction.

const crypto = require('crypto');
const kvStore = require('./_kv');
const { generateToken, hashToken } = require('./_credentials');
const {
  adminEmail,
  formatCurrency,
  formatOrderPlan,
  getSiteUrl,
  notifyTelegram,
  orderRef,
  renderEmail,
  sendEmail
} = require('./_email');

const LINK_TTL_MS = 72 * 60 * 60 * 1000;
const ACTIVATION_TARGET_MIN = 30;
// No 0/O, 1/I/L: the reference gets read out loud and typed by hand.
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function parse(data) {
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : data;
}

async function loadOrder(sessionId) {
  if (!sessionId) return null;
  return parse(await kvStore.get(`order:${sessionId}`));
}

async function saveOrder(order) {
  await kvStore.set(`order:${order.sessionId}`, JSON.stringify(order));
}

// "kr7q2lm8", "KR 7Q2 LM8" and "KR-7Q2LM8" all become "KR-7Q2LM8".
function normalizeReference(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^KR[A-Z0-9]{6}$/.test(raw) ? `KR-${raw.slice(2)}` : null;
}

async function newReference() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (const byte of bytes) code += REF_ALPHABET[byte % REF_ALPHABET.length];
    const reference = `KR-${code}`;
    if (!(await kvStore.get(`order-ref:${reference}`))) return reference;
  }
  throw new Error('Could not allocate an order reference');
}

// Orders created before references existed get one the first time the team touches them,
// so every email shows a short number. The caller saves the order.
async function ensureReference(order) {
  if (order.reference) return order.reference;
  order.reference = await newReference();
  await kvStore.set(`order-ref:${order.reference}`, order.sessionId);
  return order.reference;
}

// Accepts the internal id or the customer-facing reference.
async function findOrder(idOrReference) {
  const reference = normalizeReference(idOrReference);
  if (reference) {
    const sessionId = await kvStore.get(`order-ref:${reference}`);
    return sessionId ? loadOrder(typeof sessionId === 'string' ? sessionId : String(sessionId)) : null;
  }
  return loadOrder(idOrReference);
}

async function logAction(entry) {
  try {
    const logs = parse(await kvStore.get('audit:log')) || [];
    logs.unshift({ timestamp: new Date().toISOString(), ...entry });
    if (logs.length > 500) logs.length = 500;
    await kvStore.set('audit:log', JSON.stringify(logs));
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// New single-use link for the credentials page. Any previous link stops working.
async function issueCredentialLink(order) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const link = `${getSiteUrl()}/credentials.html?token=${encodeURIComponent(token)}`;

  if (order.credentialLink && order.credentialLink.tokenHash) {
    await kvStore.del(`credential-token:${order.credentialLink.tokenHash}`);
  }

  order.status = 'awaiting_credentials';
  order.credentialLink = { tokenHash, sentAt: now, expiresAt, usedAt: null };
  order.credentialLinkSentAt = now;
  order.updatedAt = now;

  await kvStore.set(`credential-token:${tokenHash}`, order.sessionId);
  await saveOrder(order);
  await logAction({ action: 'credential_link_created', sessionId: order.sessionId });
  return { link, expiresAt };
}

function parisTime(date) {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(date);
}

// Internal alerts: email to the admin address, plus Telegram when configured.
async function alertTeam(kind, order) {
  const ref = orderRef(order);
  const plan = formatOrderPlan(order, 'fr');
  const amount = formatCurrency(order.amount, order.currency || 'EUR', 'fr');
  const admin = `${getSiteUrl()}/admin`;
  const rows = [
    { label: 'Commande', value: ref, mono: true },
    { label: 'Offre', value: plan },
    { label: 'Montant', value: amount },
    { label: 'E-mail client', value: order.customerEmail },
    { label: 'Compte LinkedIn', value: order.linkedinEmail },
    { label: 'Langue', value: String(order.language || 'fr').toUpperCase() }
  ];

  let subject;
  let title;
  let lead;
  let telegram;
  if (kind === 'credentials') {
    const deadline = parisTime(new Date(Date.now() + ACTIVATION_TARGET_MIN * 60000));
    subject = `À activer avant ${deadline} : identifiants reçus pour ${ref}`;
    title = 'Identifiants reçus, à activer';
    lead = `Le client vient de transmettre son mot de passe. Le site promet 30 minutes maximum : Premium doit être actif avant ${deadline} (heure de Paris).`;
    telegram = `À activer avant ${deadline}\n${ref} · ${plan}\n${order.linkedinEmail}\n${admin}`;
  } else {
    subject = `Nouvelle commande ${ref} : ${plan}, ${amount}`;
    title = 'Nouvelle commande';
    lead = 'Prochaine étape : écrire au client sur WhatsApp et lui envoyer le lien sécurisé depuis le tableau de bord.';
    telegram = `Nouvelle commande ${ref}\n${plan}, ${amount}\n${order.customerEmail}\n${admin}`;
  }

  const body = renderEmail({
    lang: 'fr',
    title,
    preheader: lead,
    reference: ref,
    signature: false,
    footer: 'Notification interne Kareer.',
    blocks: [
      { type: 'p', text: lead },
      { type: 'details', rows },
      { type: 'button', label: 'Ouvrir le tableau de bord', href: admin }
    ]
  });

  const [mail, tg] = await Promise.all([
    sendEmail({ to: adminEmail(), subject, html: body.html, text: body.text, replyTo: order.customerEmail || undefined }),
    notifyTelegram(telegram)
  ]);
  return { email: mail.sent, telegram: tg };
}

module.exports = {
  ACTIVATION_TARGET_MIN,
  alertTeam,
  ensureReference,
  findOrder,
  issueCredentialLink,
  loadOrder,
  logAction,
  newReference,
  normalizeReference,
  parse,
  saveOrder
};
