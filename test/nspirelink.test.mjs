// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 CalcPlex. Part of nspirelink: https://github.com/calcplex/nspirelink
//
// nspirelink against the simulated CX and CX II (sim/calculator.mjs). The
// byte vectors are packets as TI's OS 4.5.5 sent and accepted them.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NspireLink, NspireLinkError, encodePacket, decodePacket, dataChecksum, encodeNnse, decodeNnse, nnseChecksum,
  encodePath, versionString, modelOf, LINK_LOST,
} from '../nspirelink.mjs';
import { SimNspire } from '../sim/calculator.mjs';

const hex = b => Buffer.from(b).toString('hex');
const bytes = h => Uint8Array.from(Buffer.from(h, 'hex'));

async function connect(simOptions = {}, linkOptions = {}) {
  const sim = new SimNspire(simOptions);
  const link = NspireLink.fromDevice(sim, { timeout: 500, addressWait: 200, ...linkOptions });
  await link.open();
  await link.ready();
  return { sim, link };
}

function pattern(n, seed = 1) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xFF;
  return b;
}

test('packets match the bytes TI\'s OS exchanged', () => {
  // The address answer and a device information request, as sent.
  assert.equal(hex(encodePacket({ srcAddr: 0x6400, srcSid: 0x4003, dstAddr: 0x6401, dstSid: 0x4003, seq: 1, data: [0x64, 0x01, 0xFF, 0x00] })),
    '54fd64004003640140031343040001fb6401ff00');
  assert.equal(hex(encodePacket({ srcAddr: 0x6400, srcSid: 0x8000, dstAddr: 0x6401, dstSid: 0x4020, seq: 1, data: [0x01] })),
    '54fd64008000640140200100010001fd01');
  // The calculator's address request and an acknowledgement, as received.
  const req = decodePacket(bytes('54fd0000400300004003ec0f020001d50fec'));
  assert.deepEqual([req.srcSid, req.dstSid, req.seq, hex(req.data)], [0x4003, 0x4003, 1, '0fec']);
  const ack = decodePacket(bytes('54fd640100ff640080002040020a01064020'));
  assert.deepEqual([ack.srcSid, ack.dstSid, ack.ack, hex(ack.data)], [0xFF, 0x8000, 0x0A, '4020']);
  assert.equal(dataChecksum([0x64, 0x01, 0xFF, 0x00]), 0x1343);
});

test('a packet with a bad checksum or magic is a PROTOCOL error', () => {
  const good = bytes('54fd640100ff640080002040020a01064020');
  for (const [i, v] of [[0, 0x55], [15, 0x00], [17, 0x21]]) {
    const bad = good.slice();
    bad[i] = v;
    assert.throws(() => decodePacket(bad), e => e.code === 'PROTOCOL');
  }
});

test('big data carries its length in four bytes', () => {
  const data = pattern(1440);
  const p = encodePacket({ srcAddr: 1, srcSid: 2, dstAddr: 3, dstSid: 4, data });
  assert.equal(p[12], 0xFF);
  assert.equal(p.length, 16 + 4 + 1440);
  assert.deepEqual(decodePacket(p).data, data);
});

test('NNSE checksum and framing round-trip', () => {
  const m = encodeNnse({ service: 4, reqAck: 1, seqno: 7, data: [1, 2, 3] });
  assert.equal(nnseChecksum(m), 0xFFFF);
  const d = decodeNnse(m);
  assert.deepEqual([d.service, d.reqAck, d.seqno, d.length, [...d.data]], [4, 1, 7, 15, [1, 2, 3]]);
  const bad = m.slice();
  bad[13] ^= 1;
  assert.equal(decodeNnse(bad), null);
});

test('paths are padded to nine bytes and checked', () => {
  assert.equal(hex(encodePath('/t.tns')), '2f742e746e73000000');
  assert.equal(encodePath('/a/long/folder/name.tns').length, 24);
  for (const p of ['t.tns', '', '/a\0b', '/' + 'x'.repeat(239), 42]) {
    assert.throws(() => encodePath(p), e => e.code === 'BAD_PATH');
  }
});

