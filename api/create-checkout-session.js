require('./_env');
const Stripe = require('stripe');
const rateLimit = require('./_rate-limit');
const checkRate = rateLimit({ windowMs: 60000, max: 10 });

const PRICES = {
  career: { 
    student: process.env.STRIPE_PRICE_CAREER_STUDENT || 'price_career_student',
    professional: process.env.STRIPE_PRICE_CAREER_PRO || 'price_career_pro'
  },
  business: { 
    student: process.env.STRIPE_PRICE_BUSINESS_STUDENT || 'price_business_student',
    professional: process.env.STRIPE_PRICE_BUSINESS_PRO || 'price_business_pro'
  },
  'sales-nav': { 
    professional: process.env.STRIPE_PRICE_SALESNAV_PRO || 'price_salesnav_pro'
  },
  'recruiter': { 
    professional: process.env.STRIPE_PRICE_RECRUITER_PRO || 'price_recruiter_pro'
  }
};

const LABELS = {
  fr: { email: 'Email LinkedIn', password: 'Mot de passe LinkedIn' },
  en: { email: 'LinkedIn Email', password: 'LinkedIn Password' },
  es: { email: 'Email de LinkedIn', password: 'Contraseña de LinkedIn' },
  de: { email: 'LinkedIn E-Mail', password: 'LinkedIn Passwort' }
};

const LOCALE_MAP = { fr: 'fr', en: 'en', es: 'es', de: 'de' };
const CURRENCY_MAP = { fr: 'eur', en: 'usd', es: 'eur', de: 'eur' };

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rate = checkRate(req);
  if (!rate.allowed) {
    return res.status(429).json({ error: 'Too many requests. Try again later.', retryAfter: rate.retryAfter });
  }

  try {
    const { plan, audience, language = 'fr', mode = 'payment' } = req.body;

    if (!plan || !audience) {
      return res.status(400).json({ error: 'Missing plan or audience' });
    }

    const validPlans = ['career', 'business', 'sales-nav', 'recruiter'];
    const validAudiences = ['student', 'professional'];
    if (!validPlans.includes(plan) || !validAudiences.includes(audience)) {
      return res.status(400).json({ error: 'Invalid plan or audience' });
    }

    const priceId = PRICES[plan]?.[audience];
    if (!priceId) {
      return res.status(400).json({ error: 'Invalid plan/audience combination' });
    }

    // ===== MOCK MODE (no Stripe key) =====
    if (!process.env.STRIPE_SECRET_KEY) {
      const MOCK_PRICES = {
        career: { student: 70, professional: 80 },
        business: { student: 100, professional: 120 },
        'sales-nav': { professional: 550 },
        'recruiter': { professional: 530 }
      };
      const amount = MOCK_PRICES[plan]?.[audience] || 99;
      const currency = CURRENCY_MAP[language] || 'eur';
      const mockId = 'cs_mock_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
      const mockUrl = `/mock-checkout.html?session_id=${mockId}&plan=${plan}&audience=${audience}&amount=${amount}&currency=${currency}&language=${language}`;
      console.log(`[MOCK] Checkout session created: ${mockId} (${plan}/${audience} ${amount}${currency})`);
      return res.status(200).json({ url: mockUrl });
    }

    // ===== REAL STRIPE MODE =====
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const t = LABELS[language] || LABELS.fr;
    const locale = LOCALE_MAP[language] || 'fr';

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: mode === 'subscription' ? 'subscription' : 'payment',
      allow_promotion_codes: true,
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
