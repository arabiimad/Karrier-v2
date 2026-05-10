require('./_env');
const { verifyAuth } = require('./_auth');
const kvStore = require('./_kv');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    verifyAuth(req);
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { status, search, page = '1', limit = '50' } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const orders = await kvStore.getAllOrders(order => {
      if (status && order.status !== status) return false;
      if (search) {
        const q = search.toLowerCase();
        return (order.customerEmail || '').toLowerCase().includes(q)
          || (order.linkedinEmail || '').toLowerCase().includes(q)
          || (order.plan || '').toLowerCase().includes(q)
          || (order.audience || '').toLowerCase().includes(q)
          || (order.sessionId || '').toLowerCase().includes(q);
      }
      return true;
    });

    // Paginate
    const start = (pageNum - 1) * limitNum;
    const paginated = orders.slice(start, start + limitNum).map(sanitizeOrder);

    res.status(200).json({
      orders: paginated,
      total: orders.length,
      page: pageNum,
      totalPages: Math.ceil(orders.length / limitNum)
    });

  } catch (error) {
    console.error('Orders error:', error.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
};

function sanitizeOrder(order) {
  const copy = { ...order };
  const hasEncryptedCredentials = !!(order.credentials && order.credentials.linkedinPassword);
  const hasLegacyCredentials = !!order.linkedinPassword;
  copy.hasCredentials = hasEncryptedCredentials || hasLegacyCredentials || !!order.hasCredentials;
  copy.credentialsSubmittedAt = order.credentialsSubmittedAt || (order.credentials && order.credentials.submittedAt) || null;
  copy.credentialsExpiresAt = order.credentials && order.credentials.expiresAt ? order.credentials.expiresAt : null;
  copy.credentialLinkSentAt = order.credentialLinkSentAt || (order.credentialLink && order.credentialLink.sentAt) || null;
  copy.credentialLinkExpiresAt = order.credentialLink && order.credentialLink.expiresAt ? order.credentialLink.expiresAt : null;
  delete copy.linkedinPassword;
  delete copy.credentials;
  if (copy.credentialLink) {
    copy.credentialLink = {
      sentAt: copy.credentialLink.sentAt,
      expiresAt: copy.credentialLink.expiresAt,
      usedAt: copy.credentialLink.usedAt || null
    };
  }
  return copy;
}
