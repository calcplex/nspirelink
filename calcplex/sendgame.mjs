// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 CalcPlex. Part of nspirelink: https://github.com/calcplex/nspirelink
//
// What a games page does over the link, kept apart from the page so it runs
// in Node against the simulator: read the calculator, send a game into My
// Documents, delete one, and the words for each outcome.
//
// A game: { file: 'Pacman.tns', label: 'Pacman', url, size, sha256 }, from
// the page's games list. Delete removes a file only when its size is one the
// page serves, so a student's own file of the same name, or a copy the
// student has saved since, is never touched.
//
// A game whose licence wants its notice in every copy also has
// notice: { file: 'Minesweeper License.tns', url, size, sha256 }, a small
// document that shows the notice on the calculator. Send puts both into My
// Documents (the game first); Delete removes both (each only at a size the
// page serves). The page passes the notice's bytes as `notice.bytes`.

import { NspireLink } from '../nspirelink.mjs';

/** Room left after a send, so a game never fills the calculator to the last byte. */
export const SPACE_MARGIN = 64 * 1024;

export const gamePath = game => `/${game.file}`;

/** The sizes of a game this page serves (its current file, plus any older ones it lists). */
export const servedSizes = game => [game.size, ...(game.oldSizes ?? [])].filter(Number.isInteger);

/**
 * Pick, open and ready a calculator: one the page may already use, else the
 * browser's picker (so call it from a click). If the USB reset makes the
 * device come back as a new one (a re-enumeration, which some platforms do),
 * the open is tried once more on it without a reset. Errors carry the
 * picked device's `productId`.
 */
export async function openLink({ usb = globalThis.navigator?.usb, wait = ms => new Promise(r => setTimeout(r, ms)), options } = {}) {
  let link = null;
  try {
    const known = (await NspireLink.granted({ usb }))[0];
    link = known ? NspireLink.fromDevice(known, options) : await NspireLink.request({ usb, ...options });
    try {
      await link.open();
    } catch (e) {
      if (e?.code !== 'OPEN_FAILED' || !['reset', 'claim'].includes(e.step)) throw e;
      await wait(1500);
      const again = (await NspireLink.granted({ usb }))[0];
      if (!again) throw e;
      link = NspireLink.fromDevice(again, { ...options, reset: false });
      await link.open();
    }
    await link.ready();
    return link;
  } catch (e) {
    if (e && typeof e === 'object' && link?.device) e.productId ??= link.device.productId;
    try { await link?.close(); } catch { /* already closed */ }
    throw e;
  }
}

/**
 * Everything the page shows after Connect: { info, verdict, addon, onCalc },
 * onCalc mapping each game's file to { size, ours } when My Documents has a
 * file of that name.
 */
export async function readCalculator(link, games = []) {
  const info = await link.info();
  let verdict = null;
  let addon = null;
  const root = await link.list('/');
  const onCalc = new Map();
  for (const game of games) {
    const hit = root.find(e => !e.dir && e.name === game.file);
    if (hit) onCalc.set(game.file, { size: hit.size, ours: servedSizes(game).includes(hit.size) });
  }
  return { info, verdict, addon, onCalc };
}

/**
 * Send a game (and its notice, when it has one). Resolves { result, ... }:
 *   sent              { bytes } the file (and the notice) are in My Documents
 *                     at the sizes sent
 *   exists_different  { size, file } a file of that name and another size is
 *                     there (the game's or the notice's); nothing was sent
 *                     (call again with replace: true to overwrite it)
 *   no_space          { need, left } nothing was sent
 * Link errors are thrown. `notice`: { file, size, bytes } or null.
 */
