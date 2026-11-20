/* ------------------------------------------------------------------
* PowerSimulator.js
* 電力シミュレーション（PowerSystem）と ECHONET Lite デバイスの橋渡し
*
* - 一定周期 (simulation_tick_msec) で実時間を進め、時刻加速倍率を掛けて
*   シミュレーション時刻を進める
* - 機器の電源状態 (EPC 0x80) から消費電力を集計し、PowerSystem に渡す
* - 計算結果を低圧スマートメーター(0x0288)・太陽光(0x0279)・
*   蓄電池(0x027D) の EPC に書き込む
* - 蓄電池の運転モード (EPC 0xDA) を外部 (コントローラー) から Set された場合は
*   その値を PowerSystem のモードに反映する
* - シナリオの書き出し・読み込み（機器一覧・電源状態を含む）
* ---------------------------------------------------------------- */
'use strict';
const { PowerSystem, isConsumerEoj, parseScenario } = require('./PowerSystem.js');

// 蓄電池 EPC 0xDA (運転モード設定) の EDT
const DA_RAPID_CHARGING = '41';
const DA_CHARGING = '42';
const DA_DISCHARGING = '43';
const DA_STANDBY = '44';
// 太陽光 EPC 0xD1 (出力抑制状態) の EDT
const D1_OUTPUT_CONTROL = '41';
const D1_EXCEPT_CONTROL = '42';

const DA_TO_MODE = {
  [DA_RAPID_CHARGING]: 'charge',
  [DA_CHARGING]: 'charge',
  [DA_DISCHARGING]: 'discharge',
  [DA_STANDBY]: 'idle',
};
const MODE_TO_DA = { charge: DA_CHARGING, discharge: DA_DISCHARGING, idle: DA_STANDBY };

// 瞬時消費電力 (EPC 0x84) の有効範囲は 0..65533 W
const MAX_CONSUMER_W = 65533;
const CLASS_METER = '0288';
const CLASS_PV = '0279';
const CLASS_BATTERY = '027D';
const CLASS_EV = '027E'; // 電気自動車充放電器
// 積算履歴 (E2/E4) の 30 分コマ
const HALF_HOUR_MS = 30 * 60 * 1000;

function hexOf(v) {
  return String(v === undefined || v === null ? '' : v).replace(/^0x/i, '').toUpperCase();
}

// ローカル時刻のオフセット (ミリ秒)
function tzOffsetMs(ms) {
  return -new Date(ms).getTimezoneOffset() * 60000;
}

// 時刻 ms が属する 30 分コマの通し番号 (ローカル時刻基準)
function halfHourIndex(ms) {
  return Math.floor((ms + tzOffsetMs(ms)) / HALF_HOUR_MS);
}

// 30 分コマ H の開始時刻 (ミリ秒, ローカル時刻基準)
function halfHourStartMs(H) {
  const approx = H * HALF_HOUR_MS;
  return approx - tzOffsetMs(approx);
}

function u8(v) {
  const n = Math.max(0, Math.min(255, Math.round(v)));
  return n.toString(16).padStart(2, '0').toUpperCase();
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(Math.max(0, Math.min(0xFFFF, Math.round(v))));
  return b.toString('hex').toUpperCase();
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(Math.max(0, Math.min(0xFFFFFFFF, Math.round(v))));
  return b.toString('hex').toUpperCase();
}

function i32(v) {
  return i32Range(v, -2147483647, 2147483647);
}

// 符号付き 4 バイトの EDT。範囲外の値は [min, max] に丸める
function i32Range(v, min, max) {
  const b = Buffer.alloc(4);
  const n = Math.max(min, Math.min(max, Math.round(v)));
  b.writeInt32BE(n);
  return b.toString('hex').toUpperCase();
}

// 瞬時電力 E7 の有効範囲は -2147483647 .. 2147483645 W (2147483646, 2147483647 は未定義値)
const E7_MIN_W = -2147483647;
const E7_MAX_W = 2147483645;

class PowerSimulator {
  /* ------------------------------------------------------------------
  * Constructor
  * conf   : 設定 (simulation_* を参照)
  * device : ECHONET Lite デバイス (Device) のインスタンス
  * ---------------------------------------------------------------- */
  constructor(conf, device) {
    this._conf = conf || {};
    this._device = device || null;
    this._sys = this._createSystem();
    this._sys.setEv({
      enabled: this._conf.simulation_ev_enabled === true,
      charge_enabled: this._conf.simulation_ev_charge !== false,
      discharge_enabled: this._conf.simulation_ev_discharge !== false,
    });
    this._timer = null;
    this._busy = false;
    this._lastTickMs = null;
    this._lastDa = null;      // 最後に書き込んだ蓄電池 0xDA
    this._lastOn = {};        // 直近の機器電源状態 {eoj: boolean}
    this._lastLoads = [];     // 直近の機器消費電力 [{eoj, watts}]
    this.onupdated = (status) => { };
  }

