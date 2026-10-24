// Payment state of an order.
// Since the pay-after-activation change, the team marks an order as paid by hand.
// Older orders were paid before the secure link was sent, so for those the
// status alone tells us whether the money came in.
const LEGACY_PAID_STATUSES = ['awaiting_credentials', 'activating', 'done'];

function isPaid(order) {
  if (!order) return false;
  if (typeof order.paid === 'boolean') return order.paid;
  if (order.paymentFlow === 'after_activation') return false;
  return LEGACY_PAID_STATUSES.includes(order.status);
}

// Money we actually kept: paid and not refunded.
function countsAsRevenue(order) {
  return isPaid(order) && order.status !== 'refunded';
}

// Premium is active but the customer has not paid yet.
function isPaymentDue(order) {
  return !isPaid(order) && order.status === 'done';
}

function isStudentOrder(order) {
  return /etudiant|étudiant|student/i.test(String(order.audience || '') + ' ' + String(order.plan || ''));
}

function hasCredentials(order) {
  return !!(order && ((order.credentials && order.credentials.linkedinPassword) || order.linkedinPassword || order.hasCredentials));
}

// Work queues shown in the admin, in the order the team handles them.
const QUEUES = {
  to_link: order => ['pending', 'pending_payment'].includes(order.status),
  waiting_credentials: order => order.status === 'awaiting_credentials' && !hasCredentials(order),
  to_activate: order => order.status === 'activating' || (hasCredentials(order) && !['done', 'refunded'].includes(order.status)),
  to_collect: isPaymentDue,
  // Student price: proof may be requested before activation.
  student_check: order => isStudentOrder(order) && !order.studentVerified
    && ['pending', 'pending_payment', 'awaiting_credentials', 'activating'].includes(order.status)
};

module.exports = { isPaid, countsAsRevenue, isPaymentDue, hasCredentials, isStudentOrder, QUEUES };
