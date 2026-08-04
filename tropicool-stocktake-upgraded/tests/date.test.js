/**
 * Tests for js/date.js -- the Australia/Brisbane business-date utilities.
 * Run with: node --test tests/date.test.js
 * (Node's built-in test runner; no dependency install required.)
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TTDate = require('../js/date.js');

// Brisbane (Australia/Brisbane) is a fixed UTC+10 offset year-round -- it does
// not observe daylight saving -- so every "instant at HH:MM Brisbane time" in
// these fixtures is expressed as an explicit +10:00 ISO string rather than
// relying on the test runner's local timezone.

test('midnight in Brisbane maps to the date that is starting, not the previous day', () => {
  const instant = new Date('2026-08-04T00:00:00+10:00');
  assert.equal(TTDate.brisbaneDateISO(instant), '2026-08-04');
});

test('one second before midnight in Brisbane is still the previous date', () => {
  const instant = new Date('2026-08-03T23:59:59+10:00');
  assert.equal(TTDate.brisbaneDateISO(instant), '2026-08-03');
});

test('morning counts before 10am stay on the same Brisbane business date', () => {
  const sevenThirty = new Date('2026-08-04T07:30:00+10:00');
  const nineFiftyNine = new Date('2026-08-04T09:59:00+10:00');
  assert.equal(TTDate.brisbaneDateISO(sevenThirty), '2026-08-04');
  assert.equal(TTDate.brisbaneDateISO(nineFiftyNine), '2026-08-04');
});

test('year boundary: 31 Dec 23:59 Brisbane vs 1 Jan 00:01 Brisbane', () => {
  const nyEve = new Date('2026-12-31T23:59:00+10:00');
  const nyDay = new Date('2027-01-01T00:01:00+10:00');
  assert.equal(TTDate.brisbaneDateISO(nyEve), '2026-12-31');
  assert.equal(TTDate.brisbaneDateISO(nyDay), '2027-01-01');
});

test('month boundary: 31 Jan 23:59 Brisbane rolls to 1 Feb', () => {
  const endOfJan = new Date('2026-01-31T23:59:00+10:00');
  const startOfFeb = new Date('2026-02-01T00:00:01+10:00');
  assert.equal(TTDate.brisbaneDateISO(endOfJan), '2026-01-31');
  assert.equal(TTDate.brisbaneDateISO(startOfFeb), '2026-02-01');
});

test('leap-year month boundary: 29 Feb 2028 exists and rolls to 1 Mar', () => {
  const leapDay = new Date('2028-02-29T12:00:00+10:00');
  const nextDay = new Date('2028-03-01T00:00:01+10:00');
  assert.equal(TTDate.brisbaneDateISO(leapDay), '2028-02-29');
  assert.equal(TTDate.brisbaneDateISO(nextDay), '2028-03-01');
});

test('device timezone must not affect the computed Brisbane date (DST device, winter instant)', () => {
  // Same absolute instant, computed identically regardless of process TZ,
  // because getBrisbaneParts always passes an explicit Brisbane timeZone to
  // Intl.DateTimeFormat rather than reading the Date object's local fields.
  const instant = new Date('2026-08-04T07:00:00+10:00'); // Brisbane winter morning
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles'; // observes DST, ~17h behind Brisbane in Aug
    assert.equal(TTDate.brisbaneDateISO(instant), '2026-08-04');
    process.env.TZ = 'Pacific/Auckland'; // observes DST, ahead of Brisbane
    assert.equal(TTDate.brisbaneDateISO(instant), '2026-08-04');
    process.env.TZ = 'Australia/Sydney'; // observes DST, usually +1h on Brisbane
    assert.equal(TTDate.brisbaneDateISO(instant), '2026-08-04');
  } finally {
    process.env.TZ = originalTZ;
  }
});

test('device timezone must not affect the computed Brisbane date (DST device, summer instant)', () => {
  // Sydney observes DST (AEDT, UTC+11) in January; Brisbane never does.
  // A late-night Sydney-local moment must still resolve to the correct
  // Brisbane calendar date, which can legitimately differ from what a
  // Sydney-local naive read would show.
  const instant = new Date('2027-01-15T23:30:00+10:00'); // 23:30 Brisbane time
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'Australia/Sydney';
    assert.equal(TTDate.brisbaneDateISO(instant), '2027-01-15');
  } finally {
    process.env.TZ = originalTZ;
  }
});

test('brisbaneBusinessDate with no cutover equals the plain Brisbane calendar date', () => {
  const instant = new Date('2026-08-04T02:00:00+10:00');
  assert.equal(TTDate.brisbaneBusinessDate(instant), TTDate.brisbaneDateISO(instant));
});

test('brisbaneBusinessDate with a cutover rolls early-morning instants back a day', () => {
  const oneAM = new Date('2026-08-04T01:00:00+10:00');
  const fourAM = new Date('2026-08-04T04:00:00+10:00');
  assert.equal(TTDate.brisbaneBusinessDate(oneAM, 4), '2026-08-03');
  assert.equal(TTDate.brisbaneBusinessDate(fourAM, 4), '2026-08-04');
});

test('isBrisbaneToday compares against the current Brisbane date, not device-local today', () => {
  const now = new Date();
  assert.equal(TTDate.isBrisbaneToday(TTDate.brisbaneDateISO(now), now), true);
  assert.equal(TTDate.isBrisbaneToday('1999-01-01', now), false);
});

test('daysBetween is calendar-accurate across a month boundary', () => {
  assert.equal(TTDate.daysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(TTDate.daysBetween('2026-02-01', '2026-01-31'), -1);
  assert.equal(TTDate.daysBetween('2026-08-04', '2026-08-04'), 0);
});

test('daysBetween is calendar-accurate across a leap-year February', () => {
  assert.equal(TTDate.daysBetween('2028-02-28', '2028-03-01'), 2);
  assert.equal(TTDate.daysBetween('2027-02-28', '2027-03-01'), 1);
});

test('addDays rolls correctly across month and year boundaries', () => {
  assert.equal(TTDate.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(TTDate.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(TTDate.addDays('2028-02-28', 1), '2028-02-29');
});

test('formatBrisbaneDate renders the intended calendar date regardless of process TZ', () => {
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Midway'; // UTC-11, far behind Brisbane
    const label = TTDate.formatBrisbaneDate('2026-08-04', { month: 'short', day: 'numeric' });
    assert.match(label, /Aug/);
    assert.match(label, /4/);
  } finally {
    process.env.TZ = originalTZ;
  }
});

test('brisbaneTimeHM returns 24-hour HH:MM in Brisbane time', () => {
  const instant = new Date('2026-08-04T00:05:00+10:00');
  assert.equal(TTDate.brisbaneTimeHM(instant), '00:05');
});