export async function sendGame(link, game, bytes, { info, replace = false, onProgress, notice = null } = {}) {
  const items = [{ path: gamePath(game), bytes, sizes: servedSizes(game), file: game.file }];
  if (notice) items.push({ path: `/${notice.file}`, bytes: notice.bytes, sizes: [notice.size, notice.bytes.length], file: notice.file });
  let freed = 0;
  for (const it of items) {
    const there = await link.attr(it.path);
    if (there && !there.dir && !replace && !it.sizes.includes(there.size)) {
      return { result: 'exists_different', size: there.size, file: it.file };
    }
    if (there && !there.dir) freed += there.size;
  }
  const total = items.reduce((n, it) => n + it.bytes.length, 0);
  const left = info?.storageFree;
  if (Number.isFinite(left) && total + SPACE_MARGIN > left + freed) {
    return { result: 'no_space', need: total, left };
  }
  let done = 0;
  for (const it of items) {
    await link.put(it.path, it.bytes, { onProgress: onProgress && ((sent) => onProgress(done + sent, total)) });
    const after = await link.attr(it.path);
    if (!after || after.size !== it.bytes.length) {
      const err = new Error(`${it.path} is ${after ? after.size : 'not'} on the calculator after sending ${it.bytes.length} bytes.`);
      err.code = 'NOT_KEPT';
      throw err;
    }
    done += it.bytes.length;
  }
  return { result: 'sent', bytes: bytes.length, ...(notice ? { notice: notice.file } : {}) };
}

async function deleteOne(link, path, sizes) {
  const there = await link.attr(path);
  if (!there || there.dir) return { result: 'not_there' };
  if (!sizes.includes(there.size)) return { result: 'not_ours', size: there.size };
  await link.delete(path);
  if (await link.attr(path)) {
    const err = new Error(`${path} is still on the calculator after deleting it.`);
    err.code = 'NOT_DELETED';
    throw err;
  }
  return { result: 'deleted' };
}

/**
 * Delete a game sent from this page, and its notice when it has one.
 * Resolves { result } for the game: deleted, not_there, or not_ours (a file
 * of that name whose size this page never served, left alone). The notice
 * goes too, at a size the page serves, unless the game was left alone.
 */
export async function deleteGame(link, game) {
  const r = await deleteOne(link, gamePath(game), servedSizes(game));
  if (game.notice && r.result !== 'not_ours') {
    const n = await deleteOne(link, `/${game.notice.file}`, [game.notice.size]);
    if (n.result === 'deleted') return { ...r, notice: game.notice.file };
  }
  return r;
}

// ---------------------------------------------------------------------------
// Words

const kb = n => `${Math.max(1, Math.round(n / 1024)).toLocaleString('en-US')} KB`;

/** The model and OS line after Connect. */
export function calcLine(info) {
  return `${info.name}, OS ${info.os}.`;
}


/** A send's outcome in words. */
export function sendText(game, r) {
  if (r.result === 'sent') {
    return `Sent. Open ${game.file} from My Documents on your calculator.`
      + (r.notice ? ` Its license notice is next to it as ${r.notice}.` : '');
  }
  if (r.result === 'exists_different') {
    return `Your calculator already has a ${r.file ?? game.file} that is different from this one.`
      + ((r.file ?? game.file) === game.file ? ' It may hold your saved progress.' : '');
  }
  if (r.result === 'no_space') return `Not enough space on your calculator. ${game.label} needs ${kb(r.need + SPACE_MARGIN)} and it has ${kb(r.left)} left.`;
  return '';
}

/** A delete's outcome in words. */
export function deleteText(game, r) {
  if (r.result === 'deleted') return r.notice ? `Deleted ${game.file} and ${r.notice} from your calculator.` : `Deleted ${game.file} from your calculator.`;
  if (r.result === 'not_there') return `${game.file} is not in My Documents on your calculator.`;
  if (r.result === 'not_ours') return `The ${game.file} on your calculator is not the one from this page, so it was left alone.`;
  return '';
}

/**
 * Why a connect, send or delete failed, as one short reason for analytics
 * and failText: cancelled, no_webusb, windows_driver, linux_permission,
 * busy_elsewhere, open_failed, not_nspire, timeout, disconnected, link, other.
 * `platform` is 'windows', 'linux', 'chromeos', 'mac' or ''.
 */
