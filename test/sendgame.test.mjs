// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 CalcPlex. Part of nspirelink: https://github.com/calcplex/nspirelink
//
// The games page's logic (sendgame.mjs), against the simulated CX and CX II.

import test from 'node:test';
import assert from 'node:assert/strict';
import { NspireLink } from '../nspirelink.mjs';
import { SimNspire } from '../sim/calculator.mjs';
import {
  openLink, readCalculator, sendGame, deleteGame, sendText, deleteText, failReason, failText, platformOf,
  connectParams, calcLine, SPACE_MARGIN, failDetail,
} from '../calcplex/sendgame.mjs';

const game = { file: 'Pacman.tns', label: 'Pacman', size: 1000 };
const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);

async function connect(opts) {
  const sim = new SimNspire(opts);
  const link = NspireLink.fromDevice(sim, { timeout: 500, addressWait: 200 });
  await link.open();
  await link.ready();
  return { sim, link };
}


for (const model of ['cx', 'cx2']) {
  test(`${model}: read, send, find it, delete`, async () => {
    const { sim, link } = await connect({ model });
    const games = [game, { file: 'Chess.tns', label: 'Chess', size: 50 }];
    let c = await readCalculator(link, games);
    assert.equal(c.info.model, model);
    assert.equal(c.onCalc.size, 0);
    const progress = [];
    const r = await sendGame(link, game, bytes, { info: c.info, onProgress: s => progress.push(s) });
    assert.deepEqual(r, { result: 'sent', bytes: 1000 });
    assert.equal(progress.at(-1), 1000);
    assert.deepEqual(sim.files.get('/Pacman.tns').bytes, bytes);
    c = await readCalculator(link, games);
    assert.deepEqual([...c.onCalc], [['Pacman.tns', { size: 1000, ours: true }]]);
    assert.deepEqual(connectParams(c), {
      model, os: c.info.os, games_on: 1,
    });
    // Sending again replaces our own copy without asking.
    assert.equal((await sendGame(link, game, bytes, { info: c.info })).result, 'sent');
    assert.deepEqual(await deleteGame(link, game), { result: 'deleted' });
    assert.equal(sim.files.has('/Pacman.tns'), false);
    assert.deepEqual(await deleteGame(link, game), { result: 'not_there' });
    assert.deepEqual(sim.violations, []);
  });

  test(`${model}: a student's own file of the same name is never replaced or deleted unasked`, async () => {
    const { sim, link } = await connect({ model, files: { '/Pacman.tns': new Uint8Array(1234).fill(9) } });
    const c = await readCalculator(link, [game]);
    assert.deepEqual(c.onCalc.get('Pacman.tns'), { size: 1234, ours: false });
    assert.deepEqual(await sendGame(link, game, bytes, { info: c.info }), { result: 'exists_different', size: 1234, file: 'Pacman.tns' });
    assert.equal(sim.files.get('/Pacman.tns').bytes.length, 1234);
    assert.deepEqual(await deleteGame(link, game), { result: 'not_ours', size: 1234 });
    assert.equal(sim.files.has('/Pacman.tns'), true);
    // The student chose Replace.
    assert.equal((await sendGame(link, game, bytes, { info: c.info, replace: true })).result, 'sent');
    assert.deepEqual(sim.files.get('/Pacman.tns').bytes, bytes);
    // An older size the page lists counts as ours.
    sim.addFile('/Pacman.tns', new Uint8Array(900));
    assert.equal((await deleteGame(link, { ...game, oldSizes: [900] })).result, 'deleted');
  });

  test(`${model}: a game with a licence notice: both go, both are deleted`, async () => {
    const { sim, link } = await connect({ model });
    const nb = new Uint8Array(300).fill(7);
    const g = { file: '2048.tns', label: '2048', size: 1000, notice: { file: '2048 License.tns', size: 300 } };
    const c = await readCalculator(link, [g]);
    const progress = [];
    const r = await sendGame(link, g, bytes, { info: c.info, notice: { ...g.notice, bytes: nb }, onProgress: (s, t) => progress.push([s, t]) });
    assert.deepEqual(r, { result: 'sent', bytes: 1000, notice: '2048 License.tns' });
    assert.deepEqual(progress.at(-1), [1300, 1300]);
    assert.deepEqual(sim.files.get('/2048.tns').bytes, bytes);
    assert.deepEqual(sim.files.get('/2048 License.tns').bytes, nb);
    assert.equal(sendText(g, r), 'Sent. Open 2048.tns from My Documents on your calculator. Its license notice is next to it as 2048 License.tns.');
    const d = await deleteGame(link, g);
    assert.deepEqual(d, { result: 'deleted', notice: '2048 License.tns' });
    assert.equal(deleteText(g, d), 'Deleted 2048.tns and 2048 License.tns from your calculator.');
    assert.equal(sim.files.has('/2048.tns') || sim.files.has('/2048 License.tns'), false);
    // A student's own file named like the notice: asked first, never deleted.
    sim.addFile('/2048 License.tns', new Uint8Array(55));
    const x = await sendGame(link, g, bytes, { info: c.info, notice: { ...g.notice, bytes: nb } });
    assert.deepEqual(x, { result: 'exists_different', size: 55, file: '2048 License.tns' });
    assert.equal(sim.files.has('/2048.tns'), false);
    sim.addFile('/2048.tns', bytes);
    assert.deepEqual(await deleteGame(link, g), { result: 'deleted' });
    assert.equal(sim.files.get('/2048 License.tns').bytes.length, 55);
    // The game left alone (not ours): its notice name is left alone too.
    sim.addFile('/2048.tns', new Uint8Array(77));
    sim.addFile('/2048 License.tns', nb);
    assert.deepEqual(await deleteGame(link, g), { result: 'not_ours', size: 77 });
    assert.equal(sim.files.has('/2048 License.tns'), true);
    assert.deepEqual(sim.violations, []);
  });

  test(`${model}: a full calculator gets nothing`, async () => {
    const { sim, link } = await connect({ model, storageTotal: 2000 + SPACE_MARGIN });
    const c = await readCalculator(link, [game]);
    const r = await sendGame(link, { ...game, size: 3000 }, new Uint8Array(3000), { info: c.info });
    assert.equal(r.result, 'no_space');
    assert.equal(sim.files.size, 0);
    assert.match(sendText(game, r), /^Not enough space on your calculator\. Pacman needs \d+ KB and it has \d+ KB left\.$/);
  });
}

