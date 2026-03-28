require('./_env');
const rateLimit = require('./_rate-limit');
const checkRate = rateLimit({ windowMs: 60000, max: 30 });
const kvStore = require('./_kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const rate = checkRate(req);
  if (!rate.allowed) {
    return res.status(429).json({ error: 'Too many requests', retryAfter: rate.retryAfter });
  }

  const { action, code, amount, session_id } = req.query;

  // ===== Promo Validation =====
  if (action === 'validate-promo') {
    if (!code) return res.status(400).json({ valid: false, error: 'Code manquant' });
    try {
      const promoData = await kvStore.get(`promo:${code.trim().toUpperCase()}`);
      if (!promoData) return res.status(200).json({ valid: false, error: 'Code promo invalide' });
      const promo = typeof promoData === 'string' ? JSON.parse(promoData) : promoData;
      if (!promo.active) return res.status(200).json({ valid: false, error: 'Code promo désactivé' });
      if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return res.status(200).json({ valid: false, error: 'Code promo expiré' });
      if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) return res.status(200).json({ valid: false, error: 'Code promo épuisé' });
      const baseAmount = parseFloat(amount) || 0;
      const finalAmount = Math.max(0, baseAmount - promo.discount);
      return res.status(200).json({ valid: true, discount: promo.discount, code: promo.code, finalAmount, description: promo.description || '' });
    } catch (error) {
      console.error('Promo validation error:', error.message);
      return res.status(500).json({ valid: false, error: 'Erreur interne' });
    }
  }

  // ===== Order Status =====
  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const data = await kvStore.get(`order:${session_id}`);
    if (!data) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = typeof data === 'string' ? JSON.parse(data) : data;

    // Return public fields only — no credentials
    res.status(200).json({
      status: order.status,
      plan: order.plan,
      audience: order.audience,
      amount: order.amount,
      currency: order.currency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    });
  } catch (error) {
    console.error('Order status error:', error.message);
    res.status(500).json({ error: 'Internal error' });
  }
};
