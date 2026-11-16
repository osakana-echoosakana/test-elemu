'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PowerSystem, defaultWatts, parseScenario, clearSkyFactor,
} = require('../lib/PowerSystem.js');

const NOON = '2026-07-01T12:00:00';

function fixed(sys, w) {
  sys.setPvTestWatts(w);
}

test('default consumption: consumers have watts, generators/meter do not', () => {
  assert.equal(defaultWatts('013001'), 700);      // エアコン
  assert.equal(defaultWatts('029001'), 60);       // 照明
  assert.equal(defaultWatts('026301'), 100);      // シャッター
  assert.equal(defaultWatts('028801'), 0);        // スマートメーター
  assert.equal(defaultWatts('027901'), 0);        // 太陽光
  assert.equal(defaultWatts('027D01'), 0);        // 蓄電池
  assert.equal(defaultWatts('0EF001'), 0);        // ノードプロファイル
  assert.equal(defaultWatts('05FF01'), 0);        // コントローラー
  assert.ok(defaultWatts('0F9901') > 0, 'unknown classes get a fallback');
});

test('clock: advance applies speed and sub-steps are at most 60 s', () => {
  const sys = new PowerSystem({ start: '2026-07-01T00:00:00', speed: 60 });
  let calls = 0;
  sys.advance(10, () => { calls++; return []; }); // 10 real s x60 = 600 sim s
  assert.equal(sys.now.toISOString(), '2026-07-01T00:10:00.000Z');
  assert.equal(calls, 10);
  sys.setSpeed(3600);
  sys.advanceSimulated(3600);
  assert.equal(sys.now.toISOString(), '2026-07-01T01:10:00.000Z');
});

test('clock rejects invalid input', () => {
  assert.throws(() => new PowerSystem({ start: 'bogus' }));
  assert.throws(() => new PowerSystem({ speed: 0 }));
  const sys = new PowerSystem({ start: NOON });
  assert.throws(() => sys.setSpeed(-1));
});

test('smart meter aggregates device consumption and computes buy/sell', () => {
  const sys = new PowerSystem({ start: NOON });
  fixed(sys, 1000);            // 1 kW PV at pcs efficiency 0.95 -> 950 W AC
  sys.setPcs({ efficiency: 1 });
  sys.setBatteryMode('idle');
  const loads = [{ eoj: '013001', watts: 300 }, { eoj: '029001', watts: 50 }];
  // 1 時間分のステップ
  sys.advanceSimulated(3600, () => loads);
  // 1 kW PV - 350 W = 650 W 売電 (逆潮流) を 1 時間
  assert.ok(Math.abs(sys.meter.sell_wh - 650) < 1e-6, `sell ${sys.meter.sell_wh}`);
  assert.equal(sys.meter.buy_wh, 0);
  assert.equal(sys.meter.instant_w, -650);
  assert.ok(Math.abs(sys.meter.device_wh['013001'] - 300) < 1e-6);
  assert.ok(Math.abs(sys.meter.device_wh['029001'] - 50) < 1e-6);
});

test('smart meter counts buy power when load exceeds PV', () => {
  const sys = new PowerSystem({ start: NOON });
  fixed(sys, 0);
  sys.setBatteryMode('idle');
  sys.advanceSimulated(1800, () => [{ eoj: '013001', watts: 800 }]);
  assert.ok(Math.abs(sys.meter.buy_wh - 400) < 1e-6);
  assert.equal(sys.meter.sell_wh, 0);
  assert.equal(sys.meter.instant_w, 800);
});

test('PV test value is used for generation and scenario profile interpolates', () => {
  const sys = new PowerSystem({ start: '2026-07-01T10:00:00' });
  fixed(sys, 2000);
  assert.equal(sys.pvWatts(sys.now), 2000);
  sys.setPvTestWatts(null);
  sys.setPvProfile([
    { time: '2026-07-01T10:00:00', w: 0 },
    { time: '2026-07-01T11:00:00', w: 1000 },
  ]);
  const mid = new Date('2026-07-01T10:30:00');
  assert.equal(sys.pvWatts(mid), 500);
  assert.equal(sys.pvWatts(new Date('2026-07-01T09:00:00')), 0);
  assert.equal(sys.pvWatts(new Date('2026-07-01T12:00:00')), 1000);
});

