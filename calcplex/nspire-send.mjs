// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 CalcPlex. Part of nspirelink: https://github.com/calcplex/nspirelink
//
// Send to calculator on the TI-Nspire games hub, in the Evo pages' UI
// (send-ui.mjs): the connect panel above the cards (.evo-conn, written into
// the page by the build in the words painted here first), and on every card
// the Evo game page's split button: Send to calculator, its arrow offering
// Download and Delete from calculator; while the calculator has the game,
// Delete (red), its arrow offering Send again and Download. Messages go in
// the card's .evo-status box, as on the Evo hub.
//
// Only the transport and the words are the Nspire's: the link is WebUSB
// (nspirelink.mjs), the game goes into My Documents, and a game whose
// licence wants its notice in every copy is sent with a small notice
// document beside it (taken out of the same .zip the Download button gives,
// so the game bytes never travel without it).
//
// The script tag carries data-ns-games, the URL of the games list:
// [{ file, label, url, size, sha256, zip?, notice? }].

import { LINK_LOST } from '../nspirelink.mjs';
import {
  openLink, readCalculator, sendGame, deleteGame, sendText, deleteText, failReason, failText, failDetail, platformOf,
  connectParams, calcLine,
} from './sendgame.mjs';
import { makeOneSplit, showIn, showBusy, watchMenus } from './send-ui.mjs';

const TAG = document.querySelector('script[src*="/nspire-send.mjs"]');
const CFG = TAG?.dataset ?? {};
const PREVIEW = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
// ?win=1 previews the Windows wording on localhost.
const PLATFORM = PREVIEW && /[?&]win=1\b/.test(location.search) ? 'windows' : platformOf(navigator);

// The words the site's build writes into the panel, so the first paint here
// changes nothing.
const PANEL_ON = 'Plug in your TI-Nspire, turn it on, and click Connect to send games.';
const WIN_HINT = 'On Windows this works with the CX II. For an original CX, use TI\'s TI-Nspire software.';

const panel = document.getElementById('ns-conn');
const cards = [];
let games = [];
let link = null;
let calc = null;
let busy = false;

function track(event, params) {
  try {
    if (PREVIEW) console.info('[not sent: preview]', event, params);
    else if (typeof window.gtag === 'function') window.gtag('event', event, params);
  } catch { /* analytics never breaks the page */ }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function changed() { for (const c of cards) c.paint(); }

// ---------------------------------------------------------------------------
// The panel (the Evo hub's .evo-conn: blue, green when connected, amber on a
// failure)

function paint(state, extra = {}) {
  const on = panel.querySelector('.ns-on');
  const goButton = (label = 'Connect your calculator', disabled = false) =>
    `<button type="button" class="btn ns-conn-go"${disabled ? ' disabled' : ''}>${label}</button>`;
  // Shown on Windows only (<html class="ns-onwin">, set in <head>).
  const hint = `<p class="ns-sub ns-winhint">${WIN_HINT}</p>`;
  panel.className = 'evo-conn' + (state === 'ok' ? ' ok' : state === 'fail' ? ' warn' : '');
  if (state === 'idle') {
    on.innerHTML = `<p class="msg">${PANEL_ON}</p>${goButton()}${hint}`;
  } else if (state === 'connecting') {
    on.innerHTML = `<p class="msg">${PANEL_ON}</p>${goButton('Select your calculator in the popup…', true)}`;
  } else if (state === 'ok') {
    let more = '';
    on.innerHTML = `<p class="msg"><strong>Calculator connected.</strong> ${esc(calcLine(calc.info))} `
      + 'Click Send to calculator on any game below.</p>' + more;
  } else if (state === 'fail') {
    on.innerHTML = `<p class="msg">${esc(failText(extra.reason))}</p>${goButton('Try again')}`;
  }
  on.querySelector('.ns-conn-go')?.addEventListener('click', () => { connect(); });
}

async function dropLink() {
  const l = link;
  link = null;
  calc = null;
  for (const c of cards) c.there = null;
  changed();
  try { await l?.close(); } catch { /* already gone */ }
}

/** Connect (from a click), read the calculator, mark the cards. Resolves true when connected. */
async function connect() {
  if (link) return true;
  if (busy) return false;
  busy = true;
  changed();
  paint('connecting');
  try {
    link = await openLink();
    calc = await readCalculator(link, games);
    paint('ok');
    for (const c of cards) c.there = calc.onCalc.get(c.game.file) ?? null;
    track('nspire_connect', connectParams(calc));
    return true;
  } catch (e) {
    const reason = failReason(e, { platform: PLATFORM, productId: e?.productId ?? link?.device?.productId });
    track('nspire_connect_fail', { reason, ...(e?.code ? { code: e.code } : {}), ...(failDetail(e) ? { detail: failDetail(e) } : {}) });
    await dropLink();
    paint('fail', { reason });
    return false;
  } finally {
    busy = false;
    changed();
  }
}

// ---------------------------------------------------------------------------
// Getting the bytes: a .tns as served, or the game and nothing else out of
// its .zip (the zip the Download button gives; the notice document is served
// on its own, it is ours)

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`The download answered ${res.status}.`), { code: 'FETCH' });
  return new Uint8Array(await res.arrayBuffer());
}

