'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DeviceState = require('../lib/DeviceState.js');

// 0x0288 の DeviceState を、ファイル I/O なしで作る
function makeMeter(e0_hex, e3_hex) {
  const st = new DeviceState('028801', { elProperties: {} }, {}, {}, 'A', null, {});
  st._writeStateFile = () => Promise.resolve();
  st._states = { E0: e0_hex, E3: e3_hex, E2: [], E4: [], E5: '00' };
  st.onchange = () => {};
  st._initEnergyHistory();
  return st;
}

const NO_DATA = 'FFFFFFFE';
const value = (rec, i) => parseInt(rec.substr(4 + 8 * i, 8), 16);
const day = (rec) => parseInt(rec.substr(0, 4), 16);

test('history records are 2-byte day + 48 x 4-byte cumulative values', () => {
  const st = makeMeter('00001000', '00000000');
  assert.equal(st._states.E2.length, 100);
  for (let d = 0; d < 100; d++) {
    assert.equal(st._states.E2[d].length, 4 + 48 * 8);
    assert.equal(day(st._states.E2[d]), d);
  }
});

test('past days are cumulative (non-decreasing in time) and end at the anchor', () => {
  const st = makeMeter('00001000', '00000000'); // E0 = 4096 Wh
  const day1 = st._states.E2[1];
  // day 1 最終コマが anchor (E0 現在値)
  assert.equal(value(day1, 47), 0x1000);
  for (let i = 1; i < 48; i++) {
    assert.ok(value(day1, i) >= value(day1, i - 1), `slot ${i} is non-decreasing`);
  }
  // 1 日前の値が 2 日前より大きい (さかのぼるほど小さい)
  assert.ok(value(st._states.E2[1], 0) >= value(st._states.E2[2], 47));
});

test('reverse direction history is anchored to E3, not E0', () => {
  const st = makeMeter('00000100', '00000042');
  assert.equal(value(st._states.E4[1], 47), 0x42);
  assert.equal(value(st._states.E2[1], 47), 0x100);
});

test('today has no data before simulated time reaches it', () => {
  const st = makeMeter('00001000', '00000000');
  for (let i = 0; i < 48; i++) {
    assert.equal(st._states.E2[0].substr(4 + 8 * i, 8), NO_DATA);
  }
});

test('completed slots are recorded and persist within the same day', async () => {
  const st = makeMeter('00001000', '00000000');
  await st.updateEnergyHistory([
    { day_key: '2026-11-18', slot: 0, e2: 0x1010, e4: 5 },
    { day_key: '2026-11-18', slot: 1, e2: 0x1020, e4: 6 },
  ]);
  assert.equal(value(st._states.E2[0], 0), 0x1010);
  assert.equal(value(st._states.E2[0], 1), 0x1020);
  assert.equal(value(st._states.E4[0], 1), 6);
  assert.equal(st._states.E2[0].substr(4 + 8 * 2, 8), NO_DATA);
});

test('crossing midnight shifts history by one day and keeps the previous day', async () => {
  const st = makeMeter('00001000', '00000000');
  await st.updateEnergyHistory([{ day_key: '2026-11-18', slot: 47, e2: 0x2000, e4: 0 }]);
  await st.updateEnergyHistory([{ day_key: '2026-11-19', slot: 0, e2: 0x2100, e4: 0 }]);
  assert.equal(day(st._states.E2[0]), 0);
  assert.equal(day(st._states.E2[1]), 1);
  assert.equal(value(st._states.E2[1], 47), 0x2000); // 前日の最終コマ
  assert.equal(value(st._states.E2[0], 0), 0x2100);
});

test('E5 day setting selects the record that is read back', async () => {
  const st = makeMeter('00001000', '00000000');
  await st.updateEnergyHistory([{ day_key: '2026-11-18', slot: 3, e2: 0x3333, e4: 0 }]);
  st._states.E5 = '00';
  assert.equal(value(st._getSpecialEdt('E2'), 3), 0x3333); // 当日
  st._states.E5 = '01';
  assert.equal(day(st._getSpecialEdt('E2')), 1); // 前日
});
