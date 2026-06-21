const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDbWithFakePrisma } = require('./helpers/loadDb');

test('getWeekStart buckets every day of a week to that week\'s Monday', () => {
  const { db } = loadDbWithFakePrisma();
  const monday = db.getWeekStart('2026-06-15T10:00:00Z').toISOString();

  assert.equal(db.getWeekStart('2026-06-15T00:00:00Z').toISOString(), monday, 'Monday itself');
  assert.equal(db.getWeekStart('2026-06-17T23:59:00Z').toISOString(), monday, 'mid-week (Wednesday)');
  assert.equal(db.getWeekStart('2026-06-21T00:30:00Z').toISOString(), monday, 'Sunday, end of the same week');
});

test('getWeekStart rolls over correctly into the next week on Monday', () => {
  const { db } = loadDbWithFakePrisma();
  const week1 = db.getWeekStart('2026-06-15T10:00:00Z').toISOString();
  const week2 = db.getWeekStart('2026-06-22T00:00:01Z').toISOString();
  assert.notEqual(week1, week2);
  assert.equal(week2, '2026-06-22T00:00:00.000Z');
});
