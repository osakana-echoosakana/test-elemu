'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mMra = require('../lib/Mra.js');
const mManufacturerTable = require('../lib/ManufacturerTable.js');
const HttpApi = require('../lib/HttpApi.js');

// 保存済み・既定の EOJ リストで epc を持たないエントリ (getCurrentEoj が返すもの) を模擬する
function makeApi(entry) {
  const device = {
    getCurrentEoj: (eoj) => (eoj === entry.eoj ? JSON.parse(JSON.stringify(entry)) : null),
    getEpcValues: async (eoj, props) => ({
      elProperties: props.map((p) => ({ epc: p.epc, edt: null })),
    }),
  };
  return new HttpApi({}, device, null, mMra, mManufacturerTable);
}

function getEpcs(api, eoj) {
  const req = { reqId: 1, method: 'GET', path: `/api/device/eojs/${eoj}/epcs`, params: {} };
  return api.request(req).then((res) => res);
}

test('EPC GET does not crash when the EOJ entry has no epc array', async () => {
  const api = makeApi({ eoj: '028801', release: 'R' });
  const res = await getEpcs(api, '028801');
  assert.equal(res.code, 200, res.message);
  const epcs = res.data.elProperties.map((p) => p.epc);
  const desc = mMra.getEoj('028801', undefined, 'R');
  assert.deepEqual(epcs.slice().sort(), Object.keys(desc.elProperties).sort());
  assert.ok(epcs.indexOf('E7') >= 0, 'instantaneous power EPC is included');
});

test('EPC GET uses the epc array when the entry has one', async () => {
  const api = makeApi({ eoj: '013001', release: 'R', epc: ['80', '8A'] });
  const res = await getEpcs(api, '013001');
  assert.equal(res.code, 200, res.message);
  assert.deepEqual(res.data.elProperties.map((p) => p.epc), ['80', '8A']);
});

test('EPC GET returns 404 for an EOJ that is not in the list', async () => {
  const api = makeApi({ eoj: '013001', release: 'R', epc: ['80'] });
  const res = await getEpcs(api, '028801');
  assert.equal(res.code, 404);
});
