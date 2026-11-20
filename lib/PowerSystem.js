/* ------------------------------------------------------------------
* PowerSystem.js
* 電力シミュレーションのコアロジック（ECHONET Lite には依存しない）
*
* 構成:
*  - 機器の消費電力（既定値は機器クラスごとの大まかな値）
*  - 太陽光発電（時系列データ・テスト値・気象係数による天候モデル）
*  - パワーコンディショナ（DC→AC 変換効率と定格）
*  - 蓄電池（充放電モード・SOC・効率）
*  - 低圧スマートメーター相当の集計（買電・売電(逆潮流)・積算・機器別消費電力量）
*  - 時刻の概念と時刻加速（シミュレーション時刻 = 実時間 × 加速倍率）
*  - シナリオの書き出し・読み込み（JSON）
*
* 単位: 電力 W, 電力量 Wh, 時間 秒 (step) / 時間 h (energy)
* 符号: 買電・充電・消費は正。売電（逆潮流）・放電は負として扱う。
*   - グリッド電力 grid_w: 正=買電, 負=売電
*   - 蓄電池電力 battery_w: 正=充電, 負=放電
* ---------------------------------------------------------------- */
'use strict';

const SCENARIO_FORMAT = 'elemu-scenario';
const SCENARIO_VERSION = 1;
const BATTERY_MODES = ['auto', 'charge', 'discharge', 'idle'];
const EV_MODES = ['auto', 'charge', 'discharge', 'idle'];
const MAX_STEP_SEC = 60; // 時刻加速時も積分ステップは最大 60 秒に分割する

// 機器クラスごとの大まかな既定消費電力 (W)。クラスコード (4桁 hex) で指定する。
const CLASS_DEFAULT_WATTS = {
  '0130': 700,  // 家庭用エアコン
  '0133': 40,   // 換気扇
  '0135': 50,   // 空気清浄器
  '0156': 3000, // 業務用パッケージエアコン室内機
  '0263': 100,  // 電動雨戸・シャッター
  '0290': 60,   // 一般照明
  '0291': 40,   // 単機能照明
  '02A1': 3000, // EV充電器
};

// 消費電力を持たないクラス（発電・蓄電・計測・ノードプロファイル・コントローラー）
const NON_CONSUMER_CLASSES = ['0EF0', '05FF', '0288', '0287', '0279', '027C', '027D', '027E'];

// クラスグループ（上位2桁）ごとの既定値。個別指定がないクラスに使う。
const GROUP_DEFAULT_WATTS = {
  '01': 300, // 空調関連
  '02': 100, // 住宅・設備関連
  '03': 300, // 調理・家事関連
  '04': 60,  // 健康関連
  '06': 5,   // センサー関連
};
const FALLBACK_WATTS = 50;

/* ------------------------------------------------------------------
* defaultWatts(eoj)
* 機器 EOJ (6桁 hex) の既定消費電力 (W) を返す。消費しない機器は 0。
* ---------------------------------------------------------------- */
function defaultWatts(eoj) {
  const cls = String(eoj || '').substring(0, 4).toUpperCase();
  if (cls.length !== 4) {
    return 0;
  }
  if (NON_CONSUMER_CLASSES.indexOf(cls) >= 0) {
    return 0;
  }
  if (cls in CLASS_DEFAULT_WATTS) {
    return CLASS_DEFAULT_WATTS[cls];
  }
  const group = cls.substring(0, 2);
  if (group in GROUP_DEFAULT_WATTS) {
    return GROUP_DEFAULT_WATTS[group];
  }
  return FALLBACK_WATTS;
}

// 機器が消費電力を持つか（集計対象か）
function isConsumerEoj(eoj) {
  const cls = String(eoj || '').substring(0, 4).toUpperCase();
  return cls.length === 4 && NON_CONSUMER_CLASSES.indexOf(cls) < 0;
}

/* ------------------------------------------------------------------
* clearSkyFactor(date)
* 晴天時の日射係数 (0..1)。6時〜18時の正弦曲線、正午にピーク。
* ---------------------------------------------------------------- */
function clearSkyFactor(date) {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  if (hour <= 6 || hour >= 18) {
    return 0;
  }
  return Math.pow(Math.sin(Math.PI * (hour - 6) / 12), 1.2);
}

