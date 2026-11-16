# ECHONET Lite 機器エミュレータ

神奈川工科大学スマートハウス研究センター 2024.12.04

## Revision history

Date | Version  | Description
:-----------|:-----|:-----
2019.03.28 | V20190328 | First official release
2019.11.28 | V20191103 | Support EL device description V3.1
2019.12.07 | V20191207 | Fixed a following bug<br>Storage Battery(0x027D) EPC=0xAA, GET value is wrong after SET 0x00000000.
2019.12.22 | V20191222 | Fixed a following bug<br>Controller(0x05FF) does not display detailed information of discovered devices, when a device return a manufacture code that is not registered in the table.
2020.06.09 | V20191222 | Update Device Description to 3.1.6r3_sub to support Release M
2022.01.05 | V20220105 | Change to MRA from Device Description(\*1)</br>Add a function to disable internal clock for a time-escalated emulation(\*2)
2022.10.03 | V1.0.0 | - Updated property value of EPC:0x82 from "A" (0x41) to "a" (0x61) in case of Release A</br>- Removed "O" from options of Release Version at Register a new EOJ screen</br>- Added a method to launch this program by "npm start"
2023.12.18 | V1.1.0 | - Updated MRA to V1.2.0 that supports Appendix Release Q rev.1
2024.12.04 | V1.2.0 | - Updated MRA to V1.3.0 that supports Appendix Release R rev.2<br>- Improved device discovery performance<br>- Ignored EDT values if the ESV is "0x62: Get" in the "Send a Packet" widget<br>- Added an option that filters some packets in the "Packet Monitor" widget<br>- Added a pause button in the "Packet Monitor" widget

