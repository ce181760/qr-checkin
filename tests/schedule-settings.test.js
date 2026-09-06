const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeScheduleSettings, getEffectiveScheduleTime, getDaySchedule } = require('../schedule-settings');

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

test('uses the regular schedule on Monday and Wednesday early-release schedule on Wednesday', () => {
  const settings = {
    regular: { lateDropOffAfter: '08:15', pickUpBegins: '14:30', latePickUpAfter: '14:45' },
    wednesday: { lateDropOffAfter: '08:15', pickUpBegins: '13:30', latePickUpAfter: '13:45' },
  };

  assert.deepEqual(getDaySchedule('2026-08-10T14:29:00-04:00', settings), settings.regular);
  assert.deepEqual(getDaySchedule('2026-08-12T13:31:00-04:00', settings), settings.wednesday);
});
