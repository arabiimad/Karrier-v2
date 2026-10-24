const kv = require('./_kv');
const crypto = require('crypto');
const { verifyAdminToken } = require('./_verify-admin');
const { adminEmail, getSiteUrl, renderEmail, sendEmail } = require('./_email');
const customerEmails = require('./_customer-emails');

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

function publicReferral(code, referral) {
  const copy = { code, ...referral };
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

        // Utiliser un code promo (public)
        if (action === 'use') {
          const { code, orderId, amount } = req.body;

          if (!code || !orderId || !amount) {
            return res.status(400).json({ error: 'Paramètres manquants' });
          }

          const promoData = await kv.get(`promo:${code.toUpperCase()}`);
          
          if (!promoData) {
            return res.status(400).json({ error: 'Code promo invalide' });
          }

          const promo = typeof promoData === 'string' ? JSON.parse(promoData) : promoData;

          if (!promo.active) {
            return res.status(400).json({ error: 'Code promo invalide' });
          }

          if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
            return res.status(400).json({ error: 'Code promo expiré' });
          }

          if (promo.maxUses && promo.usedCount >= promo.maxUses) {
            return res.status(400).json({ error: 'Code promo épuisé' });
          }

          if (promo.minAmount && amount < promo.minAmount) {
            return res.status(400).json({ 
              error: `Montant minimum requis: ${promo.minAmount}€` 
            });
          }

          let discount = 0;
          if (promo.type === 'percentage') {
            discount = Math.round((amount * promo.value) / 100);
          } else if (promo.type === 'fixed') {
            discount = promo.value;
          }
          discount = Math.min(discount, amount);

          promo.usedCount = (promo.usedCount || 0) + 1;
          promo.lastUsedAt = new Date().toISOString();
          
          if (!promo.usageHistory) {
            promo.usageHistory = [];
          }
          promo.usageHistory.push({
            orderId,
            amount,
            discount,
            usedAt: new Date().toISOString()
          });

          await kv.set(`promo:${code.toUpperCase()}`, promo);

          return res.status(200).json({
            success: true,
            discount,
            newAmount: amount - discount
          });
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

        if (code) {
          const referralData = await kv.get(`referral:${code.toUpperCase()}`);
          
          if (!referralData) {
            return res.status(404).json({ error: 'Code de parrainage invalide' });
          }

          const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;

          return res.status(200).json({
            code: code.toUpperCase(),
            referrerEmail: referral.referrerEmail,
            referrerName: referral.referrerName,
            referralCount: referral.referralCount || 0
          });
        }

        if (email) {
          const code = await codeForEmail(email);
          const referral = code ? parseValue(await kv.get(`referral:${code}`)) : null;
          if (!referral) {
            return res.status(404).json({ error: 'Aucun code de parrainage trouvé' });
          }
          // The IBAN is never sent back in full: anyone can type an email address here.
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

      // POST - Créer ou utiliser un code de parrainage
      if (req.method === 'POST') {
        const { action } = req.query;
        const { referrerEmail, referrerName, refereeEmail, refereeName, code } = req.body;

        if (action === 'create') {
          if (!referrerEmail) {
            return res.status(400).json({ error: 'Email requis' });
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

        if (action === 'use') {
          console.log('[Referral] Use action - code:', code, 'refereeEmail:', refereeEmail);
          
          if (!code || !refereeEmail) {
            console.log('[Referral] Missing code or email');
            return res.status(400).json({ error: 'Code et email requis' });
          }

          const referralData = await kv.get(`referral:${code.toUpperCase()}`);
          console.log('[Referral] Referral data found:', !!referralData);
          
          if (!referralData) {
            console.log('[Referral] Code not found in KV:', code.toUpperCase());
            return res.status(404).json({ error: 'Code de parrainage invalide' });
          }

          const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;
          console.log('[Referral] Referral structure:', { 
            hasReferrerEmail: !!referral.referrerEmail,
            hasReferrals: !!referral.referrals,
            referralCount: referral.referralCount
          });

          if (referral.referrerEmail.toLowerCase() === refereeEmail.toLowerCase()) {
            console.log('[Referral] Self-referral attempt');
            return res.status(400).json({ error: 'Vous ne pouvez pas utiliser votre propre code' });
          }

          const alreadyUsed = referral.referrals?.some(r => r.email.toLowerCase() === refereeEmail.toLowerCase());
          if (alreadyUsed) {
            console.log('[Referral] Code already used by this email');
            return res.status(400).json({ error: 'Vous avez déjà utilisé ce code' });
          }

          let referrerPromoCode = null;
          
          if (referral.rewardMode === 'transfer') {
            referral.pendingBalance = (referral.pendingBalance || 0) + 10;
          } else {
            referrerPromoCode = 'PARRAIN' + crypto.randomBytes(4).toString('hex').toUpperCase();
            await kv.set(`promo:${referrerPromoCode}`, {
              type: 'fixed',
              value: 10,
              description: `Récompense parrainage de ${refereeName || refereeEmail}`,
              maxUses: 1,
              expiresAt: null,
              minAmount: 0,
              applicablePlans: 'all',
              active: true,
              usedCount: 0,
              createdAt: new Date().toISOString(),
              usageHistory: [],
              referralCode: code.toUpperCase(),
              referralType: 'referrer'
            });
          }

          if (!referral.referrals) {
            referral.referrals = [];
          }
          referral.referrals.push({
            email: refereeEmail.toLowerCase(),
            name: refereeName || refereeEmail,
            usedAt: new Date().toISOString(),
            referrerPromoCode: referrerPromoCode,
            orderId: null // Sera mis à jour quand la commande sera créée
          });

          referral.referralCount = (referral.referralCount || 0) + 1;
          referral.lastReferralAt = new Date().toISOString();

          console.log('[Referral] Saving updated referral - count:', referral.referralCount);
          await kv.set(`referral:${code.toUpperCase()}`, referral);
          console.log('[Referral] Referral saved successfully');

          // Le filleul a déjà reçu sa réduction de 10€ au checkout en utilisant le code de parrainage
          // L'email au parrain sera envoyé quand la commande du filleul passera en statut "done"

          return res.status(200).json({
            success: true,
            referrerPromoCode,
            message: 'Parrainage enregistré ! Votre parrain recevra 10€ de réduction après validation de votre commande.'
          });
        }
      }

      // PUT - Mettre à jour les préférences de récompense
      if (req.method === 'PUT') {
        const { email, rewardMode, paymentInfo, requestTransfer } = req.body;

        if (!email) {
          return res.status(400).json({ error: 'Email requis' });
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
      { type: 'note', tone: 'highlight', title: 'Avant de virer', text: 'La page de parrainage ne demande pas de connexion : n\'importe qui connaissant l\'adresse e-mail peut saisir un IBAN. Confirmez le changement avec le client sur WhatsApp ou par e-mail avant le virement.' },
      { type: 'button', label: 'Ouvrir le tableau de bord', href: `${getSiteUrl()}/admin` }
    ]
  });
  await sendEmail({ to: adminEmail(), subject: `Virement parrainage à faire : ${amount} pour ${data.referrerEmail}`, html: body.html, text: body.text, replyTo: data.referrerEmail });
}