test('words: plain, short, no em dashes', () => {
  const all = [
    sendText(game, { result: 'sent' }), sendText(game, { result: 'exists_different' }), sendText(game, { result: 'no_space', need: 5000, left: 100 }),
    deleteText(game, { result: 'deleted' }), deleteText(game, { result: 'not_there' }), deleteText(game, { result: 'not_ours' }),
    ...['cancelled', 'no_webusb', 'windows_driver', 'linux_permission', 'busy_elsewhere', 'open_failed', 'not_nspire', 'timeout', 'disconnected', 'link', 'other'].map(failText),
    calcLine({ name: 'TI-Nspire CX II CAS', os: '6.2.0.333' }),
  ];
  for (const s of all) {
    assert.ok(s && s.length < 160, s);
    assert.doesNotMatch(s, /[—–]|\bfree\b/i, s);
  }
});

test('failure reasons', () => {
  const e = code => ({ code });
  assert.equal(failReason(e('NO_DEVICE_SELECTED')), 'cancelled');
  assert.equal(failReason(e('OPEN_FAILED'), { platform: 'windows', productId: 0xE012 }), 'windows_driver');
  // "Busy" only for Chrome's claim conflict; every other open failure says so plainly.
  const open = (step, name, message = 'x') => ({ code: 'OPEN_FAILED', step, cause: { name, message } });
  assert.equal(failReason(open('claim', 'NetworkError', 'Unable to claim interface.'), { platform: 'mac' }), 'busy_elsewhere');
  assert.equal(failReason(open('claim', 'NetworkError'), { platform: 'windows', productId: 0xE022 }), 'busy_elsewhere');
  assert.equal(failReason(open('claim', 'NotFoundError', 'The device was disconnected.'), { platform: 'mac' }), 'open_failed');
  assert.equal(failReason(open('claim', 'InvalidStateError'), { platform: 'mac' }), 'open_failed');
  assert.equal(failReason(open('reset', 'NetworkError'), { platform: 'mac' }), 'open_failed');
  assert.equal(failReason(open('config', 'NetworkError'), { platform: 'mac' }), 'open_failed');
  assert.equal(failReason(open('open', 'SecurityError', 'Access denied.'), { platform: 'windows', productId: 0xE022 }), 'open_failed');
  assert.equal(failReason(e('OPEN_FAILED'), { platform: 'windows', productId: 0xE022 }), 'open_failed');
  assert.equal(failReason(open('open', 'SecurityError', 'Access denied.'), { platform: 'linux' }), 'linux_permission');
  assert.equal(failReason(open('claim', 'NetworkError'), { platform: 'linux' }), 'busy_elsewhere');
  assert.equal(failText('open_failed'), 'Couldn\'t open the calculator. Unplug it, plug it back in, then click Connect.');
  assert.equal(failDetail(open('claim', 'NetworkError', 'Unable to claim interface.')), 'claim NetworkError: Unable to claim interface.');
  assert.equal(failDetail({ code: 'TIMEOUT', message: 'm' }), '');
  assert.equal(failDetail(new TypeError('boom')), 'TypeError: boom');
  assert.ok(failDetail(open('claim', 'NetworkError', 'y'.repeat(300))).length <= 100);
  assert.equal(failReason(e('TIMEOUT')), 'timeout');
  assert.equal(failReason(e('NACK')), 'link');
  assert.equal(failReason(new Error('x')), 'other');
  assert.equal(platformOf({ userAgentData: { platform: 'Windows' } }), 'windows');
  assert.equal(platformOf({ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)' }), 'chromeos');
  assert.equal(platformOf({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), 'mac');
});

for (const model of ['cx', 'cx2']) {
  test(`${model}: openLink picks, opens and readies; a reset that re-enumerates is opened again without one (a CX II is not reset)`, async () => {
    const sim = new SimNspire({ model });
    let asked = 0;
    const usb = { requestDevice: async () => { asked++; return sim; }, getDevices: async () => (asked ? [sim] : []) };
    sim.reenumerateOnReset = true;
    const link = await openLink({ usb, wait: async () => {}, options: { timeout: 500, addressWait: 200 } });
    assert.equal(asked, 1);
    assert.equal((await link.info()).model, model);
    assert.deepEqual(sim.violations, []);
    // Next time the page may already use it: no picker.
    await link.close();
    const again = await openLink({ usb, wait: async () => {}, options: { timeout: 500, addressWait: 200 } });
    assert.equal(asked, 1);
    assert.equal((await again.info()).model, model);
    if (model === 'cx2') assert.equal(sim.resets ?? 0, 0);
  });
}

// What Chrome on macOS did with a CX II CAS: a USB reset makes
// macOS re-enumerate it, and with no serial number the page's permission does
// not carry over to the new device, so getDevices() comes back empty.
function chromeMac(sim) {
  let asked = 0;
  let granted = [];
  sim.reenumerateOnReset = true;
  const reset = sim.reset.bind(sim);
  sim.reset = async () => { granted = []; return reset(); };
  return { usb: { requestDevice: async () => { asked++; granted = [sim]; return sim; }, getDevices: async () => granted }, asked: () => asked };
}

test('cx2 on Chrome for macOS: connects with a configuration switch, never a reset', async () => {
  const sim = new SimNspire({ model: 'cx2' });
  const { usb, asked } = chromeMac(sim);
  for (let i = 0; i < 2; i++) {
    const link = await openLink({ usb, wait: async () => {}, options: { timeout: 500 } });
    assert.equal((await link.info()).model, 'cx2');
    assert.equal(link.anomalies.configSwitchFailed, 0);
    await link.close();
  }
  assert.equal(asked(), 1);
  assert.equal(sim.resets ?? 0, 0);
  assert.deepEqual(sim.violations, []);
});

test('cx2 on Chrome for macOS: a device lost to a reset is reported as a failed open, not "busy"', async () => {
  // The configuration switch refused, so the link falls back to the reset,
  // which loses the device.
  const sim = new SimNspire({ model: 'cx2' });
  sim.refuseConfig = true;
  const { usb } = chromeMac(sim);
  const err = await openLink({ usb, wait: async () => {}, options: { timeout: 500 } }).catch(e => e);
  assert.equal(err.code, 'OPEN_FAILED');
  // Whether Chrome rejects the reset itself or the claim after it was not
  // observed; either way it is not a claim conflict.
  assert.ok(['reset', 'claim'].includes(err.step), err.step);
  assert.equal(failReason(err, { platform: 'mac', productId: err.productId }), 'open_failed');
  assert.match(failDetail(err), /^(reset|claim) \w+Error: /);
});

test('cx2: a refused configuration switch falls back to the reset', async () => {
  const sim = new SimNspire({ model: 'cx2' });
  sim.refuseConfig = true;
  const usb = { requestDevice: async () => sim, getDevices: async () => [] };
  const link = await openLink({ usb, wait: async () => {}, options: { timeout: 500 } });
  assert.equal(link.anomalies.configSwitchFailed, 1);
  assert.equal(sim.resets, 1);
  assert.equal((await link.info()).model, 'cx2');
});

test('cx2: an addressed CX II that is neither reset nor switched sends nothing', async () => {
  // Why open() must restart it: measured on a CX II CAS, three runs out of three.
  const sim = new SimNspire({ model: 'cx2' });
  const first = NspireLink.fromDevice(sim, { timeout: 300 });
  await first.open(); await first.ready(); await first.close();
  sim.configurations = [sim.configurations[0]]; // as if it had one configuration
  const again = NspireLink.fromDevice(sim, { timeout: 300, reset: false });
  await again.open();
  await assert.rejects(again.ready(), e => e.code === 'TIMEOUT');
});

test('openLink: a refused open carries the product id for the Windows reason', async () => {
  const sim = new SimNspire({ model: 'cx' });
  sim.open = async () => { throw Object.assign(new Error('Access denied.'), { name: 'SecurityError' }); };
  const usb = { requestDevice: async () => sim, getDevices: async () => [] };
  await assert.rejects(openLink({ usb, wait: async () => {} }), e => e.code === 'OPEN_FAILED' && e.productId === 0xE012
    && failReason(e, { platform: 'windows', productId: e.productId }) === 'windows_driver');
});
