const kv = require('./_kv');
const crypto = require('crypto');
const { verifyAdminToken } = require('./_verify-admin');

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
          const key = `referral:email:${email.toLowerCase()}`;
          const codeData = await kv.get(key);
          
          if (!codeData) {
            return res.status(404).json({ error: 'Aucun code de parrainage trouvé' });
          }

          const code = typeof codeData === 'string' ? codeData : codeData.code;
          const referralData = await kv.get(`referral:${code}`);
          const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;

          return res.status(200).json({
            code,
            ...referral
          });
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
        const { action, referrerEmail, referrerName, refereeEmail, refereeName, code } = req.body;

        if (action === 'create') {
          if (!referrerEmail) {
            return res.status(400).json({ error: 'Email requis' });
          }

          const emailKey = `referral:email:${referrerEmail.toLowerCase()}`;
          const existingCode = await kv.get(emailKey);
          
          if (existingCode) {
            const code = typeof existingCode === 'string' ? existingCode : existingCode.code;
            const referralData = await kv.get(`referral:${code}`);
            const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;
            
            return res.status(200).json({
              code,
              ...referral,
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
          if (!code || !refereeEmail) {
            return res.status(400).json({ error: 'Code et email requis' });
          }

          const referralData = await kv.get(`referral:${code.toUpperCase()}`);
          
          if (!referralData) {
            return res.status(404).json({ error: 'Code de parrainage invalide' });
          }

          const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;

          if (referral.referrerEmail.toLowerCase() === refereeEmail.toLowerCase()) {
            return res.status(400).json({ error: 'Vous ne pouvez pas utiliser votre propre code' });
          }

          const alreadyUsed = referral.referrals?.some(r => r.email.toLowerCase() === refereeEmail.toLowerCase());
          if (alreadyUsed) {
            return res.status(400).json({ error: 'Vous avez déjà utilisé ce code' });
          }

          if (!referral.referrals) {
            referral.referrals = [];
          }
          referral.referrals.push({
            email: refereeEmail.toLowerCase(),
            name: refereeName || refereeEmail,
            usedAt: new Date().toISOString()
          });

          referral.referralCount = (referral.referralCount || 0) + 1;
          referral.lastReferralAt = new Date().toISOString();

          await kv.set(`referral:${code.toUpperCase()}`, referral);

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

          const refereePromoCode = 'FILLEUL' + crypto.randomBytes(4).toString('hex').toUpperCase();
          await kv.set(`promo:${refereePromoCode}`, {
            type: 'fixed',
            value: 10,
            description: `Bienvenue via parrainage de ${referral.referrerName || referral.referrerEmail}`,
            maxUses: 1,
            expiresAt: null,
            minAmount: 0,
            applicablePlans: 'all',
            active: true,
            usedCount: 0,
            createdAt: new Date().toISOString(),
            usageHistory: [],
            referralCode: code.toUpperCase(),
            referralType: 'referee'
          });

          await sendReferralEmails({
            referrerEmail: referral.referrerEmail,
            referrerName: referral.referrerName,
            referrerPromoCode,
            referrerMode: referral.rewardMode,
            referrerBalance: referral.pendingBalance,
            refereeEmail,
            refereeName,
            refereePromoCode,
            referralCode: code.toUpperCase()
          });

          return res.status(200).json({
            success: true,
            referrerPromoCode,
            refereePromoCode,
            message: 'Parrainage enregistré ! Vous et votre parrain recevez chacun 10€ de réduction.'
          });
        }
      }

      // PUT - Mettre à jour les préférences de récompense
      if (req.method === 'PUT') {
        const { email, rewardMode, paymentInfo, requestTransfer } = req.body;

        if (!email) {
          return res.status(400).json({ error: 'Email requis' });
        }

        const key = `referral:email:${email.toLowerCase()}`;
        const codeData = await kv.get(key);
        
        if (!codeData) {
          return res.status(404).json({ error: 'Code de parrainage non trouvé' });
        }

        const code = typeof codeData === 'string' ? codeData : codeData.code;
        const referralData = await kv.get(`referral:${code}`);
        const referral = typeof referralData === 'string' ? JSON.parse(referralData) : referralData;

        if (rewardMode) {
          referral.rewardMode = rewardMode;
        }

        if (paymentInfo) {
          referral.paymentInfo = paymentInfo;
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
            referrerEmail: email,
            amount: referral.pendingBalance,
            iban: referral.paymentInfo.iban,
            accountName: referral.paymentInfo.accountName
          });
          
          referral.pendingBalance = 0;
        }

        await kv.set(key, referral);

        return res.status(200).json({
          success: true,
          rewardMode: referral.rewardMode,
          pendingBalance: referral.pendingBalance,
          transferRequests: referral.transferRequests || []
        });
      }
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (error) {
    console.error('Erreur rewards:', error);
    return res.status(500).json({ error: 'Erreur serveur', details: error.message });
  }
};