async function unzipOne(zip, name) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('not a zip'), { code: 'FETCH' });
  let p = v.getUint32(eocd + 16, true);
  const count = v.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const entry = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen));
    if (entry === name) {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = zip.subarray(start, start + csize);
      if (method === 0) return raw.slice();
      if (method !== 8) break;
      const out = new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
      return new Uint8Array(await out.arrayBuffer());
    }
    p += 46 + nlen + xlen + clen;
  }
  throw Object.assign(new Error(`${name} is not in the zip`), { code: 'FETCH' });
}

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The game's bytes (and its notice's), checked against the list. */
async function gameBytes(game) {
  const got = await fetchBytes(game.url);
  const bytes = game.zip ? await unzipOne(got, game.file) : got;
  if (bytes.length !== game.size || (await sha256(bytes)) !== game.sha256) {
    throw Object.assign(new Error(`${game.file} is not the file this page lists.`), { code: 'FETCH' });
  }
  let notice = null;
  if (game.notice) {
    const nb = await fetchBytes(game.notice.url);
    if (nb.length !== game.notice.size || (await sha256(nb)) !== game.notice.sha256) {
      throw Object.assign(new Error(`${game.notice.file} is not the file this page lists.`), { code: 'FETCH' });
    }
    notice = { ...game.notice, bytes: nb };
  }
  return { bytes, notice };
}

// ---------------------------------------------------------------------------
// The cards

