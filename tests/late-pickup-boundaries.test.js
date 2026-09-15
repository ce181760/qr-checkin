const test = require('node:test');
const assert = require('node:assert/strict');
const { recordAttendanceAction, setNowForTest, clearNowForTest } = require('../server.js');

const boundaryCases = [
  { label: 'Regular day at 2:59 PM', iso: '2026-09-15T14:59:00-04:00', expected: 'On time', studentName: 'Boundary Regular 1459' },
  { label: 'Regular day at 3:00 PM', iso: '2026-09-15T15:00:00-04:00', expected: 'Late', studentName: 'Boundary Regular 1500' },
  { label: 'Wednesday at 1:59 PM', iso: '2026-09-16T13:59:00-04:00', expected: 'On time', studentName: 'Boundary Wed 1359' },
  { label: 'Wednesday at 2:00 PM', iso: '2026-09-16T14:00:00-04:00', expected: 'Late', studentName: 'Boundary Wed 1400' },
];

test('late pickup boundary logic matches regular and Wednesday cutoff times', async () => {
  for (const testCase of boundaryCases) {
    setNowForTest(testCase.iso);
    try {
      const result = await recordAttendanceAction(testCase.studentName, 'Test Parent', 'pick_up', 'Boundary check', true, null, 'cash');
      assert.equal(result.timingStatus, testCase.expected, `${testCase.label} should be ${testCase.expected}`);
    } finally {
      clearNowForTest();
    }
  }
});
