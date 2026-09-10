const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { app } = require('../server');

test('allows a student to be picked up without a prior drop-off record', async () => {
  const server = app.listen(0);
  await once(server, 'listening');

  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentName: `pickup-${Date.now()}`,
        parentName: 'Parent Test',
        action: 'pick_up',
        lateReason: 'Late pickup test',
        latePaymentConfirmed: true,
        latePaymentMethod: 'cash',
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200, `Expected 200 but got ${response.status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.success, true);
    assert.equal(payload.action, 'pick_up');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
