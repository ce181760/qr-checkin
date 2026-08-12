const DEFAULT_LATE_PAYMENT_METHOD = 'venmo';

function normalizePaymentMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  if (method === 'cash') {
    return 'cash';
  }
  return 'venmo';
}

function getLatePaymentSummary(record = {}) {
  if (!record.pickUpLateReason) {
    return '';
  }

  const method = normalizePaymentMethod(record.pickUpLatePaymentMethod);
  if (method === 'cash') {
    if (record.pickUpLatePaymentApproved) {
      const signer = record.pickUpLatePaymentAdminSignature || 'admin';
      return `Cash payment approved by ${signer}`;
    }
    return 'Cash payment pending admin approval';
  }

  const status = record.pickUpLatePaymentConfirmed ? 'Confirmed $10 to @phcs1166' : 'Not confirmed';
  const receipt = record.pickUpLatePaymentReceipt ? 'Receipt uploaded' : 'Receipt missing';
  return `${status}; ${receipt}`;
}

module.exports = {
  DEFAULT_LATE_PAYMENT_METHOD,
  normalizePaymentMethod,
  getLatePaymentSummary,
};