// Fonction pour envoyer les emails de parrainage
async function sendReferralEmails(data) {
  if (!process.env.RESEND_API_KEY) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';
    const { buildEmailHtml } = require('./_email');

    if (data.referrerEmail) {
      const referrerContent = data.referrerMode === 'transfer' 
        ? `
          <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px">
            Bonne nouvelle ! <strong>${data.refereeName || data.refereeEmail}</strong> a utilisé votre code de parrainage <strong>${data.referralCode}</strong>.
          </p>
          <div style="background:linear-gradient(135deg, rgba(21,101,192,0.1), rgba(139,92,246,0.1));border-radius:12px;padding:24px;margin:24px 0;text-align:center">
            <div style="font-size:14px;color:#64748b;margin-bottom:8px">💰 Votre nouveau solde</div>
            <div style="font-size:2.5rem;font-weight:800;background:linear-gradient(135deg, #1565C0, #8B5CF6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${data.referrerBalance}€</div>
            <div style="font-size:13px;color:#64748b;margin-top:8px">+10€ ajoutés à votre solde</div>
          </div>
          <p style="color:#64748b;font-size:14px;line-height:1.6;margin:20px 0">
            Vous pouvez demander un virement dès que vous le souhaitez depuis votre page de parrainage.
          </p>
          <div style="text-align:center;margin-top:28px">
            <a href="${siteUrl}/parrainage.html" style="background:linear-gradient(135deg, #1565C0, #8B5CF6);color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">
              💸 Gérer mes gains
            </a>
          </div>
        `
        : `
          <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px">
            Bonne nouvelle ! <strong>${data.refereeName || data.refereeEmail}</strong> a utilisé votre code de parrainage <strong>${data.referralCode}</strong>.
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
          <div style="text-align:center;margin-top:28px">
            <a href="${siteUrl}/#pricing" style="background:linear-gradient(135deg, #1565C0, #8B5CF6);color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">
              🛒 Commander maintenant
            </a>
          </div>
        `;

      await resend.emails.send({
        from: 'Kareer <notifications@kareer.pro>',
        to: data.referrerEmail,
        subject: '🎉 Nouveau parrainage réussi ! Votre récompense est prête',
        html: buildEmailHtml({
          siteUrl,
          headerColor: '#10b981',
          title: '🎉 Parrainage réussi !',
          preheader: 'Votre ami a utilisé votre code de parrainage',
          content: referrerContent
        })
      });
    }

    if (data.refereeEmail) {
      const refereeContent = `
        <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px">
          Bienvenue chez Kareer ! Grâce au code de parrainage de <strong>${data.referrerName || 'votre ami'}</strong>, vous bénéficiez d'une réduction exclusive.
        </p>
        <div style="background:#f0f9ff;border:2px solid #7dd3fc;border-radius:12px;padding:24px;margin:24px 0;text-align:center">
          <div style="font-size:14px;color:#0369a1;margin-bottom:12px">🎁 Votre code promo de bienvenue</div>
          <div style="background:#fff;border:2px dashed #7dd3fc;border-radius:8px;padding:16px;margin:12px 0">
            <div style="font-size:24px;font-weight:800;letter-spacing:3px;color:#0284c7;font-family:monospace">${data.refereePromoCode}</div>
          </div>
          <div style="font-size:15px;color:#0284c7;font-weight:600;margin-top:12px">Valeur : 10€ de réduction</div>
        </div>
        <p style="color:#64748b;font-size:14px;line-height:1.6;margin:20px 0">
          Ce code est valable sur votre première commande. Profitez-en pour découvrir LinkedIn Premium à prix réduit !
        </p>
        <div style="background:rgba(21,101,192,0.05);border-radius:8px;padding:16px;margin:20px 0">
          <p style="margin:6px 0;color:#333;font-size:14px">✅ Activation en 24-48h</p>
          <p style="margin:6px 0;color:#333;font-size:14px">💬 Support WhatsApp dédié</p>
          <p style="margin:6px 0;color:#333;font-size:14px">🔒 Paiement 100% sécurisé</p>
        </div>
        <div style="text-align:center;margin-top:28px">
          <a href="${siteUrl}/#pricing" style="background:linear-gradient(135deg, #1565C0, #8B5CF6);color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">
            🚀 Découvrir nos offres
          </a>
        </div>
      `;

      await resend.emails.send({
        from: 'Kareer <notifications@kareer.pro>',
        to: data.refereeEmail,
        subject: '🎁 Votre code promo de 10€ vous attend !',
        html: buildEmailHtml({
          siteUrl,
          headerColor: '#0284c7',
          title: 'Bienvenue chez Kareer !',
          preheader: 'Votre réduction de 10€ est prête',
          content: refereeContent
        })
      });
    }
  } catch (error) {
    console.error('Erreur envoi emails parrainage:', error.message);
  }
}

