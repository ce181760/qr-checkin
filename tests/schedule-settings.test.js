const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeScheduleSettings, getEffectiveScheduleTime } = require('../schedule-settings');

test('normalizes weekday and date overrides', () => {
  const settings = normalizeScheduleSettings({
    lateDropOffAfter: '08:36',
    latePickUpAfter: '13:35',
    overrides: [
      { type: 'day', value: 'Wednesday', action: 'drop_off', time: '09:30' },
      { type: 'date', value: '2026-08-12', action: 'pick_up', time: '12:00' },
    ],
  });

  assert.equal(settings.overrides.length, 2);
  assert.equal(settings.overrides[0].action, 'drop_off');
  assert.equal(settings.overrides[0].time, '09:30');
  assert.equal(settings.overrides[1].value, '2026-08-12');
});

test('uses a day-of-week override when the date matches', () => {
  const settings = normalizeScheduleSettings({
    lateDropOffAfter: '08:36',
    latePickUpAfter: '13:35',
    overrides: [
      { type: 'day', value: 'Wednesday', action: 'drop_off', time: '09:00' },
    ],
  });

  assert.equal(getEffectiveScheduleTime('drop_off', '2026-08-12T10:00:00-04:00', settings), '09:00');
});

test('keeps drop-off and pick-up overrides separate', () => {
  const settings = normalizeScheduleSettings({
    lateDropOffAfter: '08:36',
    latePickUpAfter: '13:35',
    overrides: [
      { type: 'day', value: 'Wednesday', action: 'drop_off', time: '09:00' },
      { type: 'day', value: 'Wednesday', action: 'pick_up', time: '15:30' },
    ],
  });

  assert.deepEqual(settings.overrides.map((entry) => entry.action), ['drop_off', 'pick_up']);
});

test('falls back to the default cutoff when no override matches', () => {
  const settings = normalizeScheduleSettings({
    lateDropOffAfter: '08:36',
    latePickUpAfter: '13:35',
    overrides: [
      { type: 'day', value: 'Wednesday', action: 'drop_off', time: '09:00' },
    ],
  });

  assert.equal(getEffectiveScheduleTime('pick_up', '2026-08-12T10:00:00-04:00', settings), '13:35');
});

test('uses the school timezone when deciding whether a weekday override applies', () => {
  const settings = normalizeScheduleSettings({
    lateDropOffAfter: '08:36',
    latePickUpAfter: '13:35',
    overrides: [
      { type: 'day', value: 'Wednesday', action: 'pick_up', time: '13:50' },
    ],
  });

  assert.equal(getEffectiveScheduleTime('pick_up', '2026-08-12T00:30:00Z', settings), '13:35');
  assert.equal(getEffectiveScheduleTime('pick_up', '2026-08-12T17:55:00Z', settings), '13:50');
});

test('uses the Wednesday early-day default for late pickup when no override has been saved', () => {
  const settings = normalizeScheduleSettings({});
  assert.equal(getEffectiveScheduleTime('pick_up', '2026-08-12T17:55:00Z', settings), '13:50');
});
