const Stripe = require('stripe');

const PRICES = {
  career: { student: null, professional: null },
  business: { student: null, professional: null },
  'sales-nav': { professional: null },
  'recruiter': { professional: null }
};

const LABELS = {
  fr: { email: 'Email LinkedIn', password: 'Mot de passe LinkedIn' },
  en: { email: 'LinkedIn Email', password: 'LinkedIn Password' },
  es: { email: 'Email de LinkedIn', password: 'Contraseña de LinkedIn' },
  de: { email: 'LinkedIn E-Mail', password: 'LinkedIn Passwort' }
};

const LOCALE_MAP = { fr: 'fr', en: 'en', es: 'es', de: 'de' };

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { plan, audience, language = 'fr', mode = 'payment' } = req.body;

    if (!plan || !audience) {
      return res.status(400).json({ error: 'Missing plan or audience' });
    }

    const priceId = PRICES[plan]?.[audience];
    if (!priceId) {
      return res.status(400).json({ error: 'Invalid plan/audience combination' });
    }

    const t = LABELS[language] || LABELS.fr;
    const locale = LOCALE_MAP[language] || 'fr';

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: mode === 'subscription' ? 'subscription' : 'payment',
      success_url: `${process.env.SITE_URL || 'https://karrier.pro'}/merci?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL || 'https://karrier.pro'}/#pricing`,
      locale,
      custom_fields: [
        {
          key: 'linkedin_email',
          label: { type: 'custom', custom: t.email },
          type: 'text',
          optional: false
        },
        {
          key: 'linkedin_password',
          label: { type: 'custom', custom: t.password },
          type: 'text',
          optional: false
        }
      ],
      metadata: { plan, audience, language }
    };

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Checkout error:', error.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
