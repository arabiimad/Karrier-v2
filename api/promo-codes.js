const kv = require('./_kv');
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { isAdmin, error } = verifyAdminToken(req);
  
  console.log('[promo-codes]', req.method, 'isAdmin:', isAdmin, 'error:', error);
  console.log('[promo-codes] Authorization header:', req.headers.authorization ? 'Present' : 'Missing');

  try {
    // GET - Liste ou validation
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

    // POST - Créer ou utiliser un code
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

        // Calculer la réduction
        let discount = 0;
        if (promo.type === 'percentage') {
          discount = Math.round((amount * promo.value) / 100);
        } else if (promo.type === 'fixed') {
          discount = promo.value;
        }
        discount = Math.min(discount, amount);

        // Incrémenter le compteur
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
        type,
        value,
        description,
        maxUses,
        expiresAt,
        minAmount,
        applicablePlans,
        autoGenerate
      } = req.body;

      if (!type || !value) {
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
        type,
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

    return res.status(405).json({ error: 'Méthode non autorisée' });

  } catch (error) {
    console.error('Erreur promo-codes:', error);
    return res.status(500).json({ error: 'Erreur serveur', details: error.message });
  }
};
