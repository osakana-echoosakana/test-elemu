'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerSystem, parseScenario } = require('../lib/PowerSystem.js');

const NOON = '2026-07-01T12:00:00';

function make(ev) {
  const sys = new PowerSystem({ start: NOON });
  sys.setPvTestWatts(5000);
  sys.setBatteryMode('idle');
  if (ev) sys.setEv(ev);
  return sys;
}

test('EV is off by default: no EV power, no EV counters, no EV in the snapshot', () => {
  const sys = make();
  sys.step(60, []);
  assert.equal(sys.ev.enabled, false);
  assert.equal(sys._last.ev_w, 0);
  assert.equal(sys.meter.ev_charge_wh, 0);
  assert.equal(sys.snapshot().ev.enabled, false);
});

test('EV enabled charges from surplus after the battery', () => {
  const sys = make({ enabled: true });
  sys.step(60, []); // 余剰 4000 W（パワコン定格）→ EV 上限 3000 W
  assert.equal(sys._last.ev_w, 3000);
  assert.ok(sys.meter.ev_charge_wh > 0);
  assert.equal(sys.meter.ev_discharge_wh, 0);
  assert.ok(sys.ev.soc > 0.5);
});

test('charge OFF stops EV charging even when enabled', () => {
  const sys = make({ enabled: true, charge_enabled: false });
  sys.step(60, []);
  assert.equal(sys._last.ev_w, 0);
  assert.equal(sys.meter.ev_charge_wh, 0);
});

test('EV discharges to cover a deficit only when discharge is allowed', () => {
  const load = [{ eoj: '013001', watts: 1000 }];
  const sys = new PowerSystem({ start: NOON });
  sys.setPvTestWatts(0);
  sys.setBatteryMode('idle');
  sys.setEv({ enabled: true, charge_enabled: false, discharge_enabled: true });
  sys.step(60, load);
  assert.ok(Math.abs(sys._last.ev_w + 1000) < 1e-6);
  assert.ok(sys.meter.ev_discharge_wh > 0);
  assert.equal(sys.meter.ev_charge_wh, 0);

  const off = new PowerSystem({ start: NOON });
  off.setPvTestWatts(0);
  off.setBatteryMode('idle');
  off.setEv({ enabled: true, discharge_enabled: false });
  off.step(60, load);
  assert.equal(off._last.ev_w, 0);
});

test('EV flows are included in grid balance', () => {
  const sys = make({ enabled: true });
  sys.step(3600, []); // 1 時間ぶん
  const last = sys._last;
  // 余剰 4000 = EV 3000 + 売電 1000
  assert.equal(last.grid_w, -1000);
});

test('scenario round-trip keeps EV settings and counters; old scenarios default to EV off', () => {
  const sys = make({ enabled: true, charge_enabled: false, discharge_enabled: true, soc: 0.3 });
  sys.step(60, []);
  const exported = sys.exportScenario();
  assert.equal(exported.ev.enabled, true);
  assert.equal(exported.ev.charge_enabled, false);

  const restored = new PowerSystem({ start: NOON });
  restored.loadScenario(exported);
  assert.equal(restored.ev.enabled, true);
  assert.equal(restored.ev.charge_enabled, false);

  const legacy = { ...exported };
  delete legacy.ev;
  delete legacy.meter.ev_charge_wh;
  delete legacy.meter.ev_discharge_wh;
  assert.equal(parseScenario(legacy).ev.enabled, false);
});

test('setEv validates ranges', () => {
  const sys = new PowerSystem({ start: NOON });
  assert.throws(() => sys.setEv({ soc: 2 }));
  assert.throws(() => sys.setEv({ max_charge_w: -1 }));
});

test('time acceleration: EV counters scale with simulated time', () => {
  // 1 実時間秒 = 3600 シミュレーション秒（1 時間）で 1 ステップ分ずつ進める
  const fast = make({ enabled: true });
  fast.setSpeed(3600);
  fast.advance(1, () => []);
  // 1 時間ぶん 3000 W で充電 → 積算充電 ≈ 3000 Wh（SOC 変化の影響を除くため、量の上限内に収まる値で確認）
  assert.ok(Math.abs(fast.meter.ev_charge_wh - 3000) < 1e-6, String(fast.meter.ev_charge_wh));
  assert.equal(fast.meter.ev_discharge_wh, 0);

  // 同じ条件を細かく進めても結果が一致する（早回しの分割に依存しない）
  const slow = make({ enabled: true });
  for (let i = 0; i < 60; i++) slow.step(60, []);
  assert.ok(Math.abs(slow.meter.ev_charge_wh - fast.meter.ev_charge_wh) < 1e-6);
});
