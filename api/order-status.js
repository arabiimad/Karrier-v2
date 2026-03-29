require('./_env');
const { verifyAuth } = require('./_auth');
const rateLimit = require('./_rate-limit');
const checkRate = rateLimit({ windowMs: 60000, max: 30 });
const kvStore = require('./_kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rate = checkRate(req);
  if (!rate.allowed) {
    return res.status(429).json({ error: 'Too many requests', retryAfter: rate.retryAfter });
  }

  const action = req.query.action;

  // ── Public: validate promo code ──────────────────────────────────────────
  if (action === 'validate_promo') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const code = (req.query.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ valid: false, message: 'Code manquant' });

    try {
      const promoData = await kvStore.get('promo:' + code);
      if (!promoData) return res.status(200).json({ valid: false, message: 'Code invalide' });

      const promo = typeof promoData === 'string' ? JSON.parse(promoData) : promoData;

      if (!promo.active) return res.status(200).json({ valid: false, message: 'Code désactivé' });
      if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
        return res.status(200).json({ valid: false, message: 'Code expiré' });
      }
      if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) {
        return res.status(200).json({ valid: false, message: 'Code épuisé' });
      }

      return res.status(200).json({ valid: true, discount: promo.discount, code: promo.code, message: 'Code valide' });
    } catch (e) {
      console.error('validate_promo error:', e.message);
      return res.status(500).json({ valid: false, message: 'Erreur serveur' });
    }
  }

  // ── Admin: create promo code ─────────────────────────────────────────────
  if (action === 'create_promo') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try { verifyAuth(req); } catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }

    const { code, discount, maxUses, description, expiresAt } = req.body || {};
    if (!code || discount == null) return res.status(400).json({ error: 'code and discount required' });

    const promoCode = code.toUpperCase().trim();
    const promoObj = {
      code: promoCode,
      discount: Number(discount),
      maxUses: Number(maxUses) || 0,
      usedCount: 0,
      active: true,
      description: description || '',
      expiresAt: expiresAt || null,
      createdAt: new Date().toISOString()
    };

    try {
      await kvStore.set('promo:' + promoCode, JSON.stringify(promoObj));

      // Update promos index
      const indexData = await kvStore.get('promos:index');
      const index = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
      if (!index.includes(promoCode)) index.push(promoCode);
      await kvStore.set('promos:index', JSON.stringify(index));

      return res.status(200).json({ success: true, promo: promoObj });
    } catch (e) {
      console.error('create_promo error:', e.message);
      return res.status(500).json({ error: 'Failed to create promo' });
    }
  }

  // ── Admin: list promo codes ──────────────────────────────────────────────
  if (action === 'list_promos') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try { verifyAuth(req); } catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }

    try {
      const indexData = await kvStore.get('promos:index');
      const index = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];

      const promos = [];
      for (const code of index) {
        const data = await kvStore.get('promo:' + code);
        if (data) {
          promos.push(typeof data === 'string' ? JSON.parse(data) : data);
        }
      }

      return res.status(200).json({ promos });
    } catch (e) {
      console.error('list_promos error:', e.message);
      return res.status(500).json({ error: 'Failed to list promos' });
    }
  }

  // ── Admin: delete promo code ─────────────────────────────────────────────
  if (action === 'delete_promo') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try { verifyAuth(req); } catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }

    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code required' });

    const promoCode = code.toUpperCase().trim();
    try {
      await kvStore.del('promo:' + promoCode);

      // Remove from index
      const indexData = await kvStore.get('promos:index');
      const index = indexData ? (typeof indexData === 'string' ? JSON.parse(indexData) : indexData) : [];
      const newIndex = index.filter(c => c !== promoCode);
      await kvStore.set('promos:index', JSON.stringify(newIndex));

      return res.status(200).json({ success: true });
    } catch (e) {
      console.error('delete_promo error:', e.message);
      return res.status(500).json({ error: 'Failed to delete promo' });
    }
  }

  // ── Admin: toggle promo active ───────────────────────────────────────────
  if (action === 'toggle_promo') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try { verifyAuth(req); } catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }

    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code required' });

    const promoCode = code.toUpperCase().trim();
    try {
      const promoData = await kvStore.get('promo:' + promoCode);
      if (!promoData) return res.status(404).json({ error: 'Promo not found' });

      const promo = typeof promoData === 'string' ? JSON.parse(promoData) : promoData;
      promo.active = !promo.active;
      await kvStore.set('promo:' + promoCode, JSON.stringify(promo));

      return res.status(200).json({ success: true, active: promo.active });
    } catch (e) {
      console.error('toggle_promo error:', e.message);
      return res.status(500).json({ error: 'Failed to toggle promo' });
    }
  }

  // ── Default: get order status by session_id ──────────────────────────────
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { session_id } = req.query;
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
    const response = {
      status: order.status,
      plan: order.plan,
      audience: order.audience,
      amount: order.amount,
      currency: order.currency,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };

    if (order.referralCode) response.referralCode = order.referralCode;
    if (order.expiresAt) response.expiresAt = order.expiresAt;
    if (order.activatedAt) response.activatedAt = order.activatedAt;

    res.status(200).json(response);
  } catch (error) {
    console.error('Order status error:', error.message);
    res.status(500).json({ error: 'Internal error' });
  }
};
