'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PowerSimulator = require('../lib/PowerSimulator.js');

// 機器オブジェクトの代わり: EPC の値を Map で保持する
function fakeObj(init) {
  const epcs = Object.assign({}, init);
  return {
    epcs,
    async getEpcValues(props) {
      const vals = {};
      props.forEach((p) => { vals[p.epc] = epcs[p.epc] === undefined ? null : epcs[p.epc]; });
      return { result: 0, vals };
    },
    async setEpcValues(props) {
      props.forEach((p) => { epcs[p.epc] = p.edt; });
      return { result: 0, vals: {} };
    },
  };
}

function fakeDevice(objs) {
  return {
    getPowerStatus: () => true,
    getDeviceObjects: () => objs,
  };
}

function makeSim(objs, extra = {}) {
  const conf = Object.assign({
    simulation_enabled: false, simulation_speed: 60, simulation_tick_msec: 1000,
    simulation_start: '2026-07-01T12:00:00',
  }, extra);
  return new PowerSimulator(conf, fakeDevice(objs));
}

test('tick writes meter, PV and battery EPCs from the simulation', async () => {
  const objs = {
    '028801': fakeObj({ '80': '30' }),
    '027901': fakeObj({ '80': '30' }),
    '027D01': fakeObj({ '80': '30', 'DA': '44' }),
    '013001': fakeObj({ '80': '30' }),
    '029001': fakeObj({ '80': '31' }),
  };
  const sim = makeSim(objs);
  sim.system.setPvTestWatts(1000);
  sim.system.setPcs({ efficiency: 1 });
  sim.system.setBatteryMode('idle');
  sim.setSellEnabled(true);
  // 1 回ぶん (実時間 1 秒 x 加速 60) 計算する
  await sim._tick();
  // 1000 W 発電 - エアコン 700 W = 300 W の売電 (60 秒ぶん)
  assert.equal(objs['028801'].epcs['E7'], (-300 >>> 0).toString(16).toUpperCase().padStart(8, '0'));
  assert.equal(objs['027901'].epcs['E0'], '03E8');          // 1000 W
  assert.equal(objs['027901'].epcs['D1'], '42');            // 出力抑制なし
  assert.equal(objs['027D01'].epcs['DA'], '44');            // 待機
  assert.equal(objs['029001'].epcs['80'], '31');            // 照明は OFF なので消費 0
});

test('external battery mode set via EPC 0xDA is adopted', async () => {
  const objs = {
    '027D01': fakeObj({ '80': '30', 'DA': '44' }),
    '028801': fakeObj({ '80': '30' }),
  };
  const sim = makeSim(objs);
  await sim._tick();                          // 1 回目: 0xDA を書き込む (standby)
  objs['027D01'].epcs['DA'] = '43';           // コントローラーが放電を Set した
  await sim._tick();
  assert.equal(sim.system.battery.mode, 'discharge');
});

test('stopped device does not advance simulated time on restart', async () => {
  const objs = { '028801': fakeObj({ '80': '30' }) };
  let running = true;
  const device = { getPowerStatus: () => running, getDeviceObjects: () => objs };
  const sim = new PowerSimulator({ simulation_enabled: false, simulation_speed: 1, simulation_tick_msec: 1000,
    simulation_start: '2026-07-01T12:00:00' }, device);
  await sim._tick();
  const t0 = sim.system.now.getTime();
  running = false;
  await sim._tick();
  running = true;
  await new Promise((r) => setTimeout(r, 1100));
  await sim._tick();
  // 停止中に経過した時間は加算されない (再開直後は 1 周期分だけ進む)
  assert.ok(sim.system.now.getTime() - t0 < 5000, 'simulated time jumped while stopped');
});

test('scenario export includes device power states and import restores them', async () => {
  const objs = {
    '013001': fakeObj({ '80': '31' }),
    '028801': fakeObj({ '80': '30' }),
  };
  const sim = makeSim(objs);
  const scenario = JSON.parse(JSON.stringify(await sim.exportScenario()));
  assert.deepEqual(scenario.devices.map((d) => [d.eoj, d.on]), [['013001', false], ['028801', true]]);

  // 別のインスタンスへ読み込む（機器の一覧は setCurrentEojList で反映される）
  const objs2 = {
    '013001': fakeObj({ '80': '30' }),
    '028801': fakeObj({ '80': '31' }),
  };
  const device2 = fakeDevice(objs2);
  device2.setCurrentEojList = async () => ({ result: 0 });
  const sim2 = new PowerSimulator({ simulation_enabled: false }, device2);
  await sim2.importScenario(scenario);
  assert.equal(objs2['013001'].epcs['80'], '31');
  assert.equal(objs2['028801'].epcs['80'], '30');
  assert.equal(sim2.system.now.toISOString(), sim.system.now.toISOString());
});

test('E7 instantaneous power is signed (buy positive) and stays inside the spec range', async () => {
  const objs = {
    '028801': fakeObj({ '80': '30' }),
    '013001': fakeObj({ '80': '30' }),
  };
  const sim = makeSim(objs);
  sim.system.setPvTestWatts(0);
  sim.system.setBatteryMode('idle');
  // 買電: エアコン 700 W を夜間に 1 回計算
  await sim._tick();
  assert.equal(objs['028801'].epcs['E7'], (700 >>> 0).toString(16).toUpperCase().padStart(8, '0'));
  // 範囲外の値は仕様の最大値 0x7FFFFFFD に丸める
  sim.system.setConsumerWatts('013001', 3e9);
  sim._lastTickMs = Date.now() - 1000; // 直前の周期と同じ ms にならないよう、実時間 1 秒ぶん進めたことにする
  await sim._tick();
  assert.equal(objs['028801'].epcs['E7'], '7FFFFFFD');
});

test('each consumer profile reports its simulated power in EPC 0x84', async () => {
  const objs = {
    '028801': fakeObj({ '80': '30' }),
    '013001': fakeObj({ '80': '30' }),  // エアコン ON -> 700 W
    '029001': fakeObj({ '80': '31' }),  // 照明 OFF -> 0 W
  };
  const sim = makeSim(objs);
  sim.system.setPvTestWatts(0);
  sim.system.setBatteryMode('idle');
  await sim._tick();
  assert.equal(objs['013001'].epcs['84'], '02BC');  // 700
  assert.equal(objs['029001'].epcs['84'], '0000');  // OFF は 0
});
