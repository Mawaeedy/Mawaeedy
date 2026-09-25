const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { seal, open } = require('../core/google-calendar-connection');
const { publicAvailabilitySlots } = require('../core/public-availability');

test('Google Calendar tokens are encrypted and cannot be read with another key', () => {
  const encrypted = seal('google-test-access-token', 'test-only-key-one');
  assert.doesNotMatch(encrypted, /google-test-access-token/);
  assert.equal(open(encrypted, 'test-only-key-one'), 'google-test-access-token');
  assert.throws(() => open(encrypted, 'test-only-key-two'));
});

test('weekly time block splits availability and removes bookable slots', () => {
  const source = fs.readFileSync('app.js', 'utf8');
  const start = source.indexOf('function subtractTimeBlock(');
  const end = source.indexOf('function policyModal(', start);
  const subtract = vm.runInNewContext(`${source.slice(start, end)}; subtractTimeBlock`);
  const original = [{ weekday: 5, startLocal: '09:00', endLocal: '17:00' }];
  const intervals = JSON.parse(JSON.stringify(subtract(original, 5, '12:00', '14:00')));
  assert.deepEqual(intervals, [
    { weekday: 5, startLocal: '09:00', endLocal: '12:00' },
    { weekday: 5, startLocal: '14:00', endLocal: '17:00' }
  ]);
  const slots = publicAvailabilitySlots({ date: '2026-10-02', timezone: 'Asia/Baghdad', availability: { schedule: { timezone: 'Asia/Baghdad' }, intervals, overrides: [] }, meetingTypes: [{ id: 'meeting', duration: 30 }], meetingTypeId: 'meeting' });
  assert.ok(slots.includes('11:30'));
  assert.ok(slots.includes('14:00'));
  assert.ok(!slots.includes('12:00'));
  assert.throws(() => subtract(original, 5, '14:00', '12:00'));
});

test('dated holiday override removes all slots only on the selected date', () => {
  const base = { timezone: 'Asia/Baghdad', availability: { schedule: { timezone: 'Asia/Baghdad' }, intervals: [{ weekday: 5, startLocal: '09:00', endLocal: '12:00' }], overrides: [{ overrideDate: '2026-10-02', isAvailable: false }] }, meetingTypes: [{ id: 'meeting', duration: 30 }], meetingTypeId: 'meeting' };
  assert.deepEqual(publicAvailabilitySlots({ ...base, date: '2026-10-02' }), []);
  assert.ok(publicAvailabilitySlots({ ...base, date: '2026-10-09' }).length > 0);
});