(\*1) Device Description data is created and maintained by KAIT. This data was transfered to ECHONET Consortium in 2021. After some updates and modifications of the data structure and data itself, ECHONET Consortium released the data as [Machine Readable Appendix (MRA)](https://echonet.jp/spec_g/#standard-08) on Dec. 1st 2021.

(\*2) Please refer to an operation manual for details

## Abstract

- ECHONET Lite機器エミュレータは30種類以上の機器エミュレーターです。全てのプロパティをサポートしています。
- ECHONET Lite認証試験及びECHONET Lite AIF認証試験に対応できるレベルの実装です。

## Required environment / 動作環境

- Windows, MacOS, Linuxなどで動作します。インストールおよび起動に関してはユーザーマニュアルを参照ください。

## コントローラとしての機能

- ECHONET Lite messageを作成、送信する機能
- 受信したECHONET Lite messageをパースする機能
- 送受信ログ機能

コントローラとして動作させる場合は、ノードプロファイル以外の機器オブジェクトを全て削除してから、コントローラを追加してください。

## プロパティの機能の実装について

以下のプロパティのみ内部動作が実装されています。

### 住宅用太陽光発電: PV Power Generation: 0x0279

|EPC   |Property name|Logic
|:-----|:------------|:-----
| 0xE2 | 積算発電電力量リセット設定 |Set(0xE2)で0xE1の値を0にする
| 0xE4 | 積算売電電力量リセット設定 |Set(0xE4)で0xE3の値を0にする

### 燃料電池: Fuel Cell: 0x027C

|EPC   |Property name|Logic
|:-----|:------------|:-----
| 0xC6 | 積算発電電力量リセット設定 |Set(0xC6)で0xC5の値を0にする
| 0xC9 | 積算ガス消費量リセット設定 |Set(0xC9)で0xC8の値を0にする
| 0xCE | 宅内積算消費電力量リセット設定 |Set(0xCE)で0xCDの値を0にする

### 蓄電池: Storage Battery: 0x027D

|EPC   |Property name|Logic
|:-----|:------------|:-----
| 0xD7| 積算放電電力量リセット設定 |Set(0xD7)で0xD6の値を0にする
| 0xD9| 積算充電電力量リセット設定 |Set(0xD9)で0xD8の値を0にする

### 電気自動車充放電器: EV Charger and Discharger: 0x027E

|EPC   |Property name|Logic
|:-----|:------------|:-----
| 0xD7 | 積算放電電力量リセット設定 |Set(0xD7)で0xD6の値を0にする
| 0xD9 | 積算充電電力量リセット設定 |Set(0xD9)で0xD8の値を0にする

### 電気自動車充電器: EV Charger: 0x02A1

|EPC   |Property name|Logic
|:-----|:------------|:-----
| 0xD9 | 積算充電電力量リセット設定 |Set(0xD9)で0xD8の値を0にする

### 分電盤メータリング: Power Distribution Board: 0x0287

|EPC   |Property name|Logic
|:-----|:------------|:-----
|0xB3  |積算電力量計測値リスト（片方向）|0xB2で指定した値
|0xB5  |瞬時電流計測値リスト（片方向）|0xB4で指定した値
|0xB7  |瞬時電力計測値リスト（片方向）|0xB6で指定した値
|0xBA  |積算電力量計測値リスト（双方向）|0xB9で指定した値
|0xBC  |瞬時電流計測値リスト（双方向）|0xBBで指定した値
|0xBE  |瞬時電力計測値リスト（双方向）|0xBDで指定した値
|0xC3  |積算電力量計測値履歴（正方向）|0xC5で指定した履歴値
|0xC4  |積算電力量計測値履歴（逆方向）|0xC5で指定した履歴値

### 低圧スマート電力量メータ: Low Voltage Smart Electric Energy Meter: 0x0288

|EPC   |Property name|Logic
|:-----|:------------|:-----
|0xE2  |積算電力量計測値履歴1（正方向計測値）|0xE5で指定した履歴値
|0xE4  |積算電力量計測値履歴1（逆方向計測値）|0xE5で指定した履歴値
|0xEC  |積算電力量計測値履歴2（正方向、逆方向計測値）|0xEDで指定した履歴値

### 高圧スマート電力量メータ: High Voltage Smart Electric Energy Meter: 0x028A

|EPC   |Property name|Logic
|:-----|:------------|:-----
|0xC6  |需要電力量計測値履歴|0xE1で指定した履歴値
|0xCE  |力測積算無効電力量（遅れ）計測値履歴|0xE1で指定した履歴値
|0xE7  |積算有効電力量計測値履歴|0xE1で指定した履歴値

## 電力シミュレーション

デフォルトで以下の機器構成を持ちます（保存済みの機器構成がない場合）。

- 低圧スマート電力量メータ (0x0288)
- 住宅用太陽光発電 (0x0279)
- 蓄電池 (0x027D。パワコンの出力・効率を含む)
- 家庭用エアコン (0x0130)、一般照明 (0x0290)、換気扇 (0x0133)

機器の消費電力は機器クラスごとの大まかな既定値を使います（例: エアコン 700 W、照明 60 W）。
電源 OFF の機器は 0 W として扱います。

### 機能

- **メーター集計**: 機器の消費電力、太陽光の発電、蓄電池の充放電から、買電・売電（逆潮流）・積算を自動計算し、各 EPC に反映します。
- **太陽光**: 時系列データ (`profile`) またはテスト値 (`test_w`) で発電量を指定できます。指定がなければ天候係数 (`weather_factor`) を掛けた晴天モデルを使います。
- **売電の切り替え**: `sell_enabled` を OFF にすると余剰電力は売電せず出力抑制します（EPC 0xD1 に反映）。
- **蓄電池の切り替え**: `mode` で `auto`（自動）・`charge`（充電）・`discharge`（放電）・`idle`（待機）を選べます。運転モード EPC 0xDA を外部から Set した場合もこの設定に反映されます。
- **時刻と加速**: シミュレーション時刻は `simulation_speed` 倍で進みます（例: 60 なら実時間 1 秒で 1 分）。
- **シナリオ**: 機器構成・電源状態・機器の消費電力・太陽光・パワコン・蓄電池・積算値・設定を JSON で書き出し・読み込みできます。

設定は `conf/config.js` の `simulation_enabled` / `simulation_speed` / `simulation_tick_msec` / `simulation_start` で指定します。

### REST API

| メソッド | パス | 内容 |
|:--|:--|:--|
| GET | /api/simulation | 状態の取得 |
| PUT | /api/simulation/speed | 時刻加速倍率 `{"speed": 60}` |
| PUT | /api/simulation/clock | シミュレーション時刻 `{"time": "2026-07-01T12:00:00"}` |
| PUT | /api/simulation/policy | 売電の許可 `{"sell_enabled": false}` |
| PUT | /api/simulation/battery | 蓄電池 `{"mode": "discharge", "soc": 0.8}` |
| PUT | /api/simulation/pv | 太陽光 `{"test_w": 2500}` / `{"weather_factor": 0.6}` / `{"profile": [{"time": "...", "w": 0}]}` |
| PUT | /api/simulation/pcs | パワコン `{"rated_kw": 5, "efficiency": 0.95}` |
| PUT | /api/simulation/consumer | 機器 `{"eoj": "013001", "watts": 900, "on": true}` |
| POST | /api/simulation/reset | 積算値のリセット |
| GET | /api/simulation/scenario | シナリオの書き出し |
| POST | /api/simulation/scenario | シナリオの読み込み `{"scenario": {...}}` |

テスト: `npm test`（Node.js 標準のテストランナーを使用）

## FAQ

Q:コンソール画面に以下のエラーが表示されます。  
A:3610ポートを利用するアプリケーション（SSNG for Node.jsなど）は、あらかじめ終了してください。  

```
[SY] Starting the device...                                            [  NG  ] 
{ Error: bind EADDRINUSE 0.0.0.0:3610
    at Object._errnoException (util.js:992:11)
    at _exceptionWithHostPort (util.js:1014:20)
    at _handle.lookup (dgram.js:266:18)
    at _combinedTickCallback (internal/process/next_tick.js:141:11)
    at process._tickCallback (internal/process/next_tick.js:180:9)
  code: 'EADDRINUSE',
  errno: 'EADDRINUSE',
  syscall: 'bind',
  address: '0.0.0.0',
  port: 3610 }
```

Q:WindowsでUDPの送受信が正常にできません。  
Q:Windowsでマルチキャストの送受信が正常にできません。  
A:ファイアウォール（Winodws defender)の設定で、Node.jsの通信が許可されていることを確認してください。  

Q:新規追加画面の機器リストに表示されない種類の機器を利用したい。  
A:MRA データを作成し、機器エミュレータに追加してください。

## License

MIT license

## Contact

contact@sh-center.org