test('versions unpack minor and patch from one byte', () => {
  assert.equal(versionString([4, 55, 0, 79]), '4.5.5.79');
  assert.equal(versionString([6, 40, 0, 74]), '6.4.0.74');
  assert.equal(versionString([5, 0, 0x06, 0x93]), '5.0.0.1683');
});

test('the model comes from the product id, hardware type and OS file', () => {
  assert.deepEqual(modelOf(0xE022, { osExtension: '.tcc2' }), { model: 'cx2', cas: true, name: 'TI-Nspire CX II CAS' });
  assert.deepEqual(modelOf(0xE022, { osExtension: '.tco2' }), { model: 'cx2', cas: false, name: 'TI-Nspire CX II' });
  assert.deepEqual(modelOf(0xE012, { hwType: 0x1F, osExtension: '.tco' }), { model: 'cx', cas: false, name: 'TI-Nspire CX' });
  assert.deepEqual(modelOf(0xE012, { hwType: 0x0F, osExtension: '.tcc' }), { model: 'cx', cas: true, name: 'TI-Nspire CX CAS' });
  assert.equal(modelOf(0xE012, { hwType: 0x1E, osExtension: '.tno' }).model, 'classic');
  assert.equal(modelOf(0xE012, {}).model, 'other');
});

for (const model of ['cx', 'cx2']) {
  test(`${model}: connect and read the device information`, async () => {
    const { sim, link } = await connect({ model, os: model === 'cx2' ? '6.4.0.74' : '4.5.5.79', osExtension: model === 'cx2' ? '.tcc2' : '.tco' });
    const info = await link.info();
    assert.equal(info.model, model);
    assert.equal(info.cx2, model === 'cx2');
    assert.equal(info.os, model === 'cx2' ? '6.4.0.74' : '4.5.5.79');
    assert.equal(info.boot1, model === 'cx2' ? '5.0.0.42' : '4.0.1.43');
    assert.equal(info.storageTotal, 100_000_000);
    assert.equal(info.fileExtension, '.tns');
    assert.equal(info.lcd.width, 320);
    assert.ok(!('electronicId' in info));
    assert.deepEqual(sim.violations, []);
    await link.close();
  });

  test(`${model}: list, mkdir, put, get, attr, delete, rmdir`, async () => {
    const { sim, link } = await connect({ model, files: { '/Games/Old.tns': pattern(10) } });
    const root = await link.list('/');
    assert.deepEqual(root.map(e => [e.name, e.dir]).sort(), [['Examples', true], ['Games', true], ['MyLib', true]]);
    assert.deepEqual(await link.list('/Games'), [{ name: 'Old.tns', size: 10, date: 1000, dir: false }]);
    await link.mkdir('/CalcPlex');
    for (const n of [0, 1, 252, 253, 254, 1439, 1440, 5000, 26612]) {
      const data = pattern(n, n);
      const progress = [];
      const r = await link.put(`/CalcPlex/F${n}.tns`, data, { onProgress: (s, t) => progress.push([s, t]) });
      assert.deepEqual(r, { path: `/CalcPlex/F${n}.tns`, bytes: n });
      if (n) assert.deepEqual(progress.at(-1), [n, n]);
      assert.deepEqual(sim.files.get(`/CalcPlex/F${n}.tns`).bytes, data);
      assert.deepEqual(await link.get(`/CalcPlex/F${n}.tns`), data);
      assert.equal((await link.attr(`/CalcPlex/F${n}.tns`)).size, n);
    }
    // Replacing a file of the same name.
    await link.put('/CalcPlex/F1.tns', pattern(3, 9));
    assert.deepEqual(await link.get('/CalcPlex/F1.tns'), pattern(3, 9));
    for (const n of [0, 1, 252, 253, 254, 1439, 1440, 5000, 26612]) await link.delete(`/CalcPlex/F${n}.tns`);
    assert.deepEqual(await link.list('/CalcPlex'), []);
    await link.rmdir('/CalcPlex');
    assert.equal(await link.attr('/CalcPlex'), null);
    assert.deepEqual(sim.violations, []);
  });

  test(`${model}: refusals carry TI's codes and leave the link open`, async () => {
    const { sim, link } = await connect({ model, files: { '/Full/x.tns': [1] } });
    const codes = {};
    const tryCode = async (name, fn) => { try { await fn(); codes[name] = 'ok'; } catch (e) { codes[name] = [e.code, e.reply, e.op]; } };
    await tryCode('list', () => link.list('/nope'));
    await tryCode('get', () => link.get('/nope.tns'));
    await tryCode('delete', () => link.delete('/nope.tns'));
    await tryCode('rmdir', () => link.rmdir('/nope'));
    await tryCode('rmdirFull', () => link.rmdir('/Full'));
    await tryCode('mkdir', () => link.mkdir('/Full'));
    await tryCode('putNoFolder', () => link.put('/nofolder/x.tns', [1, 2, 3]));
    sim.full = true;
    await tryCode('putFull', () => link.put('/x.tns', [1, 2, 3]));
    assert.deepEqual(codes, {
      list: ['NOT_FOUND', 'ff 0a', 'list'],
      get: ['NOT_FOUND', 'ff 0a', 'get'],
      delete: ['REFUSED', 'ff 0a', 'delete'],
      rmdir: ['REFUSED', 'ff 0a', 'rmdir'],
      rmdirFull: ['REFUSED', 'ff 18', 'rmdir'],
      mkdir: ['EXISTS', 'ff 12', 'mkdir'],
      putNoFolder: ['REFUSED', 'ff 09', 'put'],
      putFull: ['REFUSED', 'ff 0c', 'put'],
    });
    assert.equal(link.opened, true);
    assert.equal((await link.info()).model, model);
    assert.deepEqual(sim.violations, []);
  });

  test(`${model}: a calculator that goes silent times out and closes the link`, async () => {
    const { sim, link } = await connect({ model });
    sim.silent = true;
    await assert.rejects(link.info(), e => e.code === 'TIMEOUT' && e.op === 'info');
    assert.equal(link.opened, false);
    await assert.rejects(link.list('/'), e => e.code === 'LINK_CLOSED');
    // A new open() and ready() start over.
    sim.silent = false;
    await link.open();
    await link.ready();
    assert.equal((await link.info()).model, model);
  });

  test(`${model}: an unplugged calculator is DISCONNECTED`, async () => {
    const { sim, link } = await connect({ model });
    const pending = link.list('/');
    sim.unplug();
    await assert.rejects(pending, e => e.code === 'DISCONNECTED' || e.code === 'TIMEOUT');
    assert.ok(LINK_LOST.includes('DISCONNECTED'));
    assert.equal(link.opened, false);
  });
}

