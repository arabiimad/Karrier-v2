require('./_env');
const kvStore = require('./_kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Only allow in dev mode (no Stripe key)
  if (process.env.STRIPE_SECRET_KEY) {
    return res.status(403).json({ error: 'Mock webhook disabled in production' });
  }

  try {
    const {
      session_id,
      plan,
      audience,
      amount,
      currency = 'eur',
      language = 'fr',
      customer_email,
      linkedin_email,
      linkedin_password
    } = req.body;

    if (!session_id || !plan || !customer_email || !linkedin_email || !linkedin_password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Idempotency check
    const existing = await kvStore.get(`order:${session_id}`);
    if (existing) {
      console.log(`[MOCK] Order ${session_id} already exists, skipping`);
      return res.status(200).json({ success: true, duplicate: true });
    }

    const order = {
      sessionId: session_id,
      paymentIntentId: 'pi_mock_' + Date.now(),
      subscriptionId: null,
      customerId: 'cus_mock_' + Date.now(),
      customerEmail: customer_email,
      linkedinEmail: linkedin_email,
      linkedinPassword: linkedin_password,
      plan: plan,
      audience: audience || 'student',
      language: language,
      mode: 'payment',
      amount: amount || 0,
      currency: currency,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Store order
    await kvStore.set(`order:${session_id}`, JSON.stringify(order));

    // Update index
    const indexKey = 'orders:index';
    const existingIndex = await kvStore.get(indexKey);
    const orderIds = existingIndex ? (typeof existingIndex === 'string' ? JSON.parse(existingIndex) : existingIndex) : [];
    if (!orderIds.includes(session_id)) {
      orderIds.unshift(session_id);
      await kvStore.set(indexKey, JSON.stringify(orderIds));
    }

    console.log(`[MOCK] Order created: ${session_id} — ${plan}/${audience} ${amount}${currency} — ${customer_email}`);

    res.status(200).json({ success: true, order: { sessionId: session_id, plan, amount } });

  } catch (error) {
    console.error('[MOCK] Webhook error:', error.message);
    res.status(500).json({ error: 'Mock webhook failed' });
  }
};