  _createSystem() {
    const c = this._conf;
    return new PowerSystem({
      start: c.simulation_start || undefined,
      speed: c.simulation_speed === undefined ? 1 : c.simulation_speed,
    });
  }

  get system() {
    return this._sys;
  }

  setDevice(device) {
    this._device = device || null;
    this._lastDa = null;
  }

  updateConf(conf) {
    const prev = this._conf;
    this._conf = conf || {};
    if (prev.simulation_tick_msec !== this._conf.simulation_tick_msec
      || prev.simulation_enabled !== this._conf.simulation_enabled) {
      this.stop();
      this.start();
    }
  }

  /* ------------------------------------------------------------------
  * start() / stop()
  * ---------------------------------------------------------------- */
  start() {
    if (this._timer || this._conf.simulation_enabled === false) {
      return;
    }
    const msec = Math.max(100, Number(this._conf.simulation_tick_msec) || 1000);
    this._lastTickMs = null;
    this._timer = setInterval(() => {
      this._tick();
    }, msec);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /* ------------------------------------------------------------------
  * _tick()
  * 1 周期分（実時間）シミュレーションを進める
  * ---------------------------------------------------------------- */
  async _tick() {
    if (this._busy) {
      return;
    }
    this._busy = true;
    try {
      const devobjs = this._getDeviceObjects();
      if (!devobjs) {
        this._lastTickMs = null; // 停止中の時間は進めない
        this._histCursor = null;
        return;
      }
      const nowMs = Date.now();
      const tickMsec = Math.max(100, Number(this._conf.simulation_tick_msec) || 1000);
      const realSec = this._lastTickMs === null ? tickMsec / 1000 : (nowMs - this._lastTickMs) / 1000;
      this._lastTickMs = nowMs;

      await this._refreshLoads(devobjs);
      await this._adoptExternalBatteryMode(devobjs);

      const loads = this._lastLoads;
      this._sys.advance(realSec, () => loads);
      await this._writeEpcs(devobjs);
      this.onupdated(this.getStatusSync());
    } catch (error) {
      console.error('[SIM] ' + error.message);
    } finally {
      this._busy = false;
    }
  }

  _getDeviceObjects() {
    if (!this._device || typeof this._device.getDeviceObjects !== 'function') {
      return null;
    }
    if (typeof this._device.getPowerStatus === 'function' && !this._device.getPowerStatus()) {
      return null; // デバイス停止中はシミュレーションも止める
    }
    return this._device.getDeviceObjects();
  }

  // 機器の電源状態を読み、消費電力の一覧を作る
  async _refreshLoads(devobjs) {
    const loads = [];
    const on = {};
    for (const eoj of Object.keys(devobjs)) {
      if (!isConsumerEoj(eoj)) {
        continue;
      }
      const isOn = await this._isOn(devobjs[eoj]);
      on[eoj] = isOn;
      loads.push({ eoj, watts: isOn ? this._sys.consumerWatts(eoj) : 0 });
    }
    this._lastOn = on;
    this._lastLoads = loads;
  }

  async _isOn(devobj) {
    try {
      const res = await devobj.getEpcValues([{ epc: '80' }], true);
      return res && res.vals && hexOf(res.vals['80']) === '30';
    } catch (error) {
      return false;
    }
  }

  // 蓄電池 0xDA が前回書き込んだ値と異なれば、外部からの Set とみなしてモードを反映する
  async _adoptExternalBatteryMode(devobjs) {
    const battery = this._findByClass(devobjs, CLASS_BATTERY);
    if (!battery) {
      return;
    }
    const res = await battery.getEpcValues([{ epc: 'DA' }], true);
    const cur = hexOf(res && res.vals ? res.vals['DA'] : null);
    if (this._lastDa !== null && cur && cur !== this._lastDa && DA_TO_MODE[cur]) {
      this._sys.setBatteryMode(DA_TO_MODE[cur]);
    }
  }

  _findByClass(devobjs, cls) {
    const eoj = Object.keys(devobjs).find((e) => e.substring(0, 4) === cls);
    return eoj ? devobjs[eoj] : null;
  }

  // 計算結果を各 EPC に書き込む
  // 積算履歴 (E2/E4) を、シミュレーション時刻が 30 分コマを過ぎるたびに記録する。
  // 早回しで複数コマが一度に経過した場合は、前回値と今回値の直線補間で各コマ終了時点の値を求める。
  async _recordEnergyHistory(meter, m) {
    const now = this._sys.now.getTime();
    const H_now = halfHourIndex(now);
    const cur = this._histCursor;
    this._histCursor = { t: now, H: H_now, e0: m.buy_wh, e3: m.sell_wh };
    if (!cur || now < cur.t || H_now <= cur.H) {
      return;
    }
    const pad = (n) => String(n).padStart(2, '0');
    const entries = [];
    for (let H = cur.H; H < H_now; H++) {
      const end_ratio = (halfHourStartMs(H + 1) - cur.t) / (now - cur.t);
      const d = new Date(halfHourStartMs(H) + 60000); // コマ内の時刻
      entries.push({
        day_key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        slot: d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0),
        e2: cur.e0 + (m.buy_wh - cur.e0) * end_ratio,
        e4: cur.e3 + (m.sell_wh - cur.e3) * end_ratio,
      });
    }
    await meter.updateEnergyHistory(entries);
  }