test('cx: operations run one at a time in call order', async () => {
  const { sim, link } = await connect({ model: 'cx' });
  const order = [];
  await Promise.all([
    link.put('/a.tns', pattern(600)).then(() => order.push('put')),
    link.list('/').then(l => order.push(l.some(e => e.name === 'a.tns') ? 'list-after' : 'list-before')),
    link.delete('/a.tns').then(() => order.push('delete')),
  ]);
  assert.deepEqual(order, ['put', 'list-after', 'delete']);
  assert.deepEqual(sim.violations, []);
});

test('cx: the OS\'s own session after a file read is refused as libnspire does', async () => {
  const { sim, link } = await connect({ model: 'cx', files: { '/a.tns': pattern(300) } });
  const seen = [];
  link.onAnomaly = kind => seen.push(kind);
  await link.get('/a.tns');
  await link.list('/');
  assert.ok(seen.filter(k => k === 'foreignPacket').length >= 2);
  assert.deepEqual(sim.violations, []);
});

test('cx: a calculator that sends no address request is addressed anyway', async () => {
  const { sim, link } = await connect({ model: 'cx' }, {});
  // A second session without a fresh address request.
  sim.noAddressRequest = true;
  const again = NspireLink.fromDevice(sim, { timeout: 500, addressWait: 100 });
  await link.close();
  await again.open();
  await again.ready();
  assert.equal(again.anomalies.noAddressRequest, 1);
  assert.equal((await again.info()).model, 'cx');
});

