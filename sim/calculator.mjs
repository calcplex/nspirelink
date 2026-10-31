// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 CalcPlex. Part of nspirelink: https://github.com/calcplex/nspirelink
//
// A simulated TI-Nspire behind the USBDevice interface WebUSB gives the
// library: a CX (NavNet straight over USB) or a CX II (NavNet inside NNSE).
// It is the test oracle, so it is strict: it answers what TI's OS 4.5.5 was
// observed answering in an emulator, and records anything a host should not
// have sent in `violations`. Its byte helpers are its own on purpose, so that
// a bug in the library's cannot hide in both.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const SIM_PRODUCT = Object.freeze({ cx: 0xE012, cx2: 0xE022 });

/** The two-byte answers TI's OS gives, as observed (0xFF then a code). */
export const SIM_REPLY = Object.freeze({
  OK: 0x00, NOT_FOUND: 0x0A, PUT_NO_FOLDER: 0x09, EXISTS: 0x12, NOT_EMPTY: 0x18,
  // Not observed; what this simulator answers for a full calculator.
  FULL: 0x0C,
});

const u16 = n => [(n >> 8) & 255, n & 255];
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = n => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
const get16 = (b, o) => b[o] * 256 + b[o + 1];
const get32 = (b, o) => b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3];

function navChecksum(data) {
  let c = 0;
  for (let i = 0; i < data.length; i++) {
    const a = ((data[i] << 8) | (c >>> 8)) & 0xFFFF;
    const lo = c & 0xFF;
    const b = (((lo & 15) << 4 ^ lo) << 8) & 0xFFFF;
    const d = b >>> 5;
    c = ((d >>> 7) ^ a ^ b ^ d) & 0xFFFF;
  }
  return c;
}

function navPacket({ srcAddr = 0x6401, srcSid, dstAddr = 0x6400, dstSid, ack = 0, seq, data }) {
  const big = data.length >= 255;
  const body = big ? [...u32(data.length), ...data] : [...data];
  const h = [0x54, 0xFD, ...u16(srcAddr), ...u16(srcSid), ...u16(dstAddr), ...u16(dstSid), ...u16(navChecksum(body)), big ? 255 : data.length, ack, seq];
  h.push(h.reduce((s, x) => s + x, 0) & 255);
  return Uint8Array.from([...h, ...body]);
}

function navParse(b) {
  if (b.length < 16 || b[0] !== 0x54 || b[1] !== 0xFD) return { error: 'not a NavNet packet' };
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += b[i];
  if ((sum & 255) !== b[15]) return { error: 'bad header checksum' };
  const big = b[12] === 255;
  const size = big ? get32(b, 16) : b[12];
  const start = big ? 20 : 16;
  if (b.length !== start + size) return { error: `length ${b.length}, header says ${start + size}` };
  if (navChecksum(b.subarray(16)) !== get16(b, 10)) return { error: 'bad data checksum' };
  return { srcAddr: get16(b, 2), srcSid: get16(b, 4), dstAddr: get16(b, 6), dstSid: get16(b, 8), ack: b[13], seq: b[14], big, data: b.slice(start) };
}

function nnseSum(b) {
  let s = 0;
  for (let i = 0; i < b.length; i += 2) s += b[i] * 256 + (i + 1 < b.length ? b[i + 1] : 0);
  while (s > 0xFFFF) s = Math.floor(s / 65536) + (s % 65536);
  return s;
}

function nnseMessage({ service, src = 0x01, dest = 0xFE, reqAck = 0, seqno, data = [] }) {
  const m = [0, service, src, dest, 0, reqAck, ...u16(12 + data.length), ...u16(seqno), 0, 0, ...data];
  const c = nnseSum(m) ^ 0xFFFF;
  m[10] = c >> 8; m[11] = c & 255;
  return Uint8Array.from(m);
}

// A path: zero-terminated, padded to at least 9 bytes in all.
function readPath(b, o) {
  const end = b.indexOf(0, o);
  if (end < 0) return null;
  return { path: dec.decode(b.subarray(o, end)), next: o + Math.max(end - o, 8) + 1 };
}