// Fonction pour envoyer les emails de demande de virement
async function sendTransferRequestEmails(data) {
  if (!process.env.RESEND_API_KEY) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const siteUrl = process.env.SITE_URL || 'https://kareer.pro';
    const { buildEmailHtml } = require('./_email');
    const adminEmail = process.env.ADMIN_EMAIL || 'arabiimad03@gmail.com';

    const clientContent = `
      <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px">
        Votre demande de virement a bien été enregistrée. Nous allons la traiter dans les plus brefs délais.
      </p>
      <div style="background:linear-gradient(135deg, rgba(21,101,192,0.1), rgba(139,92,246,0.1));border-radius:12px;padding:24px;margin:24px 0">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px">Montant demandé</td>
            <td style="padding:10px 0;text-align:right;font-size:20px;font-weight:800;color:#1565C0">${data.amount}€</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px;border-top:1px solid rgba(0,0,0,0.1)">IBAN</td>
            <td style="padding:10px 0;text-align:right;font-family:monospace;font-size:13px;border-top:1px solid rgba(0,0,0,0.1)">${data.iban.substring(0, 10)}...</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px;border-top:1px solid rgba(0,0,0,0.1)">Titulaire</td>
            <td style="padding:10px 0;text-align:right;font-size:14px;border-top:1px solid rgba(0,0,0,0.1)">${data.accountName}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px;border-top:1px solid rgba(0,0,0,0.1)">Statut</td>
            <td style="padding:10px 0;text-align:right;font-size:14px;color:#f59e0b;font-weight:600;border-top:1px solid rgba(0,0,0,0.1)">⏳ En attente</td>
          </tr>
        </table>
      </div>
      <p style="color:#64748b;font-size:14px;line-height:1.6;margin:20px 0">
        <strong>Délai de traitement :</strong> 24-48 heures ouvrées<br>
        Vous recevrez un email de confirmation dès que le virement sera effectué.
      </p>
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:6px;margin:20px 0">
        <p style="margin:0;color:#92400e;font-size:13px">
          💡 <strong>Astuce :</strong> Continuez à parrainer vos amis pour augmenter vos gains !
        </p>
      </div>
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: data.referrerEmail,
      subject: '💸 Demande de virement enregistrée',
      html: buildEmailHtml({
        siteUrl,
        headerColor: '#f59e0b',
        title: 'Demande de virement reçue',
        preheader: `Votre demande de ${data.amount}€ est en cours de traitement`,
        content: clientContent
      })
    });

    const adminContent = `
      <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px">
        Une nouvelle demande de virement de parrainage a été effectuée.
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin:24px 0">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px;font-weight:600">Client</td>
            <td style="padding:10px 0;text-align:right;font-size:14px">${data.referrerEmail}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px;font-weight:600;border-top:1px solid #e2e8f0">Montant</td>
            <td style="padding:10px 0;text-align:right;font-size:20px;font-weight:800;color:#10b981;border-top:1px solid #e2e8f0">${data.amount}€</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px;font-weight:600;border-top:1px solid #e2e8f0">IBAN</td>
            <td style="padding:10px 0;text-align:right;font-family:monospace;font-size:13px;border-top:1px solid #e2e8f0">${data.iban}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px;font-weight:600;border-top:1px solid #e2e8f0">Titulaire</td>
            <td style="padding:10px 0;text-align:right;font-size:14px;border-top:1px solid #e2e8f0">${data.accountName}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#64748b;font-size:14px;font-weight:600;border-top:1px solid #e2e8f0">Date</td>
            <td style="padding:10px 0;text-align:right;font-size:14px;border-top:1px solid #e2e8f0">${new Date().toLocaleDateString('fr-FR')}</td>
          </tr>
        </table>
      </div>
      <div style="text-align:center;margin-top:28px">
        <a href="${siteUrl}/admin" style="background:#1565C0;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">
          📊 Voir dans l'admin
        </a>
      </div>
    `;

    await resend.emails.send({
      from: 'Kareer <notifications@kareer.pro>',
      to: adminEmail,
      subject: `💸 Nouvelle demande de virement — ${data.amount}€`,
      html: buildEmailHtml({
        siteUrl,
        headerColor: '#f59e0b',
        title: 'Demande de virement',
        preheader: `${data.referrerEmail} demande un virement de ${data.amount}€`,
        content: adminContent
      })
    });
  } catch (error) {
    console.error('Erreur envoi emails virement:', error.message);
  }
}