  async _writeEpcs(devobjs) {
    const sys = this._sys;
    const m = sys.meter;
    const last = sys.snapshot().last || {};

    const meter = this._findByClass(devobjs, CLASS_METER);
    if (meter) {
      await meter.setEpcValues([
        { epc: 'E1', edt: '03' }, // 積算電力量単位 0.001 kWh (= 1 Wh)
        { epc: 'E0', edt: u32(m.buy_wh) },
        { epc: 'E3', edt: u32(m.sell_wh) },
        { epc: 'E7', edt: i32Range(m.instant_w, E7_MIN_W, E7_MAX_W) },
      ], true);
      await this._recordEnergyHistory(meter, m);
    }

    const pv = this._findByClass(devobjs, CLASS_PV);
    if (pv) {
      await pv.setEpcValues([
        { epc: 'E0', edt: u16(last.pv_ac_w || 0) },
        { epc: 'E1', edt: u32(m.pv_wh) },
        { epc: 'E3', edt: u32(m.sell_wh) },
        { epc: 'D1', edt: (last.curtail_w || 0) > 0 ? D1_OUTPUT_CONTROL : D1_EXCEPT_CONTROL },
      ], true);
    }

    // 各機器のプロファイルに、シミュレーションの消費電力 (0x84 瞬時消費電力) を反映する
    for (const l of this._lastLoads) {
      const obj = devobjs[l.eoj];
      if (obj) {
        await obj.setEpcValues([{ epc: '84', edt: u16(Math.min(l.watts, MAX_CONSUMER_W)) }], true);
      }
    }

    // EV 充放電器: 瞬時充放電電力 (0xD3)。EV 無効時は 0 を書く。
    // 積算 (0xD6 放電 / 0xD8 充電) は EV 有効時のみ更新する（無効中は値を据え置く）
    const ev = this._findByClass(devobjs, CLASS_EV);
    if (ev) {
      const evw = sys.ev.enabled ? (last.ev_w || 0) : 0;
      const evEdt = [{ epc: 'D3', edt: i32(evw) }];
      if (sys.ev.enabled) {
        evEdt.push(
          { epc: 'D6', edt: u32(m.ev_discharge_wh) },
          { epc: 'D8', edt: u32(m.ev_charge_wh) },
        );
      }
      await ev.setEpcValues(evEdt, true);
    }

    const battery = this._findByClass(devobjs, CLASS_BATTERY);
    if (battery) {
      const bw = last.battery_w || 0;
      const da = bw > 0 ? DA_CHARGING : (bw < 0 ? DA_DISCHARGING : DA_STANDBY);
      await battery.setEpcValues([
        { epc: 'D3', edt: i32(bw) },
        { epc: 'D6', edt: u32(m.battery_discharge_wh) },
        { epc: 'D8', edt: u32(m.battery_charge_wh) },
        { epc: 'E4', edt: u8(sys.battery.soc * 100) },
        { epc: 'DA', edt: da },
      ], true);
      this._lastDa = da;
    }
  }