function padded(s) {
  const t = enc.encode(s);
  const out = new Uint8Array(Math.max(t.length, 8) + 1);
  out.set(t);
  return [...out];
}

// TI's OS clamps a path to My Documents: "/" is the top, ".." cannot leave it.
function norm(path) {
  const parts = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop(); else parts.push(p);
  }
  return '/' + parts.join('/');
}
const parentOf = p => p.slice(0, p.lastIndexOf('/')) || '/';

export class SimNspire {
  /** Everything a host did that a calculator would not accept. */
  violations = [];
  /** Every transfer, as { dir: 'out' | 'in', bytes }. */
  log = [];

  constructor({
    model = 'cx2', os = model === 'cx2' ? '6.2.0.333' : '4.5.5.79', boot1 = model === 'cx2' ? '5.0.0.42' : '4.0.1.43',
    boot2 = model === 'cx2' ? '5.0.0.100' : '4.5.0.14', hwType = model === 'cx2' ? 0x1C : 0x1F,
    osExtension = model === 'cx2' ? '.tco2' : '.tco', deviceName = 'TI-Nspire', storageTotal = 100_000_000,
    files = {}, dirs = ['/MyLib', '/Examples'], chatty = true,
  } = {}) {
    this.model = model;
    this.vendorId = 0x0451;
    this.productId = SIM_PRODUCT[model];
    this.productName = model === 'cx2' ? 'TI-Nspire CX II' : 'TI-Nspire';
    this.os = os; this.boot1 = boot1; this.boot2 = boot2; this.hwType = hwType;
    this.osExtension = osExtension; this.deviceName = deviceName; this.storageTotal = storageTotal;
    // Files sent by the host while it runs: the OS sometimes opens its own
    // client session afterwards (observed on 4.5.5 after a file read), which
    // libnspire refuses.
    this.chatty = chatty;
    this.dirs = new Set(['/']);
    this.files = new Map();
    for (const d of dirs) this.mkdirs(d);
    for (const [p, bytes] of Object.entries(files)) this.addFile(p, bytes);
    this.opened = false;
    const ep = [{ endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 512 }, { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 512 }];
    const alt = { alternateSetting: 0, interfaceClass: 0xFF, endpoints: ep };
    // A real CX II offers two configurations with the same interface (as
    // observed on a CX II CAS); the CX's layout is not measured. One interface
    // object is shared, so its claim follows whichever is active.
    const iface = { interfaceNumber: 0, alternate: alt, alternates: [alt], claimed: false };
    this.configurations = [1, ...(model === 'cx2' ? [2] : [])].map(configurationValue => ({ configurationValue, interfaces: [iface] }));
    // The host OS configures a device when it enumerates it (ioreg showed
    // configuration 1 on a CX II); the CX simulator keeps its older start.
    this.configuration = model === 'cx2' ? this.configurations[0] : null;
    // Faults a test can set.
    this.silent = false;          // answer nothing at all
    this.refuseReset = false;     // reset() throws
    this.refuseConfig = false;    // switching to another configuration throws
    this.noAddressRequest = false; // a classic unit sends no address request after a reset
    this.nackNext = false;        // refuse the next host packet (classic)
    this.full = false;            // refuse files for lack of space
    this.#fresh();
  }

  // --- the file system --------------------------------------------------------
  mkdirs(path) {
    const p = norm(path);
    if (p !== '/') this.mkdirs(parentOf(p));
    this.dirs.add(p);
  }

  addFile(path, bytes) {
    const p = norm(path);
    this.mkdirs(parentOf(p));
    this.files.set(p, { bytes: Uint8Array.from(bytes), date: 1000 + this.files.size });
  }

  get storageFree() {
    let used = 0;
    for (const f of this.files.values()) used += f.bytes.length;
    return Math.max(0, this.storageTotal - used);
  }