function mountCard(btn) {
  const game = games.find(g => g.file === btn.dataset.file);
  const row = btn.closest('.wp-block-media-text__content');
  if (!game || !row) return;
  const dl = row.querySelector('.ns-dl a');
  const status = document.createElement('div');
  status.className = 'evo-status';
  status.setAttribute('role', 'status');
  row.append(status);
  const c = { game, there: null };
  status.addEventListener('click', e => {
    if (e.target.closest('.evo-close')) showIn(status, '', '');
    else if (e.target.closest('.ns-replace')) send(true);
  });

  async function linkFailed(e, op) {
    const reason = failReason(e, { platform: PLATFORM, productId: link?.device?.productId });
    track(`nspire_${op}`, { game: game.file, result: 'fail', reason, ...(e?.code ? { code: e.code } : {}), ...(failDetail(e) ? { detail: failDetail(e) } : {}) });
    if (LINK_LOST.includes(e?.code) || !link?.opened) {
      await dropLink();
      paint('fail', { reason });
    }
    showIn(status, `<p>${esc(failText(reason))}</p>`, 'bad');
  }

  async function send(replace = false) {
    if (busy) return;
    if (!link && !(await connect())) return;
    busy = true;
    changed();
    try {
      showBusy(status, 'Getting the file…');
      const { bytes, notice } = await gameBytes(game);
      showBusy(status, 'Sending to your calculator… 0%');
      const r = await sendGame(link, game, bytes, {
        info: calc.info, replace, notice,
        onProgress: (sent, total) => {
          const pct = Math.floor(100 * sent / total);
          split.label(`Sending… ${pct}%`);
          showBusy(status, `Sending to your calculator… ${pct}%`);
        },
      });
      track('nspire_send', { game: game.file, result: r.result, ...(replace ? { replace: 1 } : {}) });
      if (r.result === 'sent') {
        calc.info = await link.info();
        c.there = { size: bytes.length, ours: true };
        showIn(status, `<p>${esc(sendText(game, r))}</p>`, 'ok');
      } else if (r.result === 'exists_different') {
        showIn(status, `<p>${esc(sendText(game, r))} <button type="button" class="evo-send-again ns-replace">Replace it</button></p>`, 'warn');
      } else {
        showIn(status, `<p>${esc(sendText(game, r))}</p>`, 'bad');
      }
    } catch (e) {
      if (e?.code === 'FETCH') {
        track('nspire_send', { game: game.file, result: 'fail', reason: 'fetch' });
        showIn(status, '<p>The file did not download. Check your connection and try again.</p>', 'bad');
      } else {
        await linkFailed(e, 'send');
      }
    } finally {
      busy = false;
      split.restore();
      changed();
    }
  }

  async function remove(via) {
    if (busy || !link) return;
    busy = true;
    changed();
    try {
      split.label('Deleting…');
      showBusy(status, 'Deleting…');
      const r = await deleteGame(link, game);
      track('nspire_delete', { game: game.file, result: r.result, ...(via ? { from: via } : {}) });
      if (r.result === 'deleted') calc.info = await link.info();
      c.there = r.result === 'not_ours' ? c.there : null;
      showIn(status, `<p>${esc(deleteText(game, r))}</p>`, r.result === 'deleted' ? 'ok' : 'warn');
    } catch (e) {
      await linkFailed(e, 'delete');
    } finally {
      busy = false;
      split.restore();
      changed();
    }
  }

  // Delete from calculator in the menu, before the page has read the
  // calculator: connect first, then the same Delete.
  async function removeFirst() {
    if (busy) return;
    if (!link && !(await connect())) return;
    if (c.there?.ours) return remove('menu');
    const r = c.there ? { result: 'not_ours' } : { result: 'not_there' };
    track('nspire_delete', { game: game.file, result: r.result, from: 'menu' });
    showIn(status, `<p>${esc(deleteText(game, r))}</p>`, 'warn');
  }

  const split = makeOneSplit({
    btn, label: game.label, dl,
    onSend: () => send(false), onDelete: () => remove(), onDeleteFirst: removeFirst,
  });
  c.paint = () => {
    split.setDelete(!!c.there?.ours, busy);
    split.setRemove(!link);
    split.setBusy(busy);
  };
  cards.push(c);
}

async function mount() {
  const off = () => document.documentElement.classList.add('ns-nosend');
  if (!panel || document.documentElement.classList.contains('ns-nosend') || !CFG.nsGames) return;
  try {
    games = await (await fetch(CFG.nsGames)).json();
  } catch {
    off(); // no list, no Send: the Download buttons come back
    return;
  }
  if (PLATFORM === 'windows') document.documentElement.classList.add('ns-onwin');
  watchMenus();
  document.querySelectorAll('.ns-send-btn').forEach(mountCard);
  changed();
  paint('idle');
  navigator.usb?.addEventListener('disconnect', ev => {
    if (link && ev.device === link.device) {
      dropLink();
      paint('fail', { reason: 'disconnected' });
    }
  });
}

mount();
