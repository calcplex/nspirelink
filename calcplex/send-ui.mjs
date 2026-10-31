// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 CalcPlex. Part of nspirelink: https://github.com/calcplex/nspirelink
//
// The send button UI shared by calcplex.com's calculator pages: the TI-84
// Evo game page's split button, its arrow menu, and its message boxes, as a
// module any calculator's page can use with its own transport. The Evo
// pages are the reference: same DOM, same class names, same arrow, same
// keys. The CSS is not restated here: the site's build copies the Evo's own
// rules (.evo-conn, .btn, .evo-onesplit, .evo-split, .evo-box) into the
// page's stylesheet, so a change to the Evo's look moves this too.

/** The Evo page's arrow (evo-games-v2.js ONE_ARROW). */
export const ONE_ARROW = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** The message box's close button (evo-games-v2.js CLOSE_X). */
export const CLOSE_X = '<button type="button" class="evo-close" aria-label="Close">×</button>';

/** Close every open menu but `except`. */
export function closeMenus(except) {
  document.querySelectorAll('.evo-split-menu').forEach(m => {
    if (m === except) return;
    m.hidden = true;
    const a = m.parentElement.querySelector('.evo-split-arrow');
    if (a) a.setAttribute('aria-expanded', 'false');
  });
}

/** A click outside a split, or Escape, closes the menus (once per page). */
export function watchMenus() {
  document.addEventListener('click', e => { if (!e.target.closest('.evo-split')) closeMenus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });
}

/**
 * A message box under a card (evo-games-v2.js showIn): `kind` ok, bad or
 * warn; '' html empties it. The close button empties it too.
 */
export function showIn(box, html, kind) {
  box.innerHTML = html ? CLOSE_X + html : '';
  box.className = 'evo-status' + (html ? ' evo-box is-' + kind : '');
  return box;
}

/** Plain progress text in the box (no frame), as the Evo hub shows a send. */
export function showBusy(box, text) {
  box.className = 'evo-status';
  box.textContent = text;
  return box;
}

/**
 * Turn `btn` (in its `.wp-block-button` wrap) into the Evo page's one split:
 * Send to calculator, its arrow offering Download (a copy of `dl`, which is
 * hidden) and, while the page has not read the calculator, Delete from
 * calculator. While the calculator has the game: Delete (red), its arrow
 * offering Send again first, then Download.
 *
 *   onSend()        the main button or Send again
 *   onDelete()      the main button while it says Delete
 *   onDeleteFirst() Delete from calculator in the menu (connect, then delete)
 *
 * Returns { arrow, isDelete(), setDelete(on, working), setRemove(on), setBusy(off) }.
 */
export function makeOneSplit({ btn, label, dl = null, onSend, onDelete, onDeleteFirst }) {
  const wrap = btn.closest('.wp-block-button') || btn;
  const sendText = btn.textContent;
  wrap.classList.add('evo-split', 'evo-onesplit');
  btn.classList.add('evo-split-main');
  const arrow = document.createElement('button');
  arrow.type = 'button';
  arrow.className = 'wp-block-button__link no-border-radius evo-split-arrow';
  arrow.setAttribute('aria-label', 'More ways to get ' + label);
  arrow.setAttribute('aria-haspopup', 'menu');
  arrow.setAttribute('aria-expanded', 'false');
  arrow.innerHTML = ONE_ARROW;
  const menu = document.createElement('div');
  menu.className = 'evo-split-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const again = document.createElement('button');
  again.type = 'button';
  again.setAttribute('role', 'menuitem');
  again.className = 'evo-split-send';
  again.textContent = 'Send again';
  again.hidden = true;
  again.addEventListener('click', () => { closeMenus(); onSend(); });
  menu.appendChild(again);
  const first = document.createElement('button');
  first.type = 'button';
  first.setAttribute('role', 'menuitem');
  first.className = 'evo-split-remove';
  first.textContent = 'Delete from calculator';
  first.hidden = true;
  first.addEventListener('click', () => { closeMenus(); onDeleteFirst(); });
  if (dl) {
    // the same link (href, download), so the same download event
    const a = dl.cloneNode(true);
    a.className = 'evo-menu-dl';
    a.setAttribute('role', 'menuitem');
    const ext = (dl.getAttribute('href') || '').split('?')[0].split('.').pop();
    if (/^[a-z0-9]{1,4}$/i.test(ext)) a.textContent = 'Download .' + ext.toLowerCase();
    a.addEventListener('click', () => { closeMenus(); });
    menu.appendChild(a);
    const dlWrap = dl.closest('.wp-block-button');
    if (dlWrap && dlWrap !== wrap) dlWrap.hidden = true;
    else dl.hidden = true;
  }
  menu.appendChild(first);
  wrap.appendChild(arrow);
  wrap.appendChild(menu);
  const items = () => [...menu.querySelectorAll('a, button')].filter(el => !el.hidden && !el.disabled);
  arrow.addEventListener('click', e => {
    const open = menu.hidden;
    closeMenus(menu);
    menu.hidden = !open;
    arrow.setAttribute('aria-expanded', String(open));
    // opened from the keyboard (Enter or Space): the focus goes into the menu
    if (open && e.detail === 0 && items()[0]) items()[0].focus();
  });
  // Up and down move through the menu; Escape (which closes every menu)
  // gives the focus back to the arrow.
  menu.addEventListener('keydown', e => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
      if (next) next.focus();
    } else if (e.key === 'Escape') {
      closeMenus();
      arrow.focus();
    }
  });
  let deleting = false;
  btn.addEventListener('click', () => { closeMenus(); if (deleting) onDelete(); else onSend(); });
  return {
    arrow,
    isDelete: () => deleting,
    // (`working`: a send or delete is relabelling the button; its words stay)
    setDelete(on, working) {
      deleting = on;
      wrap.classList.toggle('is-delete', on);
      btn.classList.toggle('evo-danger', on);
      if (!working) btn.textContent = on ? 'Delete' : sendText;
      if (on) btn.setAttribute('aria-label', 'Delete ' + label + ' from calculator');
      else btn.removeAttribute('aria-label');
      again.hidden = !on;
    },
    // Delete from calculator in the menu (`on`: the calculator not read yet)
    setRemove(on) { first.hidden = !on; },
    // everything off while a send or delete runs
    setBusy(off) {
      btn.disabled = off;
      arrow.disabled = off;
      if (off) closeMenus();
    },
    label(text) { btn.textContent = text; },
    restore() { btn.textContent = deleting ? 'Delete' : sendText; },
  };
}