function num(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number`);
  }
  if (min !== undefined && n < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return n;
}

function optNum(v, name, min, max) {
  if (v === null || v === undefined) {
    return null;
  }
  return num(v, name, min, max);
}

class PowerSystem {
  /* ------------------------------------------------------------------
  * Constructor
  * opts.start : 開始時刻 (Date または ISO 文字列)。省略時は現在時刻
  * opts.speed : 時刻加速倍率 (実時間 1 秒あたりのシミュレーション秒数)
  * ---------------------------------------------------------------- */
  constructor(opts = {}) {
    this._now = opts.start ? new Date(opts.start) : new Date();
    if (Number.isNaN(this._now.getTime())) {
      throw new Error('start is not a valid date');
    }
    this._speed = 1;
    this.setSpeed(opts.speed === undefined ? 1 : opts.speed);

    // 太陽光発電
    this.pv = {
      capacity_kw: 4.0,
      weather_factor: 1.0,
      test_w: null,      // テスト用の固定発電量 (W)。設定時は他より優先
      profile: [],       // 時系列発電データ [{time: Date, w: number}]
    };

    // パワーコンディショナ
    this.pcs = {
      rated_kw: 4.0,
      efficiency: 0.95,
    };

    // 蓄電池
    this.battery = {
      capacity_wh: 9800,
      soc: 0.5,
      max_charge_w: 3000,
      max_discharge_w: 3000,
      efficiency: 0.95,
      mode: 'auto',
    };

    // EV 充放電器 (0x027E)。enabled が false のときはシミュレーションに一切入れない。
    // charge_enabled / discharge_enabled で充電・放電を個別に止められる（EV は余剰での充電・不足時の放電）。
    this.ev = {
      enabled: false,
      connected: true,    // 車両の接続状態。未接続なら充放電しない
      mode: 'auto',       // auto: 余剰で充電・不足で放電 / charge / discharge: 出力指定で固定 / idle: 待機
      power_w: 3000,      // charge / discharge モードの出力 (W)。max_* で上限を掛ける
      charge_enabled: true,
      discharge_enabled: true,
      capacity_wh: 40000,
      soc: 0.5,
      max_charge_w: 3000,
      max_discharge_w: 3000,
      efficiency: 0.95,
    };

    // 売電（逆潮流）を許可するか。false の場合、余剰電力は出力抑制される。
    this.sell_enabled = true;

    // 機器の消費電力の上書き値 (W)。null の機器は既定値を使う。 {eoj: watts}
    this.overrides = {};

    // 低圧スマートメーター相当の積算・計測値
    this.meter = {
      buy_wh: 0,          // 積算買電電力量 (正方向)
      sell_wh: 0,         // 積算売電電力量 (逆方向)
      instant_w: 0,       // 瞬時電力 (正=買電, 負=売電)
      load_w: 0,          // 機器の瞬時消費電力合計
      pv_wh: 0,           // 積算発電電力量 (パワコン出力 AC)
      pv_w: 0,            // 瞬時発電電力
      curtail_wh: 0,      // 出力抑制された電力量
      battery_charge_wh: 0,
      battery_discharge_wh: 0,
      ev_charge_wh: 0,    // EV への積算充電電力量（EV 有効時のみ増える）
      ev_discharge_wh: 0, // EV からの積算放電電力量
      device_wh: {},      // 機器ごとの積算消費電力量 {eoj: Wh}
    };

    // 直近ステップの結果
    this._last = null;
  }

  get now() {
    return new Date(this._now.getTime());
  }

  get speed() {
    return this._speed;
  }

  setSpeed(speed) {
    this._speed = num(speed, 'speed', Number.MIN_VALUE);
  }

  /* ------------------------------------------------------------------
  * setTime(date)
  * シミュレーション時刻を直接設定する（積算値は変更しない）
  * ---------------------------------------------------------------- */
  setTime(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) {
      throw new Error('time is not a valid date');
    }
    this._now = d;
  }

  /* ------------------------------------------------------------------
  * advance(real_sec, loadsFn)
  * 実時間 real_sec 秒ぶんシミュレーション時刻を進める（時刻加速を適用）。
  * loadsFn() は [{eoj, watts}] を返す。各ステップで呼び出される。
  * 戻り値: 最後のステップの結果
  * ---------------------------------------------------------------- */
  advance(real_sec, loadsFn) {
    return this.advanceSimulated(num(real_sec, 'real_sec', 0) * this._speed, loadsFn);
  }

  advanceSimulated(sim_sec, loadsFn) {
    let remain = num(sim_sec, 'sim_sec', 0);
    let last = this._last;
    while (remain > 0) {
      const dt = Math.min(MAX_STEP_SEC, remain);
      this._now = new Date(this._now.getTime() + dt * 1000);
      remain -= dt;
      const loads = loadsFn ? loadsFn() : [];
      last = this.step(dt, loads);
    }
    return last;
  }

  /* ------------------------------------------------------------------
  * pvWatts(date)
  * 太陽光発電の直流出力 (W)。テスト値 > 時系列データ > 天候モデル の順。
  * ---------------------------------------------------------------- */
  pvWatts(date) {
    if (this.pv.test_w !== null) {
      return Math.max(0, this.pv.test_w);
    }
    if (this.pv.profile.length > 0) {
      return Math.max(0, this._interpolateProfile(date));
    }
    return this.pv.capacity_kw * 1000 * this.pv.weather_factor * clearSkyFactor(date);
  }

  _interpolateProfile(date) {
    const pts = this.pv.profile;
    const t = date.getTime();
    if (t <= pts[0].time.getTime()) {
      return pts[0].w;
    }
    const last = pts[pts.length - 1];
    if (t >= last.time.getTime()) {
      return last.w;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const ta = a.time.getTime();
      const tb = b.time.getTime();
      if (t >= ta && t <= tb) {
        if (tb === ta) {
          return b.w;
        }
        return a.w + (b.w - a.w) * (t - ta) / (tb - ta);
      }
    }
    return last.w;
  }

  /* ------------------------------------------------------------------
  * consumerWatts(eoj)
  * 機器の現在の消費電力 (W)。上書き値があればそれを、なければ既定値。
  * 電源 OFF の判定は呼び出し側 (loads の watts に反映) が行う。
  * ---------------------------------------------------------------- */
  consumerWatts(eoj) {
    const key = String(eoj).toUpperCase();
    if (key in this.overrides && this.overrides[key] !== null) {
      return this.overrides[key];
    }
    return defaultWatts(key);
  }

  /* ------------------------------------------------------------------
  * step(dt_sec, loads)
  * 1ステップ分の電力フローを計算し、蓄電池と積算値を更新する。
  * loads: [{eoj, watts}]  (電源 OFF の機器は watts = 0)
  * ---------------------------------------------------------------- */
  step(dt_sec, loads) {
    const dt = num(dt_sec, 'dt_sec', 0);
    const dtH = dt / 3600;
    const list = Array.isArray(loads) ? loads : [];

    // 機器の消費電力
    let load_w = 0;
    list.forEach((l) => {
      const w = Math.max(0, Number(l.watts) || 0);
      load_w += w;
      if (isConsumerEoj(l.eoj)) {
        const key = String(l.eoj).toUpperCase();
        this.meter.device_wh[key] = (this.meter.device_wh[key] || 0) + w * dtH;
      }
    });

    // 太陽光 → パワコン (AC)
    const pv_dc = this.pvWatts(this._now);
    const pv_ac = Math.min(pv_dc * this.pcs.efficiency, this.pcs.rated_kw * 1000);

    // 余剰電力（+ 余り, - 不足）
    const surplus = pv_ac - load_w;

    // 蓄電池の要求値と実際の充放電
    const requested = this._batteryRequest(surplus);
    const batt_w = this._applyBattery(requested, dtH);

    // EV 充放電（有効時のみ）。蓄電池の後の残余電力で充放電する
    const ev_w = this._applyStorage(this.ev, this._evRequest(surplus - batt_w), dtH);

    // 残りを売電・出力抑制・買電に振り分ける
    const net = surplus - batt_w - ev_w;
    let grid_w = 0;
    let curtail_w = 0;
    if (net >= 0) {
      if (this.sell_enabled) {
        grid_w = -net;
      } else {
        curtail_w = net;
      }
    } else {
      grid_w = -net;
    }

    // 積算値の更新
    const m = this.meter;
    m.load_w = load_w;
    m.pv_w = pv_ac;
    m.instant_w = grid_w;
    if (grid_w > 0) {
      m.buy_wh += grid_w * dtH;
    } else if (grid_w < 0) {
      m.sell_wh += -grid_w * dtH;
    }
    m.pv_wh += pv_ac * dtH;
    m.curtail_wh += curtail_w * dtH;
    if (batt_w > 0) {
      m.battery_charge_wh += batt_w * dtH;
    } else if (batt_w < 0) {
      m.battery_discharge_wh += -batt_w * dtH;
    }
    if (ev_w > 0) {
      m.ev_charge_wh += ev_w * dtH;
    } else if (ev_w < 0) {
      m.ev_discharge_wh += -ev_w * dtH;
    }

    this._last = {
      time: this.now.toISOString(),
      load_w,
      pv_dc_w: pv_dc,
      pv_ac_w: pv_ac,
      battery_w: batt_w,
      ev_w,
      grid_w,
      curtail_w,
      soc: this.battery.soc,
    };
    return this._last;
  }

  // 蓄電池の充放電要求 (W)。+ 充電, - 放電
  _batteryRequest(surplus) {
    const b = this.battery;
    switch (b.mode) {
      case 'auto':
        if (surplus > 0) {
          return Math.min(surplus, b.max_charge_w);
        }
        if (surplus < 0) {
          return -Math.min(-surplus, b.max_discharge_w);
        }
        return 0;
      case 'charge':
        return b.max_charge_w;
      case 'discharge':
        // 売電を許可していなければ、家庭内で不足する分だけ放電する
        if (this.sell_enabled) {
          return -b.max_discharge_w;
        }
        return -Math.min(b.max_discharge_w, Math.max(0, -surplus));
      default: // idle
        return 0;
    }
  }

  // EV の充放電要求 (W)。rem は蓄電池の後に残る電力（+ 余剰, - 不足）。
  // 無効、または充電・放電それぞれが許可されていなければ 0。
  _evRequest(rem) {
    const e = this.ev;
    if (!e.enabled || !e.connected) {
      return 0;
    }
    switch (e.mode) {
      case 'charge':
        return e.charge_enabled ? Math.min(e.power_w, e.max_charge_w) : 0;
      case 'discharge':
        return e.discharge_enabled ? -Math.min(e.power_w, e.max_discharge_w) : 0;
      case 'idle':
        return 0;
      default: // auto
        if (rem > 0) {
          return e.charge_enabled ? Math.min(rem, e.max_charge_w) : 0;
        }
        if (rem < 0) {
          return e.discharge_enabled ? -Math.min(-rem, e.max_discharge_w) : 0;
        }
        return 0;
    }
  }

  // 要求を蓄電量の制約内で適用し、実際のバス上の電力 (W) を返す
  _applyBattery(requested_w, dtH) {
    return this._applyStorage(this.battery, requested_w, dtH);
  }

  // 蓄電池・EV 共通: 要求 requested_w (+ 充電, - 放電) を容量・SOC の制約内で適用する
  _applyStorage(b, requested_w, dtH) {
    if (requested_w === 0 || dtH <= 0) {
      return 0;
    }
    if (requested_w > 0) {
      // 充電: バス側電力 x 効率 = 蓄電量の増加
      const room_wh = b.capacity_wh * (1 - b.soc);
      const add_wh = Math.min(requested_w * dtH * b.efficiency, room_wh);
      b.soc = Math.min(1, b.soc + add_wh / b.capacity_wh);
      return add_wh / b.efficiency / dtH;
    }
    // 放電: 蓄電量の減少 / 効率 = バス側へ出る電力量
    const want_out_wh = -requested_w * dtH;
    const stored_wh = b.soc * b.capacity_wh;
    const take_wh = Math.min(want_out_wh / b.efficiency, stored_wh);
    b.soc = Math.max(0, (stored_wh - take_wh) / b.capacity_wh);
    return -(take_wh * b.efficiency) / dtH;
  }

  /* ------------------------------------------------------------------
  * 設定の切り替え API（簡単に切り替えられるようにするためのメソッド）
  * ---------------------------------------------------------------- */
  setSellEnabled(enabled) {
    this.sell_enabled = Boolean(enabled);
  }

  setBatteryMode(mode) {
    if (BATTERY_MODES.indexOf(mode) < 0) {
      throw new Error(`battery mode must be one of ${BATTERY_MODES.join(', ')}`);
    }
    this.battery.mode = mode;
  }

  setBatterySoc(soc) {
    this.battery.soc = num(soc, 'soc', 0, 1);
  }

  setPvTestWatts(watts) {
    this.pv.test_w = optNum(watts, 'test_w', 0);
  }

  setPvWeatherFactor(factor) {
    this.pv.weather_factor = num(factor, 'weather_factor', 0, 2);
  }

  setPvCapacityKw(kw) {
    this.pv.capacity_kw = num(kw, 'capacity_kw', 0);
  }

  setPvProfile(points) {
    this.pv.profile = parseProfile(points);
  }

  setPcs({ rated_kw, efficiency } = {}) {
    if (rated_kw !== undefined) {
      this.pcs.rated_kw = num(rated_kw, 'rated_kw', 0);
    }
    if (efficiency !== undefined) {
      this.pcs.efficiency = num(efficiency, 'efficiency', 0.01, 1);
    }
  }

  setBatteryParams({ capacity_wh, max_charge_w, max_discharge_w, efficiency } = {}) {
    const b = this.battery;
    if (capacity_wh !== undefined) b.capacity_wh = num(capacity_wh, 'capacity_wh', 1);
    if (max_charge_w !== undefined) b.max_charge_w = num(max_charge_w, 'max_charge_w', 0);
    if (max_discharge_w !== undefined) b.max_discharge_w = num(max_discharge_w, 'max_discharge_w', 0);
    if (efficiency !== undefined) b.efficiency = num(efficiency, 'efficiency', 0.01, 1);
  }

  setEv({ enabled, connected, mode, power_w, charge_enabled, discharge_enabled, capacity_wh, soc, max_charge_w, max_discharge_w, efficiency } = {}) {
    const e = this.ev;
    if (mode !== undefined && EV_MODES.indexOf(mode) < 0) {
      throw new Error(`ev.mode must be one of ${EV_MODES.join(', ')}`);
    }
    if (enabled !== undefined) e.enabled = Boolean(enabled);
    if (connected !== undefined) e.connected = Boolean(connected);
    if (mode !== undefined) e.mode = mode;
    if (power_w !== undefined) e.power_w = num(power_w, 'power_w', 0);
    if (charge_enabled !== undefined) e.charge_enabled = Boolean(charge_enabled);
    if (discharge_enabled !== undefined) e.discharge_enabled = Boolean(discharge_enabled);
    if (capacity_wh !== undefined) e.capacity_wh = num(capacity_wh, 'capacity_wh', 1);
    if (soc !== undefined) e.soc = num(soc, 'soc', 0, 1);
    if (max_charge_w !== undefined) e.max_charge_w = num(max_charge_w, 'max_charge_w', 0);
    if (max_discharge_w !== undefined) e.max_discharge_w = num(max_discharge_w, 'max_discharge_w', 0);
    if (efficiency !== undefined) e.efficiency = num(efficiency, 'efficiency', 0.01, 1);
  }

  setConsumerWatts(eoj, watts) {
    const key = String(eoj).toUpperCase();
    this.overrides[key] = optNum(watts, 'watts', 0);
  }

  /* ------------------------------------------------------------------
  * 積算値のリセット（ECHONET のリセット設定 EPC に相当）
  * ---------------------------------------------------------------- */
  resetMeter() {
    const m = this.meter;
    m.buy_wh = 0;
    m.sell_wh = 0;
    m.pv_wh = 0;
    m.curtail_wh = 0;
    m.battery_charge_wh = 0;
    m.battery_discharge_wh = 0;
    m.ev_charge_wh = 0;
    m.ev_discharge_wh = 0;
    m.device_wh = {};
  }

  /* ------------------------------------------------------------------
  * snapshot()
  * 現在の状態（API・画面向け）
  * ---------------------------------------------------------------- */
  snapshot() {
    return {
      time: this.now.toISOString(),
      speed: this._speed,
      sell_enabled: this.sell_enabled,
      pv: {
        capacity_kw: this.pv.capacity_kw,
        weather_factor: this.pv.weather_factor,
        test_w: this.pv.test_w,
        profile_points: this.pv.profile.length,
      },
      pcs: { ...this.pcs },
      battery: { ...this.battery },
      ev: { ...this.ev },
      meter: JSON.parse(JSON.stringify(this.meter)),
      last: this._last,
    };
  }

  /* ------------------------------------------------------------------
  * exportScenario(devices)
  * システム全体のシナリオを JSON 化する。
  *   devices: [{eoj, on, ...}] 機器一覧（ECHONET 側の情報。省略可）
  * ---------------------------------------------------------------- */
  exportScenario(devices = []) {
    return {
      format: SCENARIO_FORMAT,
      version: SCENARIO_VERSION,
      time: this.now.toISOString(),
      speed: this._speed,
      policy: { sell_enabled: this.sell_enabled },
      pv: {
        capacity_kw: this.pv.capacity_kw,
        weather_factor: this.pv.weather_factor,
        test_w: this.pv.test_w,
        profile: this.pv.profile.map((p) => ({ time: p.time.toISOString(), w: p.w })),
      },
      pcs: { ...this.pcs },
      battery: { ...this.battery },
      ev: { ...this.ev },
      meter: JSON.parse(JSON.stringify(this.meter)),
      overrides: { ...this.overrides },
      devices: JSON.parse(JSON.stringify(devices || [])),
    };
  }

  /* ------------------------------------------------------------------
  * loadScenario(data)
  * シナリオ JSON を読み込んで自身の状態を置き換える。
  * 不正な値があれば例外を投げ、状態は変更しない。
  * 戻り値: 機器一覧 (devices) — 呼び出し側が ECHONET 側へ反映する
  * ---------------------------------------------------------------- */
  loadScenario(data) {
    const next = parseScenario(data);
    this._now = next.time;
    this._speed = next.speed;
    this.sell_enabled = next.sell_enabled;
    this.pv = next.pv;
    this.pcs = next.pcs;
    this.battery = next.battery;
    this.ev = next.ev;
    this.meter = next.meter;
    this.overrides = next.overrides;
    this._last = null;
    return next.devices;
  }
}

/* ------------------------------------------------------------------
* parseProfile(points)
* [{time: ISO文字列, w: number}] を検証して Date に変換する
* ---------------------------------------------------------------- */
function parseProfile(points) {
  if (points === null || points === undefined) {
    return [];
  }
  if (!Array.isArray(points)) {
    throw new Error('profile must be an array');
  }
  const out = points.map((p, i) => {
    if (!p || typeof p !== 'object') {
      throw new Error(`profile[${i}] must be an object`);
    }
    const t = new Date(p.time);
    if (Number.isNaN(t.getTime())) {
      throw new Error(`profile[${i}].time is not a valid date`);
    }
    return { time: t, w: num(p.w, `profile[${i}].w`, 0) };
  });
  out.sort((a, b) => a.time.getTime() - b.time.getTime());
  return out;
}

/* ------------------------------------------------------------------
* parseScenario(data)
* シナリオを検証し、新しい状態オブジェクトを返す（副作用なし）
* ---------------------------------------------------------------- */
function parseScenario(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('scenario must be an object');
  }
  if (data.format !== SCENARIO_FORMAT) {
    throw new Error(`format must be "${SCENARIO_FORMAT}"`);
  }
  if (data.version !== SCENARIO_VERSION) {
    throw new Error(`unsupported scenario version: ${data.version}`);
  }

  const time = new Date(data.time);
  if (Number.isNaN(time.getTime())) {
    throw new Error('time is not a valid date');
  }
  const speed = num(data.speed === undefined ? 1 : data.speed, 'speed', Number.MIN_VALUE);

  const pvIn = data.pv || {};
  const pv = {
    capacity_kw: num(pvIn.capacity_kw === undefined ? 4 : pvIn.capacity_kw, 'pv.capacity_kw', 0),
    weather_factor: num(pvIn.weather_factor === undefined ? 1 : pvIn.weather_factor, 'pv.weather_factor', 0, 2),
    test_w: optNum(pvIn.test_w, 'pv.test_w', 0),
    profile: parseProfile(pvIn.profile || []),
  };

  const pcsIn = data.pcs || {};
  const pcs = {
    rated_kw: num(pcsIn.rated_kw === undefined ? 4 : pcsIn.rated_kw, 'pcs.rated_kw', 0),
    efficiency: num(pcsIn.efficiency === undefined ? 0.95 : pcsIn.efficiency, 'pcs.efficiency', 0.01, 1),
  };

  const bIn = data.battery || {};
  const battery = {
    capacity_wh: num(bIn.capacity_wh === undefined ? 9800 : bIn.capacity_wh, 'battery.capacity_wh', 1),
    soc: num(bIn.soc === undefined ? 0.5 : bIn.soc, 'battery.soc', 0, 1),
    max_charge_w: num(bIn.max_charge_w === undefined ? 3000 : bIn.max_charge_w, 'battery.max_charge_w', 0),
    max_discharge_w: num(bIn.max_discharge_w === undefined ? 3000 : bIn.max_discharge_w, 'battery.max_discharge_w', 0),
    efficiency: num(bIn.efficiency === undefined ? 0.95 : bIn.efficiency, 'battery.efficiency', 0.01, 1),
    mode: bIn.mode === undefined ? 'auto' : bIn.mode,
  };
  if (BATTERY_MODES.indexOf(battery.mode) < 0) {
    throw new Error(`battery.mode must be one of ${BATTERY_MODES.join(', ')}`);
  }

  // EV は旧シナリオ（ev なし）では無効のまま読み込む
  const evIn = data.ev || {};
  const ev = {
    enabled: evIn.enabled === undefined ? false : Boolean(evIn.enabled),
    connected: evIn.connected === undefined ? true : Boolean(evIn.connected),
    mode: evIn.mode === undefined ? 'auto' : evIn.mode,
    power_w: num(evIn.power_w === undefined ? 3000 : evIn.power_w, 'ev.power_w', 0),
    charge_enabled: evIn.charge_enabled === undefined ? true : Boolean(evIn.charge_enabled),
    discharge_enabled: evIn.discharge_enabled === undefined ? true : Boolean(evIn.discharge_enabled),
    capacity_wh: num(evIn.capacity_wh === undefined ? 40000 : evIn.capacity_wh, 'ev.capacity_wh', 1),
    soc: num(evIn.soc === undefined ? 0.5 : evIn.soc, 'ev.soc', 0, 1),
    max_charge_w: num(evIn.max_charge_w === undefined ? 3000 : evIn.max_charge_w, 'ev.max_charge_w', 0),
    max_discharge_w: num(evIn.max_discharge_w === undefined ? 3000 : evIn.max_discharge_w, 'ev.max_discharge_w', 0),
    efficiency: num(evIn.efficiency === undefined ? 0.95 : evIn.efficiency, 'ev.efficiency', 0.01, 1),
  };

  if (EV_MODES.indexOf(ev.mode) < 0) {
    throw new Error(`ev.mode must be one of ${EV_MODES.join(', ')}`);
  }

  const mIn = data.meter || {};
  const meter = {
    buy_wh: num(mIn.buy_wh || 0, 'meter.buy_wh', 0),
    sell_wh: num(mIn.sell_wh || 0, 'meter.sell_wh', 0),
    instant_w: 0,
    load_w: 0,
    pv_wh: num(mIn.pv_wh || 0, 'meter.pv_wh', 0),
    pv_w: 0,
    curtail_wh: num(mIn.curtail_wh || 0, 'meter.curtail_wh', 0),
    battery_charge_wh: num(mIn.battery_charge_wh || 0, 'meter.battery_charge_wh', 0),
    battery_discharge_wh: num(mIn.battery_discharge_wh || 0, 'meter.battery_discharge_wh', 0),
    ev_charge_wh: num(mIn.ev_charge_wh || 0, 'meter.ev_charge_wh', 0),
    ev_discharge_wh: num(mIn.ev_discharge_wh || 0, 'meter.ev_discharge_wh', 0),
    device_wh: {},
  };
  const dwh = mIn.device_wh || {};
  Object.keys(dwh).forEach((eoj) => {
    if (!/^[0-9A-Fa-f]{6}$/.test(eoj)) {
      throw new Error(`meter.device_wh has an invalid EOJ: ${eoj}`);
    }
    meter.device_wh[eoj.toUpperCase()] = num(dwh[eoj], `meter.device_wh.${eoj}`, 0);
  });

  const overrides = {};
  const ov = data.overrides || {};
  Object.keys(ov).forEach((eoj) => {
    if (!/^[0-9A-Fa-f]{6}$/.test(eoj)) {
      throw new Error(`overrides has an invalid EOJ: ${eoj}`);
    }
    overrides[eoj.toUpperCase()] = optNum(ov[eoj], `overrides.${eoj}`, 0);
  });

  const devices = Array.isArray(data.devices) ? data.devices : [];

  return {
    time,
    speed,
    sell_enabled: data.policy && data.policy.sell_enabled !== undefined
      ? Boolean(data.policy.sell_enabled) : true,
    pv,
    pcs,
    battery,
    ev,
    meter,
    overrides,
    devices,
  };
}

module.exports = {
  PowerSystem,
  defaultWatts,
  isConsumerEoj,
  clearSkyFactor,
  parseScenario,
  BATTERY_MODES,
  SCENARIO_FORMAT,
  SCENARIO_VERSION,
};
