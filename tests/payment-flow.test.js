const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePaymentMethod, getLatePaymentSummary } = require('../payment-flow');
const { canRecordPickup } = require('../server');

test('normalizes payment method values', () => {
  assert.equal(normalizePaymentMethod('cash'), 'cash');
  assert.equal(normalizePaymentMethod('VENMO'), 'venmo');
  assert.equal(normalizePaymentMethod(''), 'venmo');
});

test('formats venmo payment summaries', () => {
  const summary = getLatePaymentSummary({
    pickUpLateReason: 'Late',
    pickUpLatePaymentMethod: 'venmo',
    pickUpLatePaymentConfirmed: true,
    pickUpLatePaymentReceipt: 'receipt.jpg',
  });

  assert.equal(summary, 'Confirmed $10 to @phcs1166; Receipt uploaded');
});

test('formats cash payment summaries', () => {
  const pending = getLatePaymentSummary({
    pickUpLateReason: 'Late',
    pickUpLatePaymentMethod: 'cash',
    pickUpLatePaymentApproved: false,
  });
  const approved = getLatePaymentSummary({
    pickUpLateReason: 'Late',
    pickUpLatePaymentMethod: 'cash',
    pickUpLatePaymentApproved: true,
    pickUpLatePaymentAdminSignature: 'Ms. Rivera',
  });

  assert.equal(pending, 'Cash payment pending admin approval');
  assert.equal(approved, 'Cash payment approved by Ms. Rivera');
});

test('allows pickup without a prior dropoff record while blocking duplicate pickups', () => {
  assert.equal(canRecordPickup({}), true);
  assert.equal(canRecordPickup({ dropOffTimestamp: '2026-08-12T08:00:00Z' }), true);
  assert.equal(canRecordPickup({ pickUpTimestamp: '2026-08-12T15:00:00Z' }), false);
});