export function failReason(err, { platform = '', productId } = {}) {
  const code = err?.code;
  if (code === 'NO_DEVICE_SELECTED') return 'cancelled';
  if (code === 'NO_WEBUSB') return 'no_webusb';
  if (code === 'NOT_NSPIRE') return 'not_nspire';
  if (code === 'OPEN_FAILED') {
    // An original CX on Windows has no WinUSB driver unless one was put in
    // by hand; TI's own software is the way there.
    if (platform === 'windows' && productId === 0xE012) return 'windows_driver';
    if (platform === 'linux' && err.cause?.name === 'SecurityError') return 'linux_permission';
    // Chrome answers "Unable to claim interface" (NetworkError) when another
    // program holds the calculator. Anything else (a device that went away
    // during the open, a refused reset or configuration) is not that, and
    // saying "busy" for it sends people looking for software that is not running.
    if (err.step === 'claim' && err.cause?.name === 'NetworkError') return 'busy_elsewhere';
    return 'open_failed';
  }
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'DISCONNECTED') return 'disconnected';
  if (['PROTOCOL', 'NACK', 'BUSY', 'USB_ERROR', 'LINK_CLOSED', 'NOT_KEPT', 'NOT_DELETED', 'REFUSED'].includes(code)) return 'link';
  return 'other';
}

/**
 * The raw failure for analytics, at most 100 characters (GA4's limit):
 * the link's step and the browser's error name and message, e.g.
 * "claim NetworkError: Unable to claim interface.". '' when there is none.
 */
export function failDetail(err) {
  const c = err?.cause;
  const parts = [err?.step, c ? `${c.name ?? 'Error'}: ${c.message ?? c}` : (err?.code ? '' : `${err?.name ?? 'Error'}: ${err?.message ?? err}`)];
  return parts.filter(Boolean).join(' ').slice(0, 100);
}

/** The words for a failReason. */
export function failText(reason) {
  return {
    cancelled: 'No calculator was picked. Click Connect and choose your TI-Nspire from the list.',
    no_webusb: 'This browser can\'t reach USB devices. Use Chrome or Edge on a computer.',
    windows_driver: 'On Windows, an original TI-Nspire CX can\'t connect from a browser. Send the file with TI\'s TI-Nspire software instead.',
    linux_permission: 'Linux blocked the calculator. It needs a udev rule for TI devices before a browser can use it.',
    busy_elsewhere: 'The calculator is busy with another program. Close TI\'s software or any other tab using it, then try again.',
    open_failed: 'Couldn\'t open the calculator. Unplug it, plug it back in, then click Connect.',
    not_nspire: 'That isn\'t a TI-Nspire. Pick your TI-Nspire from the list.',
    timeout: 'The calculator stopped answering. Unplug it, plug it back in, then click Connect.',
    disconnected: 'The calculator was unplugged. Plug it back in, then click Connect.',
    link: 'Something went wrong talking to the calculator. Unplug it, plug it back in, then click Connect.',
    other: 'Something went wrong. Unplug the calculator, plug it back in, then click Connect.',
  }[reason] ?? 'Something went wrong. Unplug the calculator, plug it back in, then click Connect.';
}

/** The platform for failReason, from a Navigator. */
export function platformOf(nav = globalThis.navigator) {
  const p = `${nav?.userAgentData?.platform ?? ''} ${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  if (/CrOS|Chrome OS/i.test(p)) return 'chromeos';
  if (/Win/i.test(p)) return 'windows';
  if (/Mac/i.test(p)) return 'mac';
  if (/Linux|X11/i.test(p)) return 'linux';
  return '';
}

/** GA4 parameters for nspire_connect. */
export function connectParams({ info, verdict, addon, onCalc }) {
  const p = {
    model: info.model === 'cx' || info.model === 'cx2' ? info.model : 'other',
    os: info.os,
    games_on: onCalc.size,
  };
  return p;
}