  /* ------------------------------------------------------------------
  * 状態の取得
  * ---------------------------------------------------------------- */
  getStatusSync() {
    const snap = this._sys.snapshot();
    return {
      running: this._timer !== null,
      enabled: this._conf.simulation_enabled !== false,
      tick_msec: Number(this._conf.simulation_tick_msec) || 1000,
      ...snap,
      consumers: this._lastLoads.map((l) => ({
        eoj: l.eoj,
        on: Boolean(this._lastOn[l.eoj]),
        watts: l.watts,
        energy_wh: this._sys.meter.device_wh[l.eoj] || 0,
      })),
    };
  }

  async getStatus() {
    const devobjs = this._getDeviceObjects();
    if (devobjs) {
      await this._refreshLoads(devobjs);
    }
    return this.getStatusSync();
  }

  /* ------------------------------------------------------------------
  * 操作
  * ---------------------------------------------------------------- */
  setSpeed(speed) {
    this._sys.setSpeed(speed);
  }

  setTime(time) {
    this._sys.setTime(time);
    this._histCursor = null;
  }

  setSellEnabled(enabled) {
    this._sys.setSellEnabled(enabled);
  }

  setEv(p) {
    this._sys.setEv(p);
  }

  setBattery(p) {
    if (p.mode !== undefined) this._sys.setBatteryMode(p.mode);
    if (p.soc !== undefined) this._sys.setBatterySoc(p.soc);
    this._sys.setBatteryParams(p);
  }

  setPv(p) {
    if (p.test_w !== undefined) this._sys.setPvTestWatts(p.test_w);
    if (p.weather_factor !== undefined) this._sys.setPvWeatherFactor(p.weather_factor);
    if (p.capacity_kw !== undefined) this._sys.setPvCapacityKw(p.capacity_kw);
    if (p.profile !== undefined) this._sys.setPvProfile(p.profile);
  }

  setPcs(p) {
    this._sys.setPcs(p);
  }

  // 機器の消費電力上書き (watts) と電源 (on) の設定。on は EPC 0x80 に反映される。
  async setConsumer(p) {
    const eoj = String(p.eoj || '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(eoj)) {
      throw new Error('eoj must be a 6-digit hex EOJ');
    }
    if (p.watts !== undefined) {
      this._sys.setConsumerWatts(eoj, p.watts);
    }
    if (p.on !== undefined) {
      await this._setPowerEpc(eoj, Boolean(p.on));
    }
  }

  async _setPowerEpc(eoj, on) {
    const devobjs = this._getDeviceObjects();
    const devobj = devobjs ? devobjs[eoj] : null;
    if (!devobj) {
      throw new Error('The specified EOJ was not found in the device EOJ list: ' + eoj);
    }
    await devobj.setEpcValues([{ epc: '80', edt: on ? '30' : '31' }], true);
  }

  resetMeter() {
    this._sys.resetMeter();
  }

  /* ------------------------------------------------------------------
  * シナリオ
  * ---------------------------------------------------------------- */
  async exportScenario() {
    const devices = [];
    const devobjs = this._getDeviceObjects() || {};
    for (const eoj of Object.keys(devobjs)) {
      const entry = { eoj, on: await this._isOn(devobjs[eoj]) };
      devices.push(entry);
    }
    if (this._device && typeof this._device.getCurrentEojList === 'function' && devices.length === 0) {
      this._device.getCurrentEojList().forEach((e) => devices.push({ eoj: e.eoj, on: true }));
    }
    return this._sys.exportScenario(devices);
  }

  async importScenario(data) {
    // 先に検証だけ行い、失敗したら何も変更しない
    const parsed = parseScenario(data);
    if (!this._device || typeof this._device.setCurrentEojList !== 'function') {
      throw new Error('the device is not ready');
    }

    if (parsed.devices.length > 0) {
      const eojList = parsed.devices.map((d) => ({ eoj: String(d.eoj).toUpperCase() }));
      const res = await this._device.setCurrentEojList(eojList);
      if (res && res.result && res.result !== 0) {
        throw new Error(res.message || 'failed to restore the EOJ list');
      }
    }
    this._sys.loadScenario(data);
    for (const d of parsed.devices) {
      if (d.on !== undefined) {
        await this._setPowerEpc(String(d.eoj).toUpperCase(), Boolean(d.on));
      }
    }
    this._lastDa = null;
    return this.getStatus();
  }
}

// ノードプロファイル (0EF001) は Device が自動で追加するため含めない
PowerSimulator.DEFAULT_EOJ_LIST = [
  '028801', // 低圧スマート電力量メータ
  '027901', // 住宅用太陽光発電
  '027D01', // 蓄電池（パワコン機能を含む）
  '013001', // 家庭用エアコン
  '029001', // 一般照明
  '013301', // 換気扇
];

module.exports = PowerSimulator;