test('clear sky model is zero at night and peaks at noon', () => {
  assert.equal(clearSkyFactor(new Date('2026-07-01T03:00:00')), 0);
  assert.equal(clearSkyFactor(new Date('2026-07-01T19:00:00')), 0);
  assert.ok(clearSkyFactor(new Date('2026-07-01T12:00:00')) > 0.99);
});

test('auto battery charges from PV surplus and discharges to cover shortfall', () => {
  const sys = new PowerSystem({ start: NOON });
  sys.setPcs({ efficiency: 1 });
  sys.setBatterySoc(0.5);
  sys.setBatteryParams({ capacity_wh: 1000, max_charge_w: 1000, max_discharge_w: 1000, efficiency: 1 });
  fixed(sys, 600);
  sys.step(3600, [{ eoj: '013001', watts: 100 }]); // surplus 500 -> charge 500 Wh
  assert.ok(Math.abs(sys.battery.soc - 1.0) < 1e-9 || Math.abs(sys.battery.soc - 1.0) < 1e-9);
  assert.equal(sys.meter.sell_wh, 0);               // full battery -> surplus sold after storing
  fixed(sys, 0);
  sys.setBatterySoc(0.5);
  sys.step(1800, [{ eoj: '013001', watts: 400 }]); // shortfall 400 W -> discharge 200 Wh
  assert.ok(Math.abs(sys.battery.soc - 0.3) < 1e-9, `soc ${sys.battery.soc}`);
  assert.equal(sys.meter.buy_wh, 0);
  assert.ok(Math.abs(sys.meter.battery_discharge_wh - 200) < 1e-6);
});

test('switching sell off curtails surplus instead of selling it', () => {
  const sys = new PowerSystem({ start: NOON });
  sys.setPcs({ efficiency: 1 });
  sys.setBatteryMode('idle');
  fixed(sys, 1000);
  sys.setSellEnabled(false);
  sys.step(3600, []);
  assert.equal(sys.meter.sell_wh, 0);
  assert.ok(Math.abs(sys.meter.curtail_wh - 1000) < 1e-6);
  sys.setSellEnabled(true);
  sys.step(3600, []);
  assert.ok(Math.abs(sys.meter.sell_wh - 1000) < 1e-6);
});

test('discharge mode without selling only supplies the home', () => {
  const sys = new PowerSystem({ start: NOON });
  sys.setPcs({ efficiency: 1 });
  fixed(sys, 0);
  sys.setBatteryParams({ capacity_wh: 10000, max_discharge_w: 3000, efficiency: 1 });
  sys.setBatterySoc(1);
  sys.setBatteryMode('discharge');
  sys.setSellEnabled(false);
  sys.step(3600, [{ eoj: '013001', watts: 500 }]);
  assert.ok(Math.abs(sys.meter.battery_discharge_wh - 500) < 1e-6, 'only the shortfall is discharged');
  assert.equal(sys.meter.sell_wh, 0);
  sys.setSellEnabled(true);
  sys.step(3600, [{ eoj: '013001', watts: 0 }]);
  assert.ok(sys.meter.sell_wh > 0, 'with selling enabled the battery discharges into the grid');
});

