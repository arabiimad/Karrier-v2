const kv = require('./_kv');
const crypto = require('crypto');
const { verifyAdminToken } = require('./_verify-admin');
const { adminEmail, getSiteUrl, notifyTelegram, renderEmail, sendEmail } = require('./_email');
const { REWARD, codeForEmail, getReferral, isActive, parseValue, saveReferral } = require('./_referrals');
const ambassadors = require('./_ambassadors');
const customerEmails = require('./_customer-emails');
const rateLimit = require('./_rate-limit');
const referralAuth = require('./_referral-auth');
const checkCodeRate = rateLimit({ windowMs: 10 * 60 * 1000, max: 8 });

const LANGS = ['fr', 'en', 'es', 'de'];
const SITUATIONS = ['student', 'graduate', 'creator', 'professional', 'other'];
const SITUATION_LABELS = { student: 'Étudiant·e', graduate: 'Jeune diplômé·e', creator: 'Créateur·rice de contenu', professional: 'Partage avec ses collègues', other: 'Autre' };
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const MAX_AMOUNT = 500;

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${name.charAt(0)}•••@${domain}`;
}

function maskPayment(info) {
  return info ? { accountName: info.accountName || '', ibanMasked: customerEmails.maskIban(info.iban) } : null;
}

// Balance, history and transfers as the owner sees them: IBAN masked, referred people reduced to a masked email.
function publicWallet(account) {
  return {
    referralCount: account.referralCount || 0,
    pendingBalance: Number(account.pendingBalance || 0),
    paymentInfo: maskPayment(account.paymentInfo),
    referrals: (account.referrals || []).map(r => ({
      who: maskEmail(r.email),
      usedAt: r.usedAt || null,
      paidAt: r.paidAt || null,
      reward: r.reward != null ? Number(r.reward) : null,
      reversed: !!r.reversedAt,
      promoCode: r.referrerPromoCode || null
    })),
    transferRequests: (account.transferRequests || []).map(t => ({ amount: t.amount, requestedAt: t.requestedAt, completedAt: t.completedAt || null, status: t.status, paymentInfo: maskPayment(t.paymentInfo) })),
    balanceCodes: account.balanceCodes || []
  };
}

function publicReferral(code, referral) {
  return {
    program: 'referral',
    code,
    status: referral.status || 'active',
    email: referral.referrerEmail,
    referrerEmail: referral.referrerEmail,
    discount: REWARD,
    reward: REWARD,
    ...publicWallet(referral),
    createdAt: referral.createdAt || null
  };
}

function publicAmbassador(account) {
  const a = account.application || {};
  return {
    program: 'ambassador',
    code: account.code,
    status: account.status,
    email: account.email,
    name: account.name || '',
    discount: Number(account.discount || 0),
    reward: Number(account.reward || 0),
    ...publicWallet(account),
    application: account.application ? { name: a.name, situation: a.situation, organisation: a.organisation || '', link: a.link || '', requestedCode: a.requestedCode || '', submittedAt: a.submittedAt || null } : null,
    createdAt: account.createdAt || null,
    approvedAt: account.approvedAt || null
  };
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// An amount set by the team: 0 to MAX_AMOUNT euros, cents allowed. Null when invalid.
function amountOf(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.round(Number(String(value).replace(',', '.')) * 100) / 100;
  return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT ? n : null;
}

async function newBalancePromoCode() {
  let code;
  do {
    code = 'SOLDE';
    for (const byte of crypto.randomBytes(6)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  } while (await kv.get(`promo:${code}`));
  return code;
}

// Public check of a code typed at checkout: whether it works and what it takes off, nothing about its owner.
async function lookupCode(raw) {
  const code = ambassadors.normalizeCode(raw);
  if (!code) return null;
  const referral = await getReferral(code);
  if (referral && typeof referral === 'object' && isActive(referral)) {
    return { code, valid: true, kind: 'referral', discount: REWARD };
  }
  const account = await ambassadors.getAmbassadorByCode(code);
  if (ambassadors.isActive(account) && account.code === code) {
    return { code, valid: true, kind: 'ambassador', discount: Number(account.discount || 0) };
  }
  return null;
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
            // A referral or ambassador code typed in the wrong field: the checkout moves it.
            const other = await lookupCode(code);
            return res.status(404).json({ error: 'Code promo invalide', kind: other ? other.kind : null });
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
        if (await kv.get(`ambassador-code:${finalCode}`) || await getReferral(finalCode)) {
          return res.status(400).json({ error: 'Ce code est déjà utilisé par un ambassadeur ou un parrain' });
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

    // ============ PARRAINAGE (clients) ET AMBASSADEURS ============
    if (type === 'referral' || type === 'ambassador') {
      const program = type;
      const action = req.query.action;
      const body = req.body || {};

      if (req.method === 'GET') {
        if (req.query.code) {
          const found = await lookupCode(req.query.code);
          if (!found) return res.status(404).json({ error: 'Code invalide' });
          return res.status(200).json(found);
        }

        // The owner's page: only after the emailed code was confirmed.
        if (req.query.me || req.query.email) {
          const sessionEmail = referralAuth.readSession(req);
          if (!sessionEmail) return res.status(401).json({ error: 'auth_required' });
          if (program === 'ambassador') {
            const account = await ambassadors.getAmbassador(sessionEmail);
            if (!account) return res.status(404).json({ error: 'not_found', email: sessionEmail });
            return res.status(200).json(publicAmbassador(account));
          }
          const own = await codeForEmail(sessionEmail);
          const referral = own ? await getReferral(own) : null;
          if (!referral || typeof referral !== 'object') return res.status(404).json({ error: 'not_found', email: sessionEmail });
          return res.status(200).json(publicReferral(own, referral));
        }

        if (isAdmin) {
          if (program === 'ambassador') {
            const list = await ambassadors.listAmbassadors();
            list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
            return res.status(200).json({ ambassadors: list });
          }
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
        if (action === 'send_code' || action === 'verify_code') {
          const rate = checkCodeRate(req);
          if (!rate.allowed) {
            return res.status(429).json({ error: 'too_many_requests', retryAfter: rate.retryAfter });
          }
        }

        // Step 1: email a 6-digit code. Anyone can ask: owners to open their page,
        // other people to apply as an ambassador.
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
          const otp = referralAuth.newCode();
          await kv.set(key, JSON.stringify({
            hash: referralAuth.hashCode(email, otp),
            expiresAt: now + referralAuth.CODE_TTL_MS,
            attempts: 0,
            sends: sends.concat([now])
          }));
          const language = LANGS.includes(body.lang) ? body.lang : await ownerLanguage(program, email);
          await sendEmail({ to: email, ...customerEmails.accessCode({ program, language, code: otp }) });
          return res.status(200).json({ success: true });
        }

        // Step 2: check the code and open a 2-hour session (valid on both pages).
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

        // Ambassador application. No order needed; the proposed code is reserved but
        // gives nothing until the team accepts it.
        if (action === 'apply' && program === 'ambassador') {
          const email = referralAuth.readSession(req);
          if (!email) return res.status(401).json({ error: 'auth_required' });
          if (await ambassadors.getAmbassador(email)) return res.status(409).json({ error: 'already_exists' });

          const name = clean(body.name, 80);
          const situation = SITUATIONS.includes(body.situation) ? body.situation : '';
          if (name.length < 2 || !situation) return res.status(400).json({ error: 'missing_fields' });
          const check = await ambassadors.checkCode(body.code, email);
          if (!check.ok) return res.status(400).json({ error: check.error });

          const now = new Date().toISOString();
          const account = {
            email,
            name,
            code: null,
            status: 'pending',
            discount: ambassadors.DEFAULT_DISCOUNT,
            reward: ambassadors.DEFAULT_REWARD,
            language: LANGS.includes(body.lang) ? body.lang : 'fr',
            application: {
              name,
              situation,
              organisation: clean(body.organisation, 120),
              link: clean(body.link, 200),
              message: String(body.message || '').trim().slice(0, 600),
              requestedCode: check.code,
              submittedAt: now
            },
            pendingBalance: 0,
            referrals: [],
            referralCount: 0,
            transferRequests: [],
            balanceCodes: [],
            createdAt: now
          };
          await ambassadors.setCode(account, check.code);
          await ambassadors.saveAmbassador(account);
          await Promise.allSettled([
            sendEmail({ to: email, ...customerEmails.ambassadorApplicationReceived({ language: account.language, name, code: check.code }) }),
            alertTeamApplication(account)
          ]);
          return res.status(201).json(publicAmbassador(account));
        }

        // Rewards come from paid orders (api/update-order.js); this old public route is closed.
        if (action === 'use') {
          return res.status(410).json({ error: 'Route retirée : la récompense est attribuée au paiement de la commande.' });
        }

        return res.status(400).json({ error: 'Action inconnue' });
      }

      if (req.method === 'PUT') {
        // Team: accept or refuse an ambassador application, with the final code and amounts.
        if (action === 'review' && program === 'ambassador') {
          if (!isAdmin) return res.status(401).json({ error: 'Non autorisé' });
          const account = await ambassadors.getAmbassador(body.email);
          if (!account) return res.status(404).json({ error: 'Ambassadeur introuvable' });
          if (!['pending', 'rejected'].includes(account.status)) return res.status(400).json({ error: 'already_reviewed' });

          if (body.decision === 'approve') {
            const check = await ambassadors.checkCode(body.code || account.code, account.email);
            if (!check.ok) return res.status(400).json({ error: check.error });
            const discount = amountOf(body.discount, account.discount);
            const reward = amountOf(body.reward, account.reward);
            if (discount === null || reward === null) return res.status(400).json({ error: 'invalid_amount' });
            await ambassadors.setCode(account, check.code);
            account.discount = discount;
            account.reward = reward;
            account.status = 'active';
            account.approvedAt = new Date().toISOString();
            await ambassadors.saveAmbassador(account);
            await sendEmail({ to: account.email, ...customerEmails.ambassadorApproved({ language: account.language, name: account.name, code: account.code, discount, reward }) });
          } else if (body.decision === 'reject') {
            if (account.code) await kv.del(`ambassador-code:${account.code}`);
            account.status = 'rejected';
            account.rejectedAt = new Date().toISOString();
            await ambassadors.saveAmbassador(account);
            await sendEmail({ to: account.email, ...customerEmails.ambassadorRejected({ language: account.language, name: account.name }) });
          } else {
            return res.status(400).json({ error: 'Décision invalide' });
          }
          return res.status(200).json({ success: true, ambassador: account });
        }

        // Team: change the code or the amounts of an accepted ambassador, pause or resume the code.
        if (action === 'settings' && program === 'ambassador') {
          if (!isAdmin) return res.status(401).json({ error: 'Non autorisé' });
          const account = await ambassadors.getAmbassador(body.email);
          if (!account) return res.status(404).json({ error: 'Ambassadeur introuvable' });
          if (!['active', 'paused'].includes(account.status)) return res.status(400).json({ error: 'not_reviewed' });

          const before = { code: account.code, discount: Number(account.discount), reward: Number(account.reward), status: account.status };
          let code = account.code;
          if (body.code !== undefined && ambassadors.normalizeCode(body.code) !== account.code) {
            const check = await ambassadors.checkCode(body.code, account.email);
            if (!check.ok) return res.status(400).json({ error: check.error });
            code = check.code;
          }
          const discount = amountOf(body.discount, before.discount);
          const reward = amountOf(body.reward, before.reward);
          if (discount === null || reward === null) return res.status(400).json({ error: 'invalid_amount' });
          const status = ['active', 'paused'].includes(body.status) ? body.status : before.status;

          await ambassadors.setCode(account, code);
          account.discount = discount;
          account.reward = reward;
          if (status !== before.status) account[status === 'paused' ? 'pausedAt' : 'resumedAt'] = new Date().toISOString();
          account.status = status;
          account.updatedAt = new Date().toISOString();
          await ambassadors.saveAmbassador(account);

          const changed = code !== before.code || discount !== before.discount || reward !== before.reward;
          let mail = null;
          if (status === 'paused' && before.status !== 'paused') {
            mail = customerEmails.ambassadorPaused({ language: account.language, name: account.name, code });
          } else if (status === 'active' && (changed || before.status === 'paused')) {
            mail = customerEmails.ambassadorApproved({
              language: account.language,
              name: account.name,
              code,
              discount,
              reward,
              variant: before.status === 'paused' ? 'resumed' : 'updated',
              previousCode: before.code
            });
          }
          let emailSent = false;
          if (mail && body.notify !== false) emailSent = !!(await sendEmail({ to: account.email, ...mail })).sent;
          return res.status(200).json({ success: true, emailSent, ambassador: account });
        }

        // Team: the transfer has been made.
        if (action === 'transfer_done') {
          if (!isAdmin) return res.status(401).json({ error: 'Non autorisé' });
          const owner = await loadOwner(program, body);
          const request = owner && (owner.account.transferRequests || []).find(t => t.requestedAt === body.requestedAt && t.status !== 'completed');
          if (!request) return res.status(404).json({ error: 'Demande introuvable' });
          request.status = 'completed';
          request.completedAt = new Date().toISOString();
          await owner.save();
          await sendEmail({ to: owner.email, ...customerEmails.transferSent({ program, language: owner.account.language, amount: request.amount, iban: request.paymentInfo && request.paymentInfo.iban }) });
          return res.status(200).json({ success: true });
        }

        // The owner, signed in with the emailed code.
        const email = referralAuth.readSession(req);
        if (!email) return res.status(401).json({ error: 'auth_required' });
        const owner = await loadOwner(program, { email });
        if (!owner) return res.status(404).json({ error: 'not_found' });
        // A paused ambassador keeps their balance and can still withdraw or use it.
        const allowed = program === 'ambassador' ? ['active', 'paused'].includes(owner.account.status) : isActive(owner.account);
        if (!allowed) return res.status(403).json({ error: 'not_active' });

        const result = await updateWallet(program, owner, body);
        if (result.error) return res.status(400).json({ error: result.error });
        const view = program === 'ambassador' ? publicAmbassador(owner.account) : publicReferral(owner.code, owner.account);
        return res.status(200).json({ success: true, promoCode: result.promoCode, [program]: view });
      }
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (error) {
    console.error('Erreur rewards:', error);
    return res.status(500).json({ error: 'Erreur serveur', details: error.message });
  }
};

async function ownerLanguage(program, email) {
  if (program === 'ambassador') {
    const account = await ambassadors.getAmbassador(email);
    return account && account.language;
  }
  const code = await codeForEmail(email);
  const referral = code ? await getReferral(code) : null;
  return referral && referral.language;
}

// The account behind a referral code (by code or email) or an ambassador (by email), with how to save it.
async function loadOwner(program, { email, code }) {
  if (program === 'ambassador') {
    const account = await ambassadors.getAmbassador(email);
    if (!account) return null;
    return { account, email: account.email, code: account.code, save: () => ambassadors.saveAmbassador(account) };
  }
  const referralCode = code ? String(code).toUpperCase() : await codeForEmail(email);
  const referral = referralCode ? await getReferral(referralCode) : null;
  if (!referral || typeof referral !== 'object') return null;
  return { account: referral, email: referral.referrerEmail || email, code: referralCode, save: () => saveReferral(referralCode, referral) };
}

// Bank details, a transfer of the whole balance (no minimum), or a single-use code worth
// part of the balance. Same rules for both programmes.
async function updateWallet(program, owner, body) {
  const account = owner.account;
  let promoCode = null;

  if (body.paymentInfo) {
    const iban = String(body.paymentInfo.iban || '').replace(/\s+/g, '').toUpperCase();
    const accountName = clean(body.paymentInfo.accountName, 120);
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) || !accountName) return { error: 'invalid_bank_details' };
    account.paymentInfo = { iban, accountName };
  }

  if (body.requestTransfer) {
    const amount = Number(account.pendingBalance || 0);
    if (!(amount > 0)) return { error: 'empty_balance' };
    if (!account.paymentInfo) return { error: 'missing_bank_details' };
    const request = { amount, requestedAt: new Date().toISOString(), status: 'pending', paymentInfo: account.paymentInfo };
    account.transferRequests = (account.transferRequests || []).concat([request]);
    account.pendingBalance = 0;
    await owner.save();
    await sendTransferRequestEmails({
      program,
      email: owner.email,
      language: account.language,
      code: owner.code,
      amount,
      iban: account.paymentInfo.iban,
      accountName: account.paymentInfo.accountName
    });
  }

  if (body.useBalance) {
    const balance = Number(account.pendingBalance || 0);
    const amount = Math.round(Number(body.amount || balance) * 100) / 100;
    if (!(amount > 0) || amount > balance) return { error: 'invalid_amount' };
    promoCode = await newBalancePromoCode();
    const now = new Date().toISOString();
    await kv.set(`promo:${promoCode}`, {
      type: 'fixed',
      value: amount,
      description: program === 'ambassador' ? 'Solde ambassadeur' : 'Solde de parrainage',
      ownerEmail: owner.email,
      maxUses: 1,
      usedCount: 0,
      minAmount: 0,
      expiresAt: null,
      applicablePlans: 'all',
      active: true,
      createdAt: now,
      usageHistory: [],
      referralCode: owner.code,
      referralType: 'balance',
      program
    });
    account.pendingBalance = Math.round((balance - amount) * 100) / 100;
    account.balanceCodes = (account.balanceCodes || []).concat([{ code: promoCode, amount, createdAt: now }]);
    await owner.save();
    await sendEmail({ to: owner.email, ...customerEmails.balanceCode({ program, language: account.language, promoCode, amount, balanceLeft: account.pendingBalance }) });
  }

  if (body.paymentInfo && !body.requestTransfer && !body.useBalance) await owner.save();
  return { promoCode };
}

async function alertTeamApplication(account) {
  const a = account.application;
  const situation = SITUATION_LABELS[a.situation] || a.situation;
  const body = renderEmail({
    lang: 'fr',
    title: 'Nouvelle demande d\'ambassadeur',
    preheader: `${a.name} (${situation}) propose le code ${a.requestedCode}.`,
    signature: false,
    footer: 'Notification interne Kareer.',
    blocks: [
      { type: 'p', text: 'Une personne demande à devenir ambassadeur. Son code reste inactif tant que la demande n\'est pas acceptée. Vous pouvez modifier le code, la réduction et le gain avant d\'accepter.' },
      { type: 'details', rows: [
        { label: 'Nom', value: a.name },
        { label: 'E-mail', value: account.email },
        { label: 'Situation', value: situation },
        { label: 'École, entreprise ou activité', value: a.organisation },
        { label: 'Lien', value: a.link },
        { label: 'Code proposé', value: a.requestedCode, mono: true }
      ] },
      a.message ? { type: 'note', title: 'Comment elle compte partager le code', text: a.message } : null,
      { type: 'button', label: 'Accepter ou refuser dans le tableau de bord', href: `${getSiteUrl()}/admin` }
    ]
  });
  await Promise.all([
    sendEmail({ to: adminEmail(), subject: `Demande d'ambassadeur : ${a.name} (${a.requestedCode})`, html: body.html, text: body.text, replyTo: account.email }),
    notifyTelegram(`Demande d'ambassadeur : ${a.name} (${situation}), code ${a.requestedCode}\n${account.email}\n${getSiteUrl()}/admin`)
  ]);
}

