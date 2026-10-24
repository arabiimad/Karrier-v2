const kv = require('./_kv');
const crypto = require('crypto');
const { verifyAdminToken } = require('./_verify-admin');
const { adminEmail, getSiteUrl, renderEmail, sendEmail } = require('./_email');
const customerEmails = require('./_customer-emails');
const rateLimit = require('./_rate-limit');
const referralAuth = require('./_referral-auth');
const checkCodeRate = rateLimit({ windowMs: 10 * 60 * 1000, max: 8 });

function parseValue(data) {
  if (!data) return null;
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch (e) { return data; }
}

// referral:email:<email> should hold a code. An old bug stored the whole referral there;
// find the real code again and repair the mapping.
async function codeForEmail(email) {
  const key = `referral:email:${String(email || '').toLowerCase()}`;
  const value = parseValue(await kv.get(key));
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.code) return value.code;
  const keys = await kv.keys('referral:REF*');
  for (const refKey of keys) {
    const referral = parseValue(await kv.get(refKey));
    if (referral && String(referral.referrerEmail || '').toLowerCase() === String(email).toLowerCase()) {
      const code = refKey.replace('referral:', '');
      await kv.set(key, code);
      return code;
    }
  }
  return null;
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${name.charAt(0)}•••@${domain}`;
}

// What the owner sees: IBAN masked, referred people reduced to a masked email.
function publicReferral(code, referral) {
  const copy = { code, ...referral };
  copy.referrals = (referral.referrals || []).map(r => ({
    who: maskEmail(r.email),
    usedAt: r.usedAt || null,
    promoCode: r.referrerPromoCode || null
  }));
  if (copy.paymentInfo) {
    copy.paymentInfo = {
      accountName: copy.paymentInfo.accountName || '',
      ibanMasked: customerEmails.maskIban(copy.paymentInfo.iban)
    };
  }
  (copy.transferRequests || []).forEach(request => {
    if (request.paymentInfo) request.paymentInfo = { accountName: request.paymentInfo.accountName, ibanMasked: customerEmails.maskIban(request.paymentInfo.iban) };
  });
  return copy;
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

// Générer un code de parrainage unique
function generateReferralCode(email) {
  const hash = crypto.createHash('md5').update(email + Date.now()).digest('hex');
  return 'REF' + hash.substring(0, 8).toUpperCase();
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
            description: promo.description,
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
      // GET - Récupérer les infos de parrainage
      if (req.method === 'GET') {
        const { code, email } = req.query;

        // Public check of a code: says whether it exists, nothing about its owner.
        if (code) {
          const referralData = await kv.get(`referral:${code.toUpperCase()}`);
          if (!referralData) {
            return res.status(404).json({ error: 'Code de parrainage invalide' });
          }
          return res.status(200).json({ code: code.toUpperCase(), valid: true });
        }

        // The owner's page: only after the emailed code was confirmed.
        const sessionEmail = referralAuth.readSession(req);
        if (email || req.query.me) {
          if (!sessionEmail) {
            return res.status(401).json({ error: 'auth_required' });
          }
          const code = await codeForEmail(sessionEmail);
          const referral = code ? parseValue(await kv.get(`referral:${code}`)) : null;
          if (!referral) {
            return res.status(404).json({ error: 'Aucun code de parrainage trouvé' });
          }
          return res.status(200).json(publicReferral(code, referral));
        }

        if (isAdmin) {
          const keys = await kv.keys('referral:REF*');
          const referrals = [];
          
          for (const key of keys) {
            const data = await kv.get(key);
            const referral = typeof data === 'string' ? JSON.parse(data) : data;
            referrals.push({
              code: key.replace('referral:', ''),
              ...referral
            });
          }

          return res.status(200).json({ referrals });
        }

        return res.status(400).json({ error: 'Paramètres manquants' });
      }

      // POST - Connexion par code, création du code de parrainage
      if (req.method === 'POST') {
        const { action } = req.query;
        const body = req.body || {};

        if (action === 'send_code' || action === 'verify_code') {
          const rate = checkCodeRate(req);
          if (!rate.allowed) {
            return res.status(429).json({ error: 'too_many_requests', retryAfter: rate.retryAfter });
          }
        }

        // Step 1: email a 6-digit code. The answer is the same whether or not the
        // address has a referral page, so nobody can test which emails are customers.
        if (action === 'send_code') {
          const email = referralAuth.normalizeEmail(body.email);
          if (!email) return res.status(400).json({ error: 'invalid_email' });

          const code = await codeForEmail(email);
          const referral = code ? parseValue(await kv.get(`referral:${code}`)) : null;
          if (referral) {
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
            await sendEmail({ to: email, ...customerEmails.referralAccessCode({ language: body.lang || referral.language, code: otp }) });
          }
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

        // Rewards are granted when the referred order is activated (api/update-order.js).
        // The old public route let anyone add rewards without an order, so it is closed.
        if (action === 'use') {
          return res.status(410).json({ error: 'Route retirée : la récompense est attribuée à l\'activation de la commande.' });
        }

        const sessionEmail = referralAuth.readSession(req);
        const referrerEmail = sessionEmail;
        const referrerName = body.referrerName;

        if (action === 'create') {
          if (!referrerEmail) {
            return res.status(401).json({ error: 'auth_required' });
          }

          const emailKey = `referral:email:${referrerEmail.toLowerCase()}`;
          const existingCode = await codeForEmail(referrerEmail);
          const existingReferral = existingCode ? parseValue(await kv.get(`referral:${existingCode}`)) : null;

          if (existingReferral) {
            return res.status(200).json({
              ...publicReferral(existingCode, existingReferral),
              alreadyExists: true
            });
          }

          const newCode = generateReferralCode(referrerEmail);
          const referralData = {
            referrerEmail: referrerEmail.toLowerCase(),
            referrerName: referrerName || referrerEmail,
            referralCount: 0,
            createdAt: new Date().toISOString(),
            referrals: [],
            rewardMode: 'promo',
            pendingBalance: 0,
            transferRequests: []
          };

          await kv.set(`referral:${newCode}`, referralData);
          await kv.set(emailKey, newCode);

          return res.status(201).json({
            code: newCode,
            ...referralData
          });
        }

      }

      // PUT - Mettre à jour les préférences de récompense
      if (req.method === 'PUT') {
        const { rewardMode, paymentInfo, requestTransfer } = req.body || {};
        const email = referralAuth.readSession(req);
        if (!email) {
          return res.status(401).json({ error: 'auth_required' });
        }

        const code = await codeForEmail(email);
        const referral = code ? parseValue(await kv.get(`referral:${code}`)) : null;
        if (!referral) {
          return res.status(404).json({ error: 'Code de parrainage non trouvé' });
        }

        if (rewardMode) {
          // The referral page calls the promo mode "discount".
          const mode = rewardMode === 'discount' ? 'promo' : rewardMode;
          if (!['promo', 'transfer'].includes(mode)) {
            return res.status(400).json({ error: 'Mode de récompense invalide' });
          }
          referral.rewardMode = mode;
        }

        if (paymentInfo) {
          const iban = String(paymentInfo.iban || '').replace(/\s+/g, '').toUpperCase();
          const accountName = String(paymentInfo.accountName || '').trim().slice(0, 120);
          if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) || !accountName) {
            return res.status(400).json({ error: 'IBAN ou titulaire invalide' });
          }
          referral.paymentInfo = { iban, accountName };
        }

        if (requestTransfer && referral.pendingBalance > 0) {
          if (!referral.paymentInfo) {
            return res.status(400).json({ error: 'Informations de paiement requises' });
          }

          const transferRequest = {
            amount: referral.pendingBalance,
            requestedAt: new Date().toISOString(),
            status: 'pending',
            paymentInfo: referral.paymentInfo
          };

          referral.transferRequests = referral.transferRequests || [];
          referral.transferRequests.push(transferRequest);
          
          await sendTransferRequestEmails({
            referrerEmail: referral.referrerEmail || email,
            language: referral.language,
            code,
            amount: referral.pendingBalance,
            iban: referral.paymentInfo.iban,
            accountName: referral.paymentInfo.accountName
          });
          
          // IMPORTANT : Demander un virement réinitialise le solde de parrainage à 0
          referral.pendingBalance = 0;
        }

        await kv.set(`referral:${code}`, referral);

        return res.status(200).json({
          success: true,
          rewardMode: referral.rewardMode,
          pendingBalance: referral.pendingBalance,
          transferRequests: publicReferral(code, referral).transferRequests || []
        });
      }
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (error) {
    console.error('Erreur rewards:', error);
    return res.status(500).json({ error: 'Erreur serveur', details: error.message });
  }
};

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
