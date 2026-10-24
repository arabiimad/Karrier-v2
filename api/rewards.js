const kv = require('./_kv');
const crypto = require('crypto');
const { verifyAdminToken } = require('./_verify-admin');
const { adminEmail, getSiteUrl, notifyTelegram, renderEmail, sendEmail } = require('./_email');
const { codeForEmail, createReferral, getReferral, isActive, parseValue, saveReferral } = require('./_referrals');
const customerEmails = require('./_customer-emails');
const rateLimit = require('./_rate-limit');
const referralAuth = require('./_referral-auth');
const checkCodeRate = rateLimit({ windowMs: 10 * 60 * 1000, max: 8 });

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${name.charAt(0)}•••@${domain}`;
}

// What the owner sees: IBAN masked, referred people reduced to a masked email.
function publicReferral(code, referral) {
  const mask = info => info ? { accountName: info.accountName || '', ibanMasked: customerEmails.maskIban(info.iban) } : null;
  return {
    code,
    status: referral.status || 'active',
    source: referral.source || null,
    referrerEmail: referral.referrerEmail,
    referrerName: referral.referrerName || '',
    referralCount: referral.referralCount || 0,
    pendingBalance: Number(referral.pendingBalance || 0),
    paymentInfo: mask(referral.paymentInfo),
    referrals: (referral.referrals || []).map(r => ({
      who: maskEmail(r.email),
      usedAt: r.usedAt || null,
      paidAt: r.paidAt || null,
      reversed: !!r.reversedAt,
      promoCode: r.referrerPromoCode || null
    })),
    transferRequests: (referral.transferRequests || []).map(t => ({ amount: t.amount, requestedAt: t.requestedAt, completedAt: t.completedAt || null, status: t.status, paymentInfo: mask(t.paymentInfo) })),
    balanceCodes: referral.balanceCodes || [],
    application: referral.application ? { name: referral.application.name, situation: referral.application.situation } : null,
    createdAt: referral.createdAt || null
  };
}

const SITUATIONS = ['student', 'graduate', 'creator', 'other'];
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function newBalancePromoCode() {
  let code;
  do {
    code = 'SOLDE';
    for (const byte of crypto.randomBytes(6)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  } while (await kv.get(`promo:${code}`));
  return code;
}

// Générer un code promo aléatoire
function generatePromoCode(prefix = 'KAREER') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = prefix;
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { isAdmin } = verifyAdminToken(req);
  const { type } = req.query;

  try {
    // ============ ROUTES CODES PROMO ============
    if (type === 'promo' || !type) {
      // GET - Liste ou validation codes promo
      if (req.method === 'GET') {
        const { code } = req.query;

        // Validation d'un code promo (public)
        if (code) {
          const promoData = await kv.get(`promo:${code.toUpperCase()}`);
          
          if (!promoData) {
            return res.status(404).json({ error: 'Code promo invalide' });
          }

          const promo = typeof promoData === 'string' ? JSON.parse(promoData) : promoData;

          if (!promo.active) {
            return res.status(400).json({ error: 'Code promo désactivé' });
          }

          if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
            return res.status(400).json({ error: 'Code promo expiré' });
          }

          if (promo.maxUses && promo.usedCount >= promo.maxUses) {
            return res.status(400).json({ error: 'Code promo épuisé' });
          }

          return res.status(200).json({
            code: code.toUpperCase(),
            type: promo.type,
            value: promo.value,
            // Referral codes carry an email in their description: keep it out of the public answer.
            description: promo.referralType ? null : promo.description,
            minAmount: promo.minAmount || 0,
            applicablePlans: promo.applicablePlans || 'all'
          });
        }

        // Liste tous les codes (admin only)
        if (!isAdmin) {
          return res.status(401).json({ error: 'Non autorisé' });
        }

        const keys = await kv.keys('promo:*');
        const codes = [];
        
        for (const key of keys) {
          const data = await kv.get(key);
          const promo = typeof data === 'string' ? JSON.parse(data) : data;
          codes.push({
            code: key.replace('promo:', ''),
            ...promo
          });
        }

        return res.status(200).json({ codes });
      }

      // POST - Créer ou utiliser un code promo
      if (req.method === 'POST') {
        const { action } = req.query;

        // Promo codes are applied by /api/create-order when the order is saved.
        // This public route let anyone use up a limited code, so it is closed.
        if (action === 'use') {
          return res.status(410).json({ error: 'Route retirée : le code est appliqué à la commande.' });
        }
        // Créer un nouveau code promo (admin only)
        if (!isAdmin) {
          return res.status(401).json({ error: 'Non autorisé' });
        }

        const {
          code,
          type: promoType,
          value,
          description,
          maxUses,
          expiresAt,
          minAmount,
          applicablePlans,
          autoGenerate
        } = req.body;

        if (!promoType || !value) {
          return res.status(400).json({ error: 'Type et valeur requis' });
        }

        let finalCode = code ? code.toUpperCase() : null;
        if (autoGenerate || !finalCode) {
          finalCode = generatePromoCode();
          let exists = await kv.get(`promo:${finalCode}`);
          while (exists) {
            finalCode = generatePromoCode();
            exists = await kv.get(`promo:${finalCode}`);
          }
        }

        const existingPromo = await kv.get(`promo:${finalCode}`);
        if (existingPromo) {
          return res.status(400).json({ error: 'Code promo déjà existant' });
        }

        const promoData = {
          type: promoType,
          value: parseFloat(value),
          description: description || '',
          maxUses: maxUses ? parseInt(maxUses) : null,
          expiresAt: expiresAt || null,
          minAmount: minAmount ? parseFloat(minAmount) : 0,
          applicablePlans: applicablePlans || 'all',
          active: true,
          usedCount: 0,
          createdAt: new Date().toISOString(),
          usageHistory: []
        };

        await kv.set(`promo:${finalCode}`, promoData);

        return res.status(201).json({
          success: true,
          code: finalCode,
          data: promoData
        });
      }

      // PUT - Modifier un code promo (admin only)
      if (req.method === 'PUT') {
        if (!isAdmin) {
          return res.status(401).json({ error: 'Non autorisé' });
        }

        const { code, updates } = req.body;

        if (!code) {
          return res.status(400).json({ error: 'Code requis' });
        }

        const promoData = await kv.get(`promo:${code.toUpperCase()}`);
        
        if (!promoData) {
          return res.status(404).json({ error: 'Code promo introuvable' });
        }

        const promo = typeof promoData === 'string' ? JSON.parse(promoData) : promoData;
        const updatedPromo = {
          ...promo,
          ...updates,
          updatedAt: new Date().toISOString()
        };

        await kv.set(`promo:${code.toUpperCase()}`, updatedPromo);

        return res.status(200).json({
          success: true,
          data: updatedPromo
        });
      }

      // DELETE - Supprimer un code promo (admin only)
      if (req.method === 'DELETE') {
        if (!isAdmin) {
          return res.status(401).json({ error: 'Non autorisé' });
        }

        const { code } = req.query;

        if (!code) {
          return res.status(400).json({ error: 'Code requis' });
        }

        const promoData = await kv.get(`promo:${code.toUpperCase()}`);
        
        if (!promoData) {
          return res.status(404).json({ error: 'Code promo introuvable' });
        }

        await kv.del(`promo:${code.toUpperCase()}`);

        return res.status(200).json({ success: true });
      }
    }

    // ============ ROUTES PARRAINAGE ============
    if (type === 'referral') {
      const action = req.query.action;

      if (req.method === 'GET') {
        const { code } = req.query;

        // Public check of a code: says whether it works, nothing about its owner.
        if (code) {
          const referral = await getReferral(code);
          if (!isActive(referral)) {
            return res.status(404).json({ error: 'Code de parrainage invalide' });
          }
          return res.status(200).json({ code: code.toUpperCase(), valid: true });
        }

        // The owner's page: only after the emailed code was confirmed.
        if (req.query.me || req.query.email) {
          const sessionEmail = referralAuth.readSession(req);
          if (!sessionEmail) return res.status(401).json({ error: 'auth_required' });
          const own = await codeForEmail(sessionEmail);
          const referral = own ? await getReferral(own) : null;
          if (!referral) return res.status(404).json({ error: 'not_found', email: sessionEmail });
          return res.status(200).json(publicReferral(own, referral));
        }

        if (isAdmin) {
          const keys = await kv.keys('referral:REF*');
          const referrals = [];
          for (const key of keys) {
            const referral = parseValue(await kv.get(key));
            if (referral && typeof referral === 'object') referrals.push({ code: key.replace('referral:', ''), ...referral });
          }
          return res.status(200).json({ referrals });
        }

        return res.status(400).json({ error: 'Paramètres manquants' });
      }

      if (req.method === 'POST') {
        const body = req.body || {};

        if (action === 'send_code' || action === 'verify_code') {
          const rate = checkCodeRate(req);
          if (!rate.allowed) {
            return res.status(429).json({ error: 'too_many_requests', retryAfter: rate.retryAfter });
          }
        }

        // Step 1: email a 6-digit code. Anyone can ask: customers to open their page,
        // other people to apply as a referrer.
        if (action === 'send_code') {
          const email = referralAuth.normalizeEmail(body.email);
          if (!email) return res.status(400).json({ error: 'invalid_email' });

          const key = `referral-otp:${email}`;
          const now = Date.now();
          const previous = parseValue(await kv.get(key));
          const sends = (previous && previous.sends ? previous.sends : []).filter(t => now - t < referralAuth.CODE_TTL_MS);
          if (sends.length >= referralAuth.MAX_SENDS) {
            return res.status(429).json({ error: 'too_many_codes' });
          }
          const own = await codeForEmail(email);
          const referral = own ? await getReferral(own) : null;
          const otp = referralAuth.newCode();
          await kv.set(key, JSON.stringify({
            hash: referralAuth.hashCode(email, otp),
            expiresAt: now + referralAuth.CODE_TTL_MS,
            attempts: 0,
            sends: sends.concat([now])
          }));
          await sendEmail({ to: email, ...customerEmails.referralAccessCode({ language: body.lang || (referral && referral.language), code: otp }) });
          return res.status(200).json({ success: true });
        }

        // Step 2: check the code and open a 2-hour session.
        if (action === 'verify_code') {
          const email = referralAuth.normalizeEmail(body.email);
          const typed = String(body.code || '').replace(/\D/g, '');
          if (!email || typed.length !== 6) return res.status(400).json({ error: 'code_invalid' });

          const key = `referral-otp:${email}`;
          const otp = parseValue(await kv.get(key));
          if (!otp || !otp.hash || Date.now() > otp.expiresAt) {
            return res.status(400).json({ error: 'code_expired' });
          }
          if (otp.attempts >= referralAuth.MAX_ATTEMPTS) {
            // Kill the code but keep the send history, so the per-email limit still applies.
            otp.hash = null;
            await kv.set(key, JSON.stringify(otp));
            return res.status(429).json({ error: 'too_many_attempts' });
          }
          if (!referralAuth.sameHash(otp.hash, referralAuth.hashCode(email, typed))) {
            otp.attempts = (otp.attempts || 0) + 1;
            await kv.set(key, JSON.stringify(otp));
            return res.status(400).json({ error: 'code_invalid', attemptsLeft: Math.max(0, referralAuth.MAX_ATTEMPTS - otp.attempts) });
          }
          await kv.del(key);
          return res.status(200).json({ success: true, token: referralAuth.signSession(email) });
        }

        // Someone who is not a customer asks for a code. It stays inactive until the team accepts it.
        if (action === 'apply') {
          const email = referralAuth.readSession(req);
          if (!email) return res.status(401).json({ error: 'auth_required' });
          const existing = await codeForEmail(email);
          if (existing && await getReferral(existing)) return res.status(409).json({ error: 'already_exists' });

          const application = {
            name: clean(body.name, 80),
            situation: SITUATIONS.includes(body.situation) ? body.situation : '',
            organisation: clean(body.organisation, 120),
            link: clean(body.link, 200),
            message: String(body.message || '').trim().slice(0, 600),
            submittedAt: new Date().toISOString()
          };
          if (application.name.length < 2 || !application.situation) {
            return res.status(400).json({ error: 'missing_fields' });
          }
          const language = ['fr', 'en', 'es', 'de'].includes(body.lang) ? body.lang : 'fr';
          const { code, referral } = await createReferral(email, {
            status: 'pending',
            source: 'application',
            language,
            referrerName: application.name,
            application
          });
          await Promise.allSettled([
            sendEmail({ to: email, ...customerEmails.referralApplicationReceived({ language, name: application.name }) }),
            alertTeamApplication(email, code, application)
          ]);
          return res.status(201).json(publicReferral(code, referral));
        }

        // Rewards come from paid orders (api/update-order.js); this old public route is closed.
        if (action === 'use') {
          return res.status(410).json({ error: 'Route retirée : la récompense est attribuée au paiement de la commande.' });
        }

        return res.status(400).json({ error: 'Action inconnue' });
      }

      if (req.method === 'PUT') {
        const body = req.body || {};

        // Team: accept or refuse an application.
        if (action === 'review') {
          if (!isAdmin) return res.status(401).json({ error: 'Non autorisé' });
          const code = String(body.code || '').toUpperCase();
          const referral = await getReferral(code);
          if (!referral) return res.status(404).json({ error: 'Code introuvable' });
          const name = (referral.application && referral.application.name) || referral.referrerName || '';
          if (body.decision === 'approve') {
            referral.status = 'active';
            referral.approvedAt = new Date().toISOString();
            await saveReferral(code, referral);
            await sendEmail({ to: referral.referrerEmail, ...customerEmails.referralApplicationApproved({ language: referral.language, name, code }) });
          } else if (body.decision === 'reject') {
            referral.status = 'rejected';
            referral.rejectedAt = new Date().toISOString();
            await saveReferral(code, referral);
            await sendEmail({ to: referral.referrerEmail, ...customerEmails.referralApplicationRejected({ language: referral.language, name }) });
          } else {
            return res.status(400).json({ error: 'Décision invalide' });
          }
          return res.status(200).json({ success: true, status: referral.status });
        }

        // Team: the transfer has been made.
        if (action === 'transfer_done') {
          if (!isAdmin) return res.status(401).json({ error: 'Non autorisé' });
          const code = String(body.code || '').toUpperCase();
          const referral = await getReferral(code);
          const request = referral && (referral.transferRequests || []).find(t => t.requestedAt === body.requestedAt && t.status !== 'completed');
          if (!request) return res.status(404).json({ error: 'Demande introuvable' });
          request.status = 'completed';
          request.completedAt = new Date().toISOString();
          await saveReferral(code, referral);
          await sendEmail({ to: referral.referrerEmail, ...customerEmails.referralTransferSent({ language: referral.language, amount: request.amount, iban: request.paymentInfo && request.paymentInfo.iban }) });
          return res.status(200).json({ success: true });
        }

        // The owner, signed in with the emailed code.
        const email = referralAuth.readSession(req);
        if (!email) return res.status(401).json({ error: 'auth_required' });
        const code = await codeForEmail(email);
        const referral = code ? await getReferral(code) : null;
        if (!referral) return res.status(404).json({ error: 'not_found' });
        if (!isActive(referral)) return res.status(403).json({ error: 'not_active' });

        let promoCode = null;

        if (body.paymentInfo) {
          const iban = String(body.paymentInfo.iban || '').replace(/\s+/g, '').toUpperCase();
          const accountName = clean(body.paymentInfo.accountName, 120);
          if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) || !accountName) {
            return res.status(400).json({ error: 'invalid_bank_details' });
          }
          referral.paymentInfo = { iban, accountName };
        }

        // Cash: the whole balance, no minimum.
        if (body.requestTransfer) {
          const amount = Number(referral.pendingBalance || 0);
          if (!(amount > 0)) return res.status(400).json({ error: 'empty_balance' });
          if (!referral.paymentInfo) return res.status(400).json({ error: 'missing_bank_details' });
          const request = { amount, requestedAt: new Date().toISOString(), status: 'pending', paymentInfo: referral.paymentInfo };
          referral.transferRequests = (referral.transferRequests || []).concat([request]);
          referral.pendingBalance = 0;
          await saveReferral(code, referral);
          await sendTransferRequestEmails({
            referrerEmail: referral.referrerEmail || email,
            language: referral.language,
            code,
            amount,
            iban: referral.paymentInfo.iban,
            accountName: referral.paymentInfo.accountName
          });
        }

        // Subscription: turn (part of) the balance into a single-use discount code.
        if (body.useBalance) {
          const balance = Number(referral.pendingBalance || 0);
          const amount = Math.round(Number(body.amount || balance) * 100) / 100;
          if (!(amount > 0) || amount > balance) return res.status(400).json({ error: 'invalid_amount' });
          promoCode = await newBalancePromoCode();
          const now = new Date().toISOString();
          await kv.set(`promo:${promoCode}`, {
            type: 'fixed',
            value: amount,
            description: 'Solde de parrainage',
            ownerEmail: referral.referrerEmail,
            maxUses: 1,
            usedCount: 0,
            minAmount: 0,
            expiresAt: null,
            applicablePlans: 'all',
            active: true,
            createdAt: now,
            usageHistory: [],
            referralCode: code,
            referralType: 'balance'
          });
          referral.pendingBalance = Math.round((balance - amount) * 100) / 100;
          referral.balanceCodes = (referral.balanceCodes || []).concat([{ code: promoCode, amount, createdAt: now }]);
          await saveReferral(code, referral);
          await sendEmail({ to: referral.referrerEmail || email, ...customerEmails.referralBalanceCode({ language: referral.language, promoCode, amount, balanceLeft: referral.pendingBalance }) });
        }

        if (body.paymentInfo && !body.requestTransfer && !body.useBalance) {
          await saveReferral(code, referral);
        }

        return res.status(200).json({ success: true, promoCode, referral: publicReferral(code, referral) });
      }
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (error) {
    console.error('Erreur rewards:', error);
    return res.status(500).json({ error: 'Erreur serveur', details: error.message });
  }
};

const SITUATION_LABELS = { student: 'Étudiant·e', graduate: 'Jeune diplômé·e', creator: 'Créateur·rice de contenu', other: 'Autre' };

async function alertTeamApplication(email, code, application) {
  const body = renderEmail({
    lang: 'fr',
    title: 'Nouvelle demande de parrain',
    preheader: `${application.name} (${SITUATION_LABELS[application.situation]}) demande un code.`,
    signature: false,
    footer: 'Notification interne Kareer.',
    blocks: [
      { type: 'p', text: 'Une personne qui n\'est pas encore cliente demande un code de parrainage. Le code reste inactif tant qu\'il n\'est pas accepté.' },
      { type: 'details', rows: [
        { label: 'Nom', value: application.name },
        { label: 'E-mail', value: email },
        { label: 'Situation', value: SITUATION_LABELS[application.situation] },
        { label: 'École ou activité', value: application.organisation },
        { label: 'Lien', value: application.link },
        { label: 'Code prévu', value: code, mono: true }
      ] },
      application.message ? { type: 'note', title: 'Comment elle compte partager le code', text: application.message } : null,
      { type: 'button', label: 'Accepter ou refuser dans le tableau de bord', href: `${getSiteUrl()}/admin` }
    ]
  });
  await Promise.all([
    sendEmail({ to: adminEmail(), subject: `Demande de parrain : ${application.name}`, html: body.html, text: body.text, replyTo: email }),
    notifyTelegram(`Demande de parrain : ${application.name} (${SITUATION_LABELS[application.situation]})\n${email}\n${getSiteUrl()}/admin`)
  ]);
}

// Transfer request: confirmation to the customer, full details to the team.
async function sendTransferRequestEmails(data) {
  await sendEmail({ to: data.referrerEmail, ...customerEmails.transferRequested(data) });

  const amount = `${data.amount} €`;
  const body = renderEmail({
    lang: 'fr',
    title: 'Demande de virement de parrainage',
    preheader: `${data.referrerEmail} demande ${amount}.`,
    signature: false,
    footer: 'Notification interne Kareer.',
    blocks: [
      { type: 'p', text: `${data.referrerEmail} demande le virement de son solde de parrainage.` },
      { type: 'details', rows: [
        { label: 'Client', value: data.referrerEmail },
        { label: 'Code', value: data.code, mono: true },
        { label: 'Montant', value: amount },
        { label: 'Titulaire', value: data.accountName },
        { label: 'IBAN', value: data.iban, mono: true }
      ] },
      { type: 'note', tone: 'highlight', title: 'Avant de virer', text: 'La demande vient d\'une session ouverte avec un code envoyé à l\'adresse du client. Vérifiez que le titulaire du compte correspond bien au client.' },
      { type: 'button', label: 'Ouvrir le tableau de bord', href: `${getSiteUrl()}/admin` }
    ]
  });
  await sendEmail({ to: adminEmail(), subject: `Virement parrainage à faire : ${amount} pour ${data.referrerEmail}`, html: body.html, text: body.text, replyTo: data.referrerEmail });
}