test('cx: a refused reset is an anomaly, not a failure', async () => {
  const sim = new SimNspire({ model: 'cx' });
  await sim.open();
  await sim.selectConfiguration(1);
  await sim.claimInterface(0);
  await sim.reset();
  await sim.close();
  sim.refuseReset = true;
  const link = NspireLink.fromDevice(sim, { timeout: 500, addressWait: 300 });
  await link.open();
  await link.ready();
  assert.equal(link.anomalies.resetFailed, 1);
  assert.equal((await link.info()).model, 'cx');
});

test('cx: a refused packet is NACK and closes the link', async () => {
  const { sim, link } = await connect({ model: 'cx' });
  sim.nackNext = true;
  await assert.rejects(link.info(), e => e.code === 'NACK');
  assert.equal(link.opened, false);
});

test('operations before open() or ready() say so', async () => {
  const sim = new SimNspire({ model: 'cx2' });
  const link = NspireLink.fromDevice(sim);
  await assert.rejects(link.info(), e => e.code === 'NOT_OPEN');
  await link.open();
  await assert.rejects(link.info(), e => e.code === 'NOT_READY');
});

test('a device that is not a TI-Nspire is refused before it is opened', async () => {
  const sim = new SimNspire({ model: 'cx' });
  sim.productId = 0xE008;
  const link = NspireLink.fromDevice(sim);
  await assert.rejects(link.open(), e => e.code === 'NOT_NSPIRE' && e.productId === 0xE008);
  assert.equal(sim.opened, false);
});

test('request() filters on the Nspire product ids and maps a cancel', async () => {
  let filters;
  const usb = {
    requestDevice: async o => { filters = o.filters; throw Object.assign(new Error('none'), { name: 'NotFoundError' }); },
    getDevices: async () => [new SimNspire({ model: 'cx' }), Object.assign(new SimNspire({ model: 'cx2' }), { productId: 0xE008 })],
  };
  await assert.rejects(NspireLink.request({ usb }), e => e instanceof NspireLinkError && e.code === 'NO_DEVICE_SELECTED');
  assert.deepEqual(filters, [{ vendorId: 0x0451, productId: 0xE012 }, { vendorId: 0x0451, productId: 0xE022 }]);
  assert.equal((await NspireLink.granted({ usb })).length, 1);
  await assert.rejects(NspireLink.request({ usb: undefined }), e => e.code === 'NO_WEBUSB');
});

test('cx2: the handshake answers address, service 8 and time', async () => {
  const { sim, link } = await connect({ model: 'cx2' });
  await link.info();
  const services = sim.log.filter(l => l.dir === 'out' && !(l.bytes[1] & 0x80)).map(l => l.bytes[1]);
  // Address answered twice, acknowledgements, service 8 and the time, then streams.
  assert.deepEqual(services.slice(0, 2), [0x01, 0x01]);
  assert.ok(services.includes(0x02) && services.includes(0x08));
  assert.deepEqual(sim.violations, []);
});

test('cx2: a 64-byte message padded to 65 bytes in one transfer does not shift the next read', async () => {
  // A real CX II CAS sends a 64-byte NNSE message as a 65-byte transfer; keeping
  // the pad byte made the next header read "0 bytes long" and broke list().
  const files = {};
  for (let k = 1; k <= 64; k++) files[`/pad/${'n'.repeat(k)}.tns`] = [1, 2, 3];
  const sim = new SimNspire({ model: 'cx2', files });
  const link = NspireLink.fromDevice(sim, { timeout: 500 });
  await link.open();
  await link.ready();
  const names = (await link.list('/pad')).map(e => e.name).sort();
  assert.deepEqual(names, Object.keys(files).map(p => p.slice(5)).sort());
  assert.ok(sim.log.some(t => t.dir === 'in' && t.bytes.length % 64 === 1), 'the simulator padded a message');
  assert.ok(link.anomalies.paddingDropped >= 1);
  assert.equal((await link.info()).model, 'cx2');
  assert.deepEqual(sim.violations, []);
});