  // --- USBDevice ------------------------------------------------------------------
  async open() {
    if (this.#gone) throw this.#goneError();
    this.opened = true;
    // Back after a re-enumeration: the calculator starts its link by itself.
    if (this.#pendingStart) { this.#pendingStart = false; this.configuration = this.configurations[0]; this.#start(); }
  }
  // Closing cancels pending transfers, as WebUSB's close() does.
  async close() {
    this.opened = false;
    for (const i of this.configurations[0].interfaces) i.claimed = false;
    for (const r of this.#readers.splice(0)) r.reject(Object.assign(new Error('The transfer was cancelled.'), { name: 'AbortError' }));
  }
  async selectConfiguration(n) {
    this.#need();
    const c = this.configurations.find(x => x.configurationValue === n);
    if (!c) throw Object.assign(new Error('no such configuration'), { name: 'NotFoundError' });
    if (this.refuseConfig && this.configuration && c !== this.configuration) {
      throw Object.assign(new Error('Unable to set device configuration.'), { name: 'NetworkError' });
    }
    const changed = c !== this.configuration; // from unconfigured too
    this.configuration = c;
    c.interfaces[0].claimed = false;
    // A CX II starts its link over when a host switches its configuration
    // (measured: switching to 2 and back to 1 brings the handshake within 250 ms).
    if (changed && this.model === 'cx2') {
      this.#fresh();
      if (n === 1) this.#start();
    }
  }
  async claimInterface(n) {
    this.#need();
    if (!this.configuration || n !== 0) throw Object.assign(new Error('no such interface'), { name: 'NotFoundError' });
    this.configuration.interfaces[0].claimed = true;
  }
  async releaseInterface() { this.#need(); if (this.configuration) this.configuration.interfaces[0].claimed = false; }
  async clearHalt() { this.#need(); }

  /** A USB reset: the calculator starts its link over (address request, or the CX II handshake). */
  async reset() {
    this.#need();
    if (this.refuseReset) throw Object.assign(new Error('reset refused'), { name: 'NetworkError' });
    if (this.reenumerateOnReset) {
      // The device leaves and comes back as a new one: this object is closed
      // and a fresh open (without a reset) starts the link.
      this.reenumerateOnReset = false;
      this.opened = false;
      this.#fresh();
      this.#pendingStart = true;
      throw Object.assign(new Error('The device was reset and re-enumerated.'), { name: 'NetworkError' });
    }
    this.resets = (this.resets ?? 0) + 1;
    this.#fresh();
    this.#start();
  }

  #pendingStart = false;
  #start() {
    if (this.model === 'cx2') {
      const id = new Uint8Array(64);
      enc.encodeInto('TI-NspireCXII', id);
      this.#nnse({ service: 0x01, dest: 0xFF, reqAck: 1, data: [0x00, ...id] });
    } else if (!this.noAddressRequest) {
      // As observed: from address 0, service 0x4003, data 0x0FEC.
      this.#send(navPacket({ srcAddr: 0, srcSid: 0x4003, dstAddr: 0, dstSid: 0x4003, seq: 1, data: [0x0F, 0xEC] }));
    }
  }

  async transferOut(ep, data) {
    this.#need(true);
    const b = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length).slice();
    this.log.push({ dir: 'out', bytes: b });
    if (ep !== 1) this.#violate(`OUT on endpoint ${ep}`);
    if (!this.silent) {
      if (this.model === 'cx2') this.#fromHostNnse(b); else this.#fromHostNav(b);
    }
    return { status: 'ok', bytesWritten: b.length };
  }

  transferIn(ep, length) {
    try { this.#need(true); } catch (e) { return Promise.reject(e); }
    if (ep !== 1) this.#violate(`IN on endpoint ${ep}`);
    return new Promise((resolve, reject) => {
      this.#readers.push({ resolve, reject, length });
      this.#pump();
    });
  }

  /** Unplug: pending and later transfers fail as WebUSB's do. */
  unplug() {
    this.#gone = true;
    this.opened = false;
    for (const r of this.#readers.splice(0)) r.reject(this.#goneError());
  }

  /** Queue raw bytes for the host, as if the calculator sent them. */
  inject(bytes) { this.#send(Uint8Array.from(bytes)); }

  // --- internals ------------------------------------------------------------------
  #gone = false;
  #readers = [];
  #outbox = [];
  #addressed = false;
  #handshake = 0; // CX II: 0 nothing, 1 address answered, 2 time answered
  #seq = 1;
  #nnseSeq = 0;
  #pendingAck = null; // classic: seq of our last data packet, until the host acks it
  #sessions = new Map(); // host sid -> state
  #lastHostSeq = null;

  #fresh() {
    this.#outbox = [];
    this.#addressed = false;
    this.#handshake = 0;
    this.#seq = 1;
    this.#nnseSeq = 0;
    this.#pendingAck = null;
    this.#sessions = new Map();
  }

  #goneError() { return Object.assign(new Error('The device was disconnected.'), { name: 'NotFoundError' }); }

  #need(claimed = false) {
    if (this.#gone) throw this.#goneError();
    if (!this.opened) throw Object.assign(new Error('device not open'), { name: 'InvalidStateError' });
    if (claimed && !this.configuration?.interfaces[0].claimed) throw Object.assign(new Error('interface not claimed'), { name: 'InvalidStateError' });
  }

  #violate(what) { this.violations.push(what); }

  #send(bytes) {
    this.#outbox.push(bytes);
    this.#pump();
  }

  #pump() {
    while (this.#readers.length && this.#outbox.length) {
      const r = this.#readers.shift();
      const b = this.#outbox.shift();
      if (b.length > r.length) {
        this.#violate(`an IN transfer of ${r.length} bytes for a ${b.length}-byte packet`);
        r.resolve({ status: 'babble', data: new DataView(b.buffer.slice(0, r.length)) });
        continue;
      }
      this.log.push({ dir: 'in', bytes: b });
      r.resolve({ status: 'ok', data: new DataView(b.buffer, b.byteOffset, b.byteLength) });
    }
  }

  #nnse(fields) {
    let m = nnseMessage({ seqno: this.#nnseSeq, ...fields });
    // A real CX II sends a 64-byte message as a 65-byte transfer (observed on a
    // CX II CAS), so a 64-byte USB packet never ends a transfer.
    if (m.length % 64 === 0) { const p = new Uint8Array(m.length + 1); p.set(m); m = p; }
    this.#send(m);
    this.#nnseSeq = (this.#nnseSeq + 1) & 0xFFFF;
  }

  #fromHostNnse(b) {
    if (b.length < 12 || get16(b, 6) !== b.length) return this.#violate(`an NNSE message of ${b.length} bytes says ${get16(b, 6)}`);
    if (nnseSum(b) !== 0xFFFF) return this.#violate('an NNSE message with a bad checksum');
    const [, service, src, dest, , reqAck] = b;
    const seqno = get16(b, 8);
    const data = b.slice(12);
    // An acknowledgement comes from the address the message went to, which
    // for the address request is everyone (0xFF), as libnspire answers it.
    if ((src !== 0xFE && !(service & 0x80 && src === 0xFF)) || dest !== 0x01) this.#violate(`an NNSE message from ${src} to ${dest}`);
    if (service & 0x80) return; // the host acknowledging us
    if (reqAck & 1) this.#send(nnseMessage({ service: service | 0x80, src: 0x01, dest: 0xFE, seqno, data: [] }));
    switch (service) {
      case 0x01:
        if (data.length !== 1 || data[0] !== 0x80) this.#violate('an address answer that is not 0x80');
        if (this.#handshake === 0) {
          this.#handshake = 1;
          this.#nnse({ service: 0x08, reqAck: 1, data: [0x01] });
          this.#nnse({ service: 0x02, reqAck: 1, data: [0x00] });
        }
        return;
      case 0x08:
        if (data.length !== 2 || data[0] !== 0x81 || data[1] !== 0x03) this.#violate('a wrong answer to service 8');
        return;
      case 0x02:
        if (data.length !== 17 || data[0] !== 0x80) this.#violate('a time answer of the wrong shape');
        this.#handshake = 2;
        return;
      case 0x04: {
        if (this.#handshake !== 2) return this.#violate('a stream message before the handshake');
        if (!(reqAck & 1)) this.#violate('a stream message that asks for no acknowledgement');
        const p = navParse(data);
        if (p.error) return this.#violate(`in a stream message: ${p.error}`);
        if (p.seq !== 0) this.#violate(`a CX II NavNet packet with sequence ${p.seq}`);
        if (p.data.length > 1440) this.#violate(`${p.data.length} bytes of data in one packet`);
        if (p.big && p.data.length < 255) this.#violate('big data under 255 bytes');
        return this.#navnet(p);
      }
      default:
        return this.#violate(`NNSE service ${service}`);
    }
  }

  #fromHostNav(b) {
    const p = navParse(b);
    if (p.error) return this.#violate(p.error);
    if (p.data.length > 254 || p.big) this.#violate(`${p.data.length} bytes in a classic packet`);
    if (p.srcAddr !== 0x6400 || p.dstAddr !== 0x6401) this.#violate(`a packet from ${p.srcAddr.toString(16)} to ${p.dstAddr.toString(16)}`);
    if (p.ack === 0x0A) {
      if (p.srcSid === 0xD3) {
        // The host refused what we sent (libnspire refuses the OS's own
        // sessions); the OS moves on.
        this.#pendingAck = null;
        return this.#flush();
      }
      if (this.#pendingAck === null) return this.#violate('an acknowledgement nothing was waiting for');
      if (p.seq !== this.#pendingAck) this.#violate(`an acknowledgement for ${p.seq}, ${this.#pendingAck} was waiting`);
      this.#pendingAck = null;
      return this.#flush();
    }
    return this.#navnet(p);
  }

  // Classic: one data packet in flight, the next waits for its acknowledgement.
  #held = [];
  #flush() {
    if (this.model === 'cx2' || this.#pendingAck !== null) return;
    const next = this.#held.shift();
    if (!next) return;
    this.#pendingAck = next.seq;
    this.#send(navPacket(next));
  }

  #reply(sid, hostSid, data) {
    if (this.model === 'cx2') {
      this.#nnse({ service: 0x04, reqAck: 1, data: navPacket({ srcSid: sid, dstSid: hostSid, seq: 0, data }) });
      return;
    }
    this.#held.push({ srcSid: sid, dstSid: hostSid, seq: this.#seq, data });
    this.#seq = (this.#seq + 1) & 255 || 1;
    this.#flush();
  }

  #navnet(p) {
    const classic = this.model !== 'cx2';
    if (p.srcSid === 0x4003 && p.dstSid === 0x4003) {
      if (p.data.length !== 4 || p.data[0] !== 0x64 || p.data[1] !== 0x01) this.#violate('an address packet that is not 0x6401');
      this.#addressed = true;
      return;
    }
    if (!this.#addressed) return this.#violate('a request before the address packet');
    if (classic) {
      if (this.nackNext) {
        this.nackNext = false;
        this.#send(navPacket({ srcSid: 0xD3, dstSid: p.srcSid, ack: 0x0A, seq: p.seq, data: u16(p.dstSid) }));
        return;
      }
      if (this.#lastHostSeq !== null && p.seq === this.#lastHostSeq) this.#violate(`sequence ${p.seq} used twice in a row`);
      this.#lastHostSeq = p.seq;
      // As observed: after a file read the OS sends its own packet before it
      // acknowledges the host's disconnect.
      if (p.srcSid === 0x40DE && this.#afterSession) { const f = this.#afterSession; this.#afterSession = null; f(); }
      // As observed: the acknowledgement always comes from 0xFF, and a
      // disconnect's goes to the session it ends, not to 0x40DE.
      const to = p.srcSid === 0x40DE ? get16(p.data, 0) : p.srcSid;
      this.#send(navPacket({ srcSid: 0x00FF, dstSid: to, ack: 0x0A, seq: p.seq, data: u16(p.dstSid) }));
    }
    if (p.srcSid === 0x40DE) {
      const host = get16(p.data, 0);
      if (!this.#sessions.has(host)) this.#violate(`a disconnect of ${host.toString(16)}, which never connected`);
      this.#sessions.delete(host);
      if (this.#afterSession) { const f = this.#afterSession; this.#afterSession = null; f(); }
      return;
    }
    if (p.srcSid < 0x8000) return this.#violate(`a request from service ${p.srcSid.toString(16)}`);
    let s = this.#sessions.get(p.srcSid);
    if (!s) {
      if ([...this.#sessions.keys()].some(k => k !== p.srcSid)) this.#violate('a new session before the last one disconnected');
      s = { service: p.dstSid };
      this.#sessions.set(p.srcSid, s);
    }
    if (s.service !== p.dstSid) this.#violate('a session that changed service');
    const answer = data => this.#reply(p.dstSid, p.srcSid, data);
    if (p.dstSid === 0x4020) return this.#devinfo(p.data, answer);
    if (p.dstSid === 0x4060) return this.#file(s, p.data, answer);
    this.#violate(`service ${p.dstSid.toString(16)}`);
  }

  #afterSession = null;

  #devinfo(d, answer) {
    const ver = v => { const [a, b, c, n] = v.split('.').map(Number); return [a, b * 10 + c, ...u16(n)]; };
    if (d[0] === 0x01) {
      const free = this.storageFree;
      answer([0x01,
        ...u64(free), ...u64(this.storageTotal), ...u64(30_000_000), ...u64(64_000_000),
        0x7F, 0, 0, 156,
        ...ver(this.os), ...ver(this.boot1), ...ver(this.boot2),
        ...u32(0x10), ...u16(2),
        ...u16(0), ...u16(0), ...u16(320), ...u16(240), 16, 1,
        this.hwType,
        ...new Array(17).fill(0x41), ...new Array(27).fill(0x41), 0]);
    } else if (d[0] === 0x02) {
      answer([0x02, ...enc.encode(this.deviceName), 0]);
    } else if (d[0] === 0x03) {
      answer([0x03, ...enc.encode('.tns'), 0, ...enc.encode(this.osExtension), 0]);
    } else this.#violate(`device information request ${d[0]}`);
  }

  #file(s, d, answer) {
    const fail = code => answer([0xFF, code]);
    if (s.put) {
      if (d[0] !== 0x05) return this.#violate(`file data packet type ${d[0]}`);
      const room = (this.model === 'cx2' ? 1440 : 254) - 1;
      if (d.length - 1 > room) this.#violate(`${d.length - 1} file bytes in one packet`);
      s.put.chunks.push(d.slice(1));
      s.put.got += d.length - 1;
      if (s.put.got > s.put.size) this.#violate('more file bytes than announced');
      if (s.put.got >= s.put.size) {
        const { path, size, chunks } = s.put;
        s.put = null;
        if (!this.dirs.has(parentOf(path))) return fail(0x09);
        const bytes = new Uint8Array(size);
        let o = 0;
        for (const c of chunks) { bytes.set(c, o); o += c.length; }
        this.addFile(path, bytes);
        answer([0xFF, 0x00]);
      }
      return;
    }
    if (s.get) {
      if (s.get.stage === 'wait04') {
        if (d.length !== 1 || d[0] !== 0x04) return this.#violate('a file read not confirmed with 0x04');
        s.get.stage = 'sending';
        const room = (this.model === 'cx2' ? 1440 : 254) - 1;
        const b = s.get.bytes;
        for (let o = 0; o < b.length; o += room) answer([0x05, ...b.subarray(o, o + room)]);
        s.get.stage = 'wait_end';
        return;
      }
      if (s.get.stage === 'wait_end') {
        if (get16(d, 0) !== 0xFF00 || d.length !== 2) this.#violate('a file read not ended with 0xFF00');
        s.get = null;
        if (this.chatty && this.model !== 'cx2') {
          // Observed on 4.5.5 after a file read: once the host disconnects,
          // the OS opens a session of its own (0x8000 to 0x4060, data 0x02)
          // and then disconnects it.
          this.#afterSession = () => {
            this.#held.push({ srcSid: 0x8000, dstSid: 0x4060, seq: this.#seq, data: [0x02] });
            this.#seq = (this.#seq + 1) & 255 || 1;
            this.#held.push({ srcSid: 0x40DE, dstSid: 0x4060, seq: this.#seq, data: u16(0x8000) });
            this.#seq = (this.#seq + 1) & 255 || 1;
            this.#flush();
          };
        }
      }
      return;
    }
    if (s.dir) {
      if (d[0] === 0x0E) {
        const e = s.dir.shift();
        if (!e) return answer([0xFF, 0x00]);
        return answer([0x0F, 0x10, 0x00, ...padded(e.name), ...u32(e.size), ...u32(e.date), e.dir ? 1 : 0, 0]);
      }
      if (d[0] === 0x0F) { s.dir = null; return answer([0xFF, 0x00]); }
      return this.#violate(`folder listing command ${d[0]}`);
    }
    if (d[0] === 0x0D) {
      const r = readPath(d, 1);
      if (!r) return this.#violate('a listing without a path');
      const p = norm(r.path);
      if (!this.dirs.has(p)) return fail(0x0A);
      s.dir = this.#entries(p);
      return answer([0xFF, 0x00]);
    }
    const cmd = get16(d, 0);
    const r = readPath(d, 2);
    if (!r) return this.#violate(`file command ${cmd.toString(16)} without a path`);
    const path = norm(r.path);
    switch (cmd) {
      case 0x0301: {
        if (d.length < r.next + 4) return this.#violate('a file send without a size');
        const size = get32(d, r.next);
        if (this.full || size > this.storageFree) return fail(SIM_REPLY.FULL);
        s.put = { path, size, got: 0, chunks: [] };
        answer([0x04]);
        if (size === 0) this.#file(s, Uint8Array.of(0x05), answer);
        return;
      }
      case 0x0701: {
        const f = this.files.get(path);
        if (!f) return fail(0x0A);
        s.get = { bytes: f.bytes, stage: 'wait04' };
        return answer([0x03, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(f.bytes.length)]);
      }
      case 0x2001: {
        const f = this.files.get(path);
        if (f) return answer([0x20, ...u32(f.bytes.length), ...u32(f.date), 0, 0]);
        if (this.dirs.has(path)) return answer([0x20, 0, 0, 0, 0, ...u32(5), 1, 0]);
        return fail(0x0A);
      }
      case 0x0A03:
        if (this.dirs.has(path) || this.files.has(path)) return fail(0x12);
        this.mkdirs(path);
        return answer([0xFF, 0x00]);
      case 0x0B03:
        if (!this.dirs.has(path) || path === '/') return fail(0x0A);
        if (this.#entries(path).length) return fail(0x18);
        this.dirs.delete(path);
        return answer([0xFF, 0x00]);
      case 0x0901:
        if (!this.files.delete(path)) return fail(0x0A);
        return answer([0xFF, 0x00]);
      case 0x2101: {
        const to = readPath(d, r.next);
        if (!to) return this.#violate('a move without a destination');
        const f = this.files.get(path);
        if (!f || !this.dirs.has(parentOf(norm(to.path)))) return fail(0x0A);
        this.files.delete(path);
        this.files.set(norm(to.path), f);
        return answer([0xFF, 0x00]);
      }
      default:
        return this.#violate(`file command ${cmd.toString(16)}`);
    }
  }

  #entries(dir) {
    const prefix = dir === '/' ? '/' : dir + '/';
    const out = [];
    for (const d of this.dirs) if (d !== dir && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) out.push({ name: d.slice(prefix.length), size: 0, date: 5, dir: true });
    for (const [p, f] of this.files) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push({ name: p.slice(prefix.length), size: f.bytes.length, date: f.date, dir: false });
    return out;
  }
}