test('energy balance: PV + buy + discharge = load + sell + curtail + charge', () => {
  const sys = new PowerSystem({ start: '2026-07-01T06:00:00' });
  sys.setBatteryParams({ capacity_wh: 3000, max_charge_w: 1500, max_discharge_w: 1500, efficiency: 0.9 });
  sys.setBatterySoc(0.4);
  sys.setPcs({ rated_kw: 3, efficiency: 0.93 });
  const loads = () => [{ eoj: '013001', watts: 650 }, { eoj: '029001', watts: 60 }];
  sys.setSellEnabled(true);
  sys.advanceSimulated(24 * 3600, loads);
  const m = sys.meter;
  const lhs = m.pv_wh + m.buy_wh + m.battery_discharge_wh;
  const rhs = (m.device_wh['013001'] + m.device_wh['029001']) + m.sell_wh + m.curtail_wh + m.battery_charge_wh;
  assert.ok(Math.abs(lhs - rhs) < 1e-3, `balance ${lhs} vs ${rhs}`);
  assert.ok(sys.battery.soc >= 0 && sys.battery.soc <= 1);
});

test('overrides change consumption and are used by consumerWatts', () => {
  const sys = new PowerSystem({ start: NOON });
  sys.setConsumerWatts('013001', 1200);
  assert.equal(sys.consumerWatts('013001'), 1200);
  sys.setConsumerWatts('013001', null);
  assert.equal(sys.consumerWatts('013001'), 700);
});

test('scenario export and import round-trip keeps the whole system state', () => {
  const sys = new PowerSystem({ start: NOON, speed: 120 });
  sys.setPvProfile([{ time: '2026-07-01T06:00:00', w: 0 }, { time: '2026-07-01T12:00:00', w: 3000 }]);
  sys.setPcs({ rated_kw: 5, efficiency: 0.9 });
  sys.setBatteryParams({ capacity_wh: 7000 });
  sys.setBatterySoc(0.25);
  sys.setBatteryMode('charge');
  sys.setSellEnabled(false);
  sys.setConsumerWatts('013001', 900);
  sys.advanceSimulated(1800, () => [{ eoj: '013001', watts: 900 }]);
  const devices = [{ eoj: '013001', on: true }];
  const json = JSON.parse(JSON.stringify(sys.exportScenario(devices)));

  const restored = new PowerSystem();
  const restoredDevices = restored.loadScenario(json);
  assert.deepEqual(restoredDevices, devices);
  assert.equal(restored.now.toISOString(), sys.now.toISOString());
  assert.equal(restored.speed, 120);
  assert.equal(restored.sell_enabled, false);
  assert.equal(restored.battery.mode, 'charge');
  assert.equal(restored.battery.capacity_wh, 7000);
  assert.ok(Math.abs(restored.battery.soc - sys.battery.soc) < 1e-12);
  assert.equal(restored.pcs.rated_kw, 5);
  assert.equal(restored.consumerWatts('013001'), 900);
  assert.equal(restored.pv.profile.length, 2);
  assert.ok(Math.abs(restored.meter.buy_wh - sys.meter.buy_wh) < 1e-9);
  assert.deepEqual(restored.meter.device_wh, sys.meter.device_wh);
});

test('scenario import rejects invalid data without changing state', () => {
  const sys = new PowerSystem({ start: NOON });
  const before = JSON.stringify(sys.exportScenario());
  assert.throws(() => sys.loadScenario({ format: 'other', version: 1 }));
  assert.throws(() => sys.loadScenario({ format: 'elemu-scenario', version: 99 }));
  assert.throws(() => sys.loadScenario({ format: 'elemu-scenario', version: 1, time: NOON, battery: { mode: 'boom' } }));
  assert.throws(() => sys.loadScenario({ format: 'elemu-scenario', version: 1, time: NOON, battery: { soc: 2 } }));
  assert.throws(() => parseScenario({ format: 'elemu-scenario', version: 1, time: NOON, overrides: { 'XYZ': 1 } }));
  assert.equal(JSON.stringify(sys.exportScenario()), before);
});

test('invalid switch values are rejected', () => {
  const sys = new PowerSystem({ start: NOON });
  assert.throws(() => sys.setBatteryMode('turbo'));
  assert.throws(() => sys.setPvTestWatts(-5));
  assert.throws(() => sys.setBatterySoc(1.5));
});
