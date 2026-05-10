const PLAN_CATALOG = {
  'career-student': {
    plan: 'career-student',
    planLabel: 'LinkedIn Career',
    audience: 'Etudiant',
    amount: 60,
    officialAmount: 359.88,
    currency: 'EUR'
  },
  'career-salary': {
    plan: 'career-salary',
    planLabel: 'LinkedIn Career',
    audience: 'Salarie',
    amount: 80,
    officialAmount: 359.88,
    currency: 'EUR'
  },
  'business-student': {
    plan: 'business-student',
    planLabel: 'LinkedIn Business',
    audience: 'Etudiant',
    amount: 80,
    officialAmount: 660,
    currency: 'EUR'
  },
  'business-salary': {
    plan: 'business-salary',
    planLabel: 'LinkedIn Business',
    audience: 'Salarie',
    amount: 120,
    officialAmount: 660,
    currency: 'EUR'
  },
  'sales-nav': {
    plan: 'sales-nav',
    planLabel: 'Sales Navigator Core',
    audience: 'Tous profils',
    amount: 550,
    officialAmount: 1079.88,
    currency: 'EUR'
  }
};

function getPlan(planId) {
  return PLAN_CATALOG[planId] || null;
}

function listPlans() {
  return Object.values(PLAN_CATALOG);
}

module.exports = { getPlan, listPlans, PLAN_CATALOG };