// Transfer request: confirmation to the owner, full details to the team.
async function sendTransferRequestEmails(data) {
  await sendEmail({ to: data.email, ...customerEmails.transferRequested(data) });

  const label = data.program === 'ambassador' ? 'ambassadeur' : 'parrainage';
  const amount = `${data.amount} €`;
  const body = renderEmail({
    lang: 'fr',
    title: `Demande de virement ${label}`,
    preheader: `${data.email} demande ${amount}.`,
    signature: false,
    footer: 'Notification interne Kareer.',
    blocks: [
      { type: 'p', text: `${data.email} demande le virement de son solde ${label}.` },
      { type: 'details', rows: [
        { label: data.program === 'ambassador' ? 'Ambassadeur' : 'Client', value: data.email },
        { label: 'Code', value: data.code, mono: true },
        { label: 'Montant', value: amount },
        { label: 'Titulaire', value: data.accountName },
        { label: 'IBAN', value: data.iban, mono: true }
      ] },
      { type: 'note', tone: 'highlight', title: 'Avant de virer', text: 'La demande vient d\'une session ouverte avec un code envoyé à cette adresse. Vérifiez que le titulaire du compte correspond bien à la personne.' },
      { type: 'button', label: 'Ouvrir le tableau de bord', href: `${getSiteUrl()}/admin` }
    ]
  });
  await sendEmail({ to: adminEmail(), subject: `Virement ${label} à faire : ${amount} pour ${data.email}`, html: body.html, text: body.text, replyTo: data.email });
}
