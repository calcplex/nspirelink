// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 CalcPlex. Part of nspirelink: https://github.com/calcplex/nspirelink
// Derived from libnspire, Copyright (C) the libnspire authors; see CREDITS.md in the nspirelink repository.
//
// A TI-Nspire over WebUSB: its device information, folder listings, and
// sending, receiving and deleting files and folders. It follows libnspire
// (packet.c, data.c, service.c, init.c, cx2.cpp and the devinfo, dir and file
// services) and says why wherever it does not. Runs in a browser, and in Node
// against any object shaped like a USBDevice.
//
//   NavNet packet   16-byte header, then data            every model
//   NNSE message    12-byte header, then a NavNet packet  CX II only
//
// Protocol numbers are big-endian.

export const TI_VENDOR_ID = 0x0451;
/** USB product ids: the CX, CX CAS and older Nspire models, and the CX II family. */
export const NSPIRE_PRODUCT_ID = 0xE012;
export const CX2_PRODUCT_ID = 0xE022;
export const PRODUCT_IDS = Object.freeze([NSPIRE_PRODUCT_ID, CX2_PRODUCT_ID]);

const MAGIC = 0x54FD;
const HEADER = 16;
const HOST_ADDR = 0x6400;
const DEVICE_ADDR = 0x6401;
const SID_ADDRESS = 0x4003;
const SID_DISCONNECT = 0x40DE;
const SID_ACK_ODD = 0xFF;
const SID_ACK_EVEN = 0xFE;
const SID_NACK = 0xD3;
const ACK_FLAG = 0x0A;
const FIRST_HOST_SID = 0x8000;
const BIG_DATA = 0xFF;

export const SERVICE = Object.freeze({ DEVICE_INFO: 0x4020, FILE: 0x4060 });

// Data bytes a NavNet packet carries (packet_max_datasize).
const MAX_DATA = 254;
const MAX_DATA_CX2 = 1440;

// NavNet SE, the CX II's wrapper (cx2.cpp).
const NNSE_HEADER = 12;
const NNSE_MAX = NNSE_HEADER + 1472;
const NNSE = Object.freeze({ ADDR_REQ: 0x01, TIME: 0x02, STREAM: 0x04, UNKNOWN: 0x08, ACK: 0x80 });
const NNSE_ME = 0xFE;
const NNSE_ALL = 0xFF;
const NNSE_CALC = 0x01;
// cx2.cpp reads up to ten messages for a handshake, an acknowledgement or a
// stream packet before it gives up.
const NNSE_TRIES = 10;

// libnspire's NSP_TIMEOUT for every transfer. Here a timeout closes the link
// (see LINK_LOST), as a WebUSB transfer that timed out cannot be cancelled.
const TIMEOUT_MS = 10000;
// The calculator answers the end of a file only once the file is written.
// Not measured on hardware; generous on purpose.
const FILE_END_TIMEOUT_MS = 60000;
// How long ready() waits for a classic calculator's address request before
// it addresses the calculator anyway (libnspire waits NSP_TIMEOUT and fails).
const ADDRESS_WAIT_MS = 4000;
const CLEAR_HALT_MS = 1000;
// What one IN transfer asks for: more than any NavNet packet or NNSE message,
// in whole 512-byte USB packets.
const READ_SIZE = 1536;
// A path is at most this many UTF-8 bytes (nspire_dir_item.name holds 240).
const MAX_PATH_BYTES = 239;
// get() refuses a file the calculator says is larger than this.
const MAX_GET_BYTES = 64 * 1024 * 1024;

export class NspireLinkError extends Error {
  constructor(code, message, { cause, ...details } = {}) {
    super(message, { cause });
    this.name = 'NspireLinkError';
    this.code = code;
    Object.assign(this, details);
  }
}

// These close the link. libnspire keeps its handle, but a WebUSB transfer
// that timed out cannot be cancelled and would swallow the next reply, and
// after a packet out of protocol the calculator may be partway through an
// exchange nothing would drain.
export const LINK_LOST = Object.freeze(['TIMEOUT', 'USB_ERROR', 'DISCONNECTED', 'PROTOCOL', 'NACK', 'BUSY']);

// What the link let pass where libnspire fails or stays silent:
//   noAddressRequest  a classic calculator sent no address request in time, so it
//                     was addressed anyway
//   unexpectedFirst   the first packet was not an address request
//   resetFailed       the browser refused the USB reset (libnspire fails)
//   badMessage        a CX II message with a bad checksum, skipped (libnspire skips it too)
//   keptStream        a CX II stream message that came while waiting for an
//                     acknowledgement, kept for the next read (libnspire drops it)
//   foreignPacket     a packet for another service, acknowledged or refused (as libnspire)
//   haltsCleared      both endpoints cleared before closing on a lost link
//   configSwitchFailed  the browser refused a CX II's configuration switch,
//                     so the link reset it instead (libnspire always resets)
//   paddingDropped    bytes after a packet or CX II message in the same USB
//                     transfer, dropped (libnspire reads one per transfer and
//                     drops them too). A real CX II pads a 64-byte message to 65.
export const ANOMALIES = Object.freeze(['noAddressRequest', 'unexpectedFirst', 'resetFailed', 'badMessage', 'keptStream', 'foreignPacket', 'haltsCleared', 'configSwitchFailed', 'paddingDropped']);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Bytes

function be16(n) { return [(n >> 8) & 0xFF, n & 0xFF]; }
function be32(n) { return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]; }
function readBe16(b, o) { return (b[o] << 8) | b[o + 1]; }
function readBe32(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
function readBe64(b, o) { return readBe32(b, o) * 2 ** 32 + readBe32(b, o + 4); }

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** NavNet's data checksum (packet.c, calculate_data_checksum). */
export function dataChecksum(bytes) {
  let sum = 0;
  for (const byte of bytes) {
    const t1 = ((byte << 8) | (sum >> 8)) & 0xFFFF;
    sum &= 0xFF;
    const t2 = ((((sum & 0xF) << 4) ^ sum) << 8) & 0xFFFF;
    const t3 = t2 >> 5;
    sum = ((t3 >> 7) ^ t1 ^ t2 ^ t3) & 0xFFFF;
  }
  return sum;
}

/** NavNet's header checksum: the byte sum of the header's first 15 bytes. */
export function headerChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < HEADER - 1; i++) sum += bytes[i];
  return sum & 0xFF;
}

/** NNSE's checksum (cx2.cpp, compute_checksum): 16-bit big-endian words, carries folded in. */
export function nnseChecksum(bytes) {
  let acc = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) acc += (bytes[i] << 8) | bytes[i + 1];
  if (bytes.length & 1) acc += bytes[bytes.length - 1] << 8;
  while (acc > 0xFFFF) acc = (acc >>> 16) + (acc & 0xFFFF);
  return acc;
}

/**
 * One NavNet packet as bytes. Data under 255 bytes goes in the header's size
 * byte; longer data (CX II only) is marked 0xFF and carries its length in
 * its first four bytes.
 */
export function encodePacket({ srcAddr, srcSid, dstAddr, dstSid, ack = 0, seq = 0, data = [] }) {
  const body = data.length < BIG_DATA ? Uint8Array.from(data) : Uint8Array.from([...be32(data.length), ...data]);
  const out = new Uint8Array(HEADER + body.length);
  out.set([...be16(MAGIC), ...be16(srcAddr), ...be16(srcSid), ...be16(dstAddr), ...be16(dstSid)], 0);
  out.set(be16(dataChecksum(body)), 10);
  out[12] = data.length < BIG_DATA ? data.length : BIG_DATA;
  out[13] = ack;
  out[14] = seq;
  out[15] = headerChecksum(out);
  out.set(body, HEADER);
  return out;
}

/** The whole length of the NavNet packet at the start of `bytes`, or 0 when its header is not all there. */
function packetLength(bytes) {
  if (bytes.length < HEADER) return 0;
  if (bytes[12] !== BIG_DATA) return HEADER + bytes[12];
  if (bytes.length < HEADER + 4) return 0;
  return HEADER + 4 + readBe32(bytes, HEADER);
}

/** A NavNet packet from bytes, checked as packet_recv checks it; throws PROTOCOL. */
export function decodePacket(bytes) {
  if (bytes.length < HEADER) throw protocolError(`A packet of ${bytes.length} bytes is shorter than a header.`);
  if (readBe16(bytes, 0) !== MAGIC) throw protocolError('A packet did not start with the NavNet constant.');
  if (headerChecksum(bytes) !== bytes[15]) throw protocolError('A packet header failed its checksum.');
  const length = packetLength(bytes);
  if (!length || bytes.length < length) throw protocolError('A packet was cut short.');
  const body = bytes.subarray(HEADER, length);
  if (dataChecksum(body) !== readBe16(bytes, 10)) throw protocolError('A packet\'s data failed its checksum.');
  return {
    srcAddr: readBe16(bytes, 2), srcSid: readBe16(bytes, 4), dstAddr: readBe16(bytes, 6), dstSid: readBe16(bytes, 8),
    ack: bytes[13], seq: bytes[14], data: bytes[12] === BIG_DATA ? body.subarray(4) : body,
  };
}

/** One NNSE message as bytes, its checksum filled in (writePacket). */
export function encodeNnse({ misc = 0, service, src = NNSE_ME, dest = NNSE_CALC, unknown = 0, reqAck = 0, seqno = 0, data = [] }) {
  const out = new Uint8Array(NNSE_HEADER + data.length);
  out.set([misc, service, src, dest, unknown, reqAck, ...be16(out.length), ...be16(seqno), 0, 0], 0);
  out.set(data, NNSE_HEADER);
  out.set(be16(nnseChecksum(out) ^ 0xFFFF), 10);
  return out;
}

/** An NNSE message from bytes; null when its checksum fails. */
export function decodeNnse(bytes) {
  if (bytes.length < NNSE_HEADER || nnseChecksum(bytes) !== 0xFFFF) return null;
  return {
    misc: bytes[0], service: bytes[1], src: bytes[2], dest: bytes[3], unknown: bytes[4], reqAck: bytes[5],
    length: readBe16(bytes, 6), seqno: readBe16(bytes, 8), data: bytes.subarray(NNSE_HEADER, readBe16(bytes, 6)),
  };
}

/**
 * A path as libnspire's data_build 's' writes it: UTF-8, padded with zeros to
 * at least 8 bytes, then a terminating zero.
 */
export function encodePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
    throw new NspireLinkError('BAD_PATH', `Not a calculator path: ${JSON.stringify(path)}. Paths start with / (My Documents).`);
  }
  const bytes = encoder.encode(path);
  if (bytes.length > MAX_PATH_BYTES) throw new NspireLinkError('BAD_PATH', `The path ${path} is longer than ${MAX_PATH_BYTES} bytes.`);
  const out = new Uint8Array(Math.max(bytes.length, 8) + 1);
  out.set(bytes, 0);
  return out;
}

// data_scan 's': a zero-terminated string padded to at least 9 bytes in all.
function scanPadded(b, o) {
  const end = b.indexOf(0, o);
  if (end < 0) throw protocolError('A name in a reply had no end.');
  return { text: decoder.decode(b.subarray(o, end)), next: o + Math.max(end - o, 8) + 1 };
}

// data_scan 'S': a zero-terminated string.
function scanString(b, o) {
  const end = b.indexOf(0, o);
  if (end < 0) throw protocolError('A string in a reply had no end.');
  return { text: decoder.decode(b.subarray(o, end)), next: end + 1 };
}

function protocolError(message, details) {
  return new NspireLinkError('PROTOCOL', message, details);
}

// ---------------------------------------------------------------------------
// Device information

/** An OS or boot version as devinfo carries it: the minor byte packs minor and patch (minor×10+patch). */
export function versionString(bytes, o = 0) {
  const [major, packed] = [bytes[o], bytes[o + 1]];
  return `${major}.${Math.floor(packed / 10)}.${packed % 10}.${readBe16(bytes, o + 2)}`;
}

/** Hardware types devinfo names (api/devinfo.h). */
export const HW_TYPE = Object.freeze({ 0x0E: 'cas', 0x1E: 'noncas', 0x0F: 'cas_cx', 0x1F: 'noncas_cx' });

/**
 * The first devinfo reply (type 0x01, then struct deviceinfo_01, packed and
 * big-endian). The electronic id the struct ends with is the calculator's
 * serial; a web page has no use for it, so it is not read.
 */
export function parseDeviceInfo(reply) {
  if (reply.length < 1 + 65) throw protocolError(`The device information was ${reply.length} bytes, too short.`);
  const b = reply.subarray(1);
  return {
    storageFree: readBe64(b, 0), storageTotal: readBe64(b, 8), ramFree: readBe64(b, 16), ramTotal: readBe64(b, 24),
    battery: b[32], charging: b[34] !== 0, clockSpeed: b[35],
    os: versionString(b, 36), boot1: versionString(b, 40), boot2: versionString(b, 44),
    runLevel: readBe16(b, 52),
    lcd: { width: readBe16(b, 58), height: readBe16(b, 60), bpp: b[62], sampleMode: b[63] },
    hwType: b[64],
  };
}

/**
 * The model, from the USB product id first, then the hardware type and the
 * OS file extension the calculator names: 'cx2' (CX II family), 'cx' (CX,
 * CX CAS), 'classic' (the grey-screen models) or 'other'. `cas` is null when
 * nothing says.
 */
export function modelOf(productId, { hwType, osExtension = '' } = {}) {
  const ext = osExtension.toLowerCase().replace(/^\./, '');
  const cas = /^(tcc|tnc)/.test(ext) ? true : /^(tco|tno|tct)/.test(ext) ? false
    : hwType === 0x0E || hwType === 0x0F ? true : hwType === 0x1E || hwType === 0x1F ? false : null;
  let model = 'other';
  if (productId === CX2_PRODUCT_ID) model = 'cx2';
  else if (productId === NSPIRE_PRODUCT_ID) {
    if (hwType === 0x0F || hwType === 0x1F || /^tc[oc]$/.test(ext)) model = 'cx';
    else if (hwType === 0x0E || hwType === 0x1E) model = 'classic';
  }
  const base = { cx2: 'TI-Nspire CX II', cx: 'TI-Nspire CX', classic: 'TI-Nspire', other: 'TI-Nspire' }[model];
  return { model, cas, name: cas ? `${base} CAS` : base };
}

// ---------------------------------------------------------------------------
// The link

export class NspireLink {
  /** Ask the browser to let the user pick a calculator; `options` are fromDevice's. */
  static async request({ usb = globalThis.navigator?.usb, ...options } = {}) {
    if (!usb) throw new NspireLinkError('NO_WEBUSB', 'This browser cannot talk to USB devices. Use Chrome or Edge on a computer.');
    let device;
    try {
      device = await usb.requestDevice({ filters: PRODUCT_IDS.map(productId => ({ vendorId: TI_VENDOR_ID, productId })) });
    } catch (e) {
      if (e?.name === 'NotFoundError') throw new NspireLinkError('NO_DEVICE_SELECTED', 'No calculator was chosen.');
      throw new NspireLinkError('USB_ERROR', `The browser could not show the device list: ${e?.message ?? e}`);
    }
    return NspireLink.fromDevice(device, options);
  }

  /** TI-Nspire devices this page was already allowed to use. */
  static async granted({ usb = globalThis.navigator?.usb } = {}) {
    if (!usb) return [];
    return (await usb.getDevices()).filter(d => d.vendorId === TI_VENDOR_ID && PRODUCT_IDS.includes(d.productId));
  }

  /**
   * A link over a USBDevice. `timeout` applies to each USB transfer,
   * `fileTimeout` to the calculator's answer once a whole file was sent,
   * `addressWait` to a classic calculator's first packet. `reset: false`
   * skips the USB reset libnspire does when it opens a calculator (a CX II
   * is never reset unless its configuration switch is refused; see open()).
   */
  static fromDevice(device, options) {
    return new NspireLink(device, options);
  }

  opened = false;
  /** True for the CX II family (USB product id 0xE022), which wraps NavNet in NNSE. */
  cx2 = false;
  /** Called with ('out' | 'in', bytes) for every NavNet packet. */
  onPacket = null;
  anomalies = Object.fromEntries(ANOMALIES.map(k => [k, 0]));
  onAnomaly = null;

  #timeout;
  #fileTimeout;
  #addressWait;
  #reset;
  #in = null;
  #out = null;
  #rx = new Uint8Array(0);
  #pendingIn = null;
  #queue = Promise.resolve();
  #closedReason = null;
  #ready = false;
  // nspire_handle
  #hostSid = SID_ADDRESS;
  #deviceSid = SID_ADDRESS;
  #seq = 1;
  // cx2.cpp: its sequence number is process-wide there, per link here.
  #nnseSeq = 0;
  #nnseDone = false;
  #streams = [];

  constructor(device, { timeout = TIMEOUT_MS, fileTimeout = FILE_END_TIMEOUT_MS, addressWait = ADDRESS_WAIT_MS, reset = true } = {}) {
    if (!device) throw new NspireLinkError('NO_DEVICE', 'No USB device was given.');
    this.device = device;
    this.cx2 = device.productId === CX2_PRODUCT_ID;
    this.#timeout = timeout;
    this.#fileTimeout = fileTimeout;
    this.#addressWait = addressWait;
    this.#reset = reset;
  }

  /** Data bytes per NavNet packet: 254, or 1440 on a CX II. */
  get maxData() { return this.cx2 ? MAX_DATA_CX2 : MAX_DATA; }

  /**
   * usb_get_device: set configuration 1, reset, claim interface 0, and take
   * the first bulk IN and OUT endpoints. Nothing goes over the cable until
   * ready(). OPEN_FAILED carries `step` (open, config, reset, claim) and the
   * WebUSB error as `cause`; the link is left closed.
   *
   * A CX II is not reset: it is switched to its second configuration and
   * back to 1 instead. Measured on a CX II CAS (OS 5.0.0.1683):
   * the switch starts its handshake over within 250 ms and the device keeps
   * its USB identity, while a reset makes macOS re-enumerate it as a new
   * device. libusb follows that; Chrome does not, and the CX II has no serial
   * number, so the page loses its permission and the claim fails. Without
   * either, a CX II that an earlier session addressed sends nothing at all.
   * If the browser refuses the switch, open() falls back to the reset.
   */
  async open() {
    const d = this.device;
    if (d.vendorId !== TI_VENDOR_ID || !PRODUCT_IDS.includes(d.productId)) {
      throw new NspireLinkError('NOT_NSPIRE', 'This USB device is not a TI-Nspire.', { productId: d.productId });
    }
    let step = 'open';
    try {
      if (!d.opened) await d.open();
      step = 'config';
      let restarted = false;
      const other = this.cx2 ? d.configurations?.find(c => c.configurationValue !== 1) : null;
      if (other) {
        try {
          if (d.configuration?.configurationValue === 1) await d.selectConfiguration(other.configurationValue);
          await d.selectConfiguration(1);
          restarted = true;
        } catch (e) {
          if (!d.opened) throw e;
          this.#anomaly('configSwitchFailed', String(e?.message ?? e));
        }
      }
      if (d.configuration?.configurationValue !== 1) await d.selectConfiguration(1);
      if (this.#reset && !restarted) {
        step = 'reset';
        try {
          await d.reset();
        } catch (e) {
          if (!d.opened) throw e;
          this.#anomaly('resetFailed', String(e?.message ?? e));
        }
      }
      step = 'claim';
      await d.claimInterface(0);
    } catch (e) {
      await this.close();
      throw new NspireLinkError('OPEN_FAILED', `Could not open the calculator (${step}): ${e?.message ?? e}`, { step, cause: e });
    }
    const endpoints = d.configuration?.interfaces.find(i => i.interfaceNumber === 0)
      ?.alternates.find(a => a.alternateSetting === 0)?.endpoints ?? [];
    this.#in = endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
    this.#out = endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
    if (!this.#in || !this.#out) {
      await this.close();
      throw new NspireLinkError('NO_ENDPOINTS', 'This USB device does not look like a TI-Nspire (no bulk IN/OUT endpoints were found).');
    }
    this.opened = true;
    this.#closedReason = null;
    this.#ready = false;
    this.#rx = new Uint8Array(0);
    this.#pendingIn = null;
    return this;
  }

  async close() {
    this.opened = false;
    this.#ready = false;
    try { await this.device.releaseInterface(0); } catch { /* not claimed, or already gone */ }
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }

  /**
   * nspire_init after the USB part: a classic calculator's address request
   * answered (a CX II's NNSE handshake comes first), so services can run.
   */
  ready() {
    return this.#run('ready', async () => {
      this.#hostSid = SID_ADDRESS;
      this.#deviceSid = SID_ADDRESS;
      this.#seq = 1;
      this.#nnseSeq = 0;
      this.#nnseDone = false;
      this.#streams = [];
      if (!this.cx2) {
        let first = null;
        try {
          first = await this.#packetRecv(this.#addressWait);
        } catch (e) {
          if (e?.code !== 'TIMEOUT') throw e;
          // A calculator that was addressed by an earlier session and not
          // reset sends nothing; it takes the address packet all the same.
          // The read stays pending (#fill), so nothing it brings is lost.
          this.#anomaly('noAddressRequest', `nothing in ${this.#addressWait} ms`);
        }
        if (first && first.srcSid !== SID_ADDRESS) this.#anomaly('unexpectedFirst', `service ${hex(first.srcSid)}`);
      }
      await this.#packetSend({ ...this.#packetNew(), data: [...be16(DEVICE_ADDR), 0xFF, 0x00] });
      this.#hostSid = FIRST_HOST_SID;
      this.#ready = true;
    }, { allowUnready: true });
  }

  /**
   * nspire_device_info: { model, cas, name, cx2, os, boot1, boot2,
   * storageFree, storageTotal, ramFree, ramTotal, battery, charging,
   * clockSpeed, runLevel, lcd, hwType, deviceName, fileExtension, osExtension }.
   */
  info() {
    return this.#run('info', () => this.#service(SERVICE.DEVICE_INFO, async () => {
      await this.#dataWrite([0x01]);
      const info = parseDeviceInfo(await this.#dataRead());
      await this.#dataWrite([0x02]);
      const deviceName = scanString(await this.#dataRead(), 1).text;
      await this.#dataWrite([0x03]);
      const exts = await this.#dataRead();
      const file = scanString(exts, 1);
      const osExtension = scanString(exts, file.next).text;
      return {
        ...modelOf(this.device.productId, { hwType: info.hwType, osExtension }),
        cx2: this.cx2, ...info, deviceName, fileExtension: file.text, osExtension,
      };
    }));
  }

  /**
   * nspire_dirlist: [{ name, size, date, dir }]. '/' is My Documents. A
   * folder that is not there is NOT_FOUND.
   */
  list(path = '/') {
    return this.#run('list', () => this.#service(SERVICE.FILE, async () => {
      await this.#dataWrite([0x0D, ...encodePath(path), 0x00]);
      const begin = await this.#dataRead();
      if (begin[1] === 0x0A) throw new NspireLinkError('NOT_FOUND', `${path} is not on the calculator.`, { path, reply: hexBytes(begin) });
      if (begin[1] === 0x0F) throw new NspireLinkError('INVALID', `The calculator refused to list ${path}.`, { path, reply: hexBytes(begin) });
      const items = [];
      for (;;) {
        await this.#dataWrite([0x0E]);
        const r = await this.#dataRead();
        if (r[0] === 0xFF) break;
        // hbswwb0
        const name = scanPadded(r, 3);
        const o = name.next;
        if (r.length < o + 9) throw protocolError('A folder entry was cut short.');
        items.push({ name: name.text, size: readBe32(r, o), date: readBe32(r, o + 4), dir: r[o + 8] === 1 });
      }
      await this.#dataWrite([0x0F]);
      await this.#dataRead();
      return items;
    }));
  }

  /** nspire_attr: { name, size, date, dir }, or null when nothing is at `path`. */
  attr(path) {
    return this.#run('attr', () => this.#service(SERVICE.FILE, async () => {
      await this.#dataWrite([...be16(0x2001), ...encodePath(path), 0x00]);
      const r = await this.#dataRead();
      if (r[0] !== 0x20) return null;
      if (r.length < 10) throw protocolError('A file\'s attributes were cut short.');
      return { name: path, size: readBe32(r, 1), date: readBe32(r, 5), dir: r[9] === 1 };
    }));
  }

  /** nspire_dir_create. EXISTS when the calculator refuses (libnspire's reading of any refusal). */
  mkdir(path) {
    return this.#simple('mkdir', 0x0A03, path, false, 'EXISTS', `${path} already exists, or its parent folder is missing.`);
  }

  /** nspire_dir_delete; the folder must be empty. */
  rmdir(path) {
    return this.#simple('rmdir', 0x0B03, path, false, 'REFUSED', `The calculator would not delete the folder ${path}.`);
  }

  /** nspire_file_delete. */
  delete(path) {
    return this.#simple('delete', 0x0901, path, true, 'REFUSED', `The calculator would not delete ${path}.`);
  }

  /** nspire_file_move: rename or move a file or folder. */
  move(src, dst) {
    return this.#run('move', () => this.#service(SERVICE.FILE, async () => {
      await this.#dataWrite([...be16(0x2101), ...encodePath(src), ...encodePath(dst), 0x00]);
      const r = await this.#dataRead();
      if (readBe16(r, 0) !== 0xFF00) throw new NspireLinkError('REFUSED', `The calculator would not move ${src} to ${dst}.`, { path: src, reply: hexBytes(r) });
    }));
  }

  /**
   * nspire_file_write: send `bytes` as the file at `path`, replacing a file
   * of that name. `onProgress(sent, total)` follows each packet.
   */
  put(path, bytes, { onProgress } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return this.#run('put', () => this.#service(SERVICE.FILE, async () => {
      await this.#dataWrite([...be16(0x0301), ...encodePath(path), ...be32(data.length)]);
      const r = await this.#dataRead();
      if (r[0] !== 0x04) throw new NspireLinkError('REFUSED', `The calculator would not take ${path}.`, { path, reply: hexBytes(r) });
      const chunk = this.maxData - 1;
      for (let o = 0; o < data.length; o += chunk) {
        const part = data.subarray(o, o + chunk);
        const packet = new Uint8Array(part.length + 1);
        packet[0] = 0x05;
        packet.set(part, 1);
        await this.#dataWrite(packet);
        onProgress?.(Math.min(o + chunk, data.length), data.length);
      }
      const end = await this.#dataRead(this.#fileTimeout);
      if (readBe16(end, 0) !== 0xFF00) throw new NspireLinkError('REFUSED', `The calculator did not keep ${path}.`, { path, reply: hexBytes(end) });
      return { path, bytes: data.length };
    }));
  }

  /** nspire_file_read: the file at `path`, as bytes. NOT_FOUND when it is not there. */
  get(path, { onProgress } = {}) {
    return this.#run('get', () => this.#service(SERVICE.FILE, async () => {
      await this.#dataWrite([...be16(0x0701), ...encodePath(path)]);
      const r = await this.#dataRead();
      // h000000000w
      if (r.length < 15 || readBe16(r, 0) !== 0x0301) throw new NspireLinkError('NOT_FOUND', `${path} is not on the calculator.`, { path, reply: hexBytes(r) });
      const size = readBe32(r, 11);
      if (size > MAX_GET_BYTES) throw new NspireLinkError('TOO_LARGE', `${path} is ${size} bytes, more than this link reads.`, { path, size });
      await this.#dataWrite([0x04]);
      const out = new Uint8Array(size);
      let got = 0;
      while (got < size) {
        const part = (await this.#dataRead()).subarray(1);
        if (!part.length) throw protocolError('An empty packet in the middle of a file.');
        out.set(part.subarray(0, size - got), got);
        got += Math.min(part.length, size - got);
        onProgress?.(got, size);
      }
      await this.#dataWrite(be16(0xFF00));
      return out;
    }));
  }

  // dir_create, dir_delete, file_delete: 'hs' or 'hs0', answered 0xFF00 on success.
  #simple(op, command, path, trailingZero, code, message) {
    return this.#run(op, () => this.#service(SERVICE.FILE, async () => {
      await this.#dataWrite([...be16(command), ...encodePath(path), ...(trailingZero ? [0x00] : [])]);
      const r = await this.#dataRead();
      if (readBe16(r, 0) !== 0xFF00) throw new NspireLinkError(code, message, { path, reply: hexBytes(r) });
    }));
  }

  // -------------------------------------------------------------------------
  // Services (service.c)

  async #service(sid, fn) {
    this.#deviceSid = sid;
    let result;
    try {
      result = await fn();
    } catch (e) {
      if (!LINK_LOST.includes(e?.code)) await this.#disconnect();
      throw e;
    }
    await this.#disconnect();
    return result;
  }

  async #disconnect() {
    await this.#dataWrite(be16(this.#hostSid), { srcSid: SID_DISCONNECT });
    this.#hostSid = (this.#hostSid + 1) & 0xFFFF;
  }

  // -------------------------------------------------------------------------
  // Data (data.c)

  #packetNew() {
    return { srcAddr: HOST_ADDR, dstAddr: DEVICE_ADDR, srcSid: this.#hostSid, dstSid: this.#deviceSid, seq: this.cx2 ? 0 : this.#seq };
  }

  async #dataWrite(data, { srcSid } = {}) {
    if (data.length > this.maxData) throw new NspireLinkError('PROTOCOL', `${data.length} bytes do not fit one packet.`);
    const p = { ...this.#packetNew(), data };
    if (srcSid !== undefined) p.srcSid = srcSid;
    await this.#packetSend(p);
    // A CX II acknowledges at the NNSE layer, which #packetSend waited for.
    if (this.cx2) return;
    for (;;) {
      const r = await this.#packetRecv();
      if (r.dstSid === this.#hostSid) {
        if (r.srcSid === SID_ACK_ODD || r.srcSid === SID_ACK_EVEN) {
          this.#seq = (this.#seq + 1) & 0xFF || 1;
          return;
        }
        if (r.srcSid === SID_NACK) throw new NspireLinkError('NACK', 'The calculator refused a packet.');
      } else {
        await this.#handleUnknown(r);
      }
    }
  }

  async #dataRead(timeout = this.#timeout) {
    for (;;) {
      const r = await this.#packetRecv(timeout);
      if (r.dstSid === this.#hostSid) {
        if (!this.cx2) await this.#ack(r);
        return r.data;
      }
      await this.#handleUnknown(r);
    }
  }

  // handle_unknown: libnspire acknowledges a packet whose destination is the
  // disconnect service and refuses anything else meant for another service.
  async #handleUnknown(p) {
    this.#anomaly('foreignPacket', `from ${hex(p.srcSid)} to ${hex(p.dstSid)}`);
    if (p.dstSid === SID_DISCONNECT) await this.#ack(p);
    else await this.#ack(p, SID_NACK);
  }

  async #ack(p, srcSid = p.seq ? SID_ACK_ODD : SID_ACK_EVEN) {
    await this.#packetSend({ ...this.#packetNew(), srcSid, dstSid: p.srcSid, seq: p.seq, ack: ACK_FLAG, data: be16(p.dstSid) });
  }

  // -------------------------------------------------------------------------
  // Packets (packet.c)

  async #packetSend(p) {
    const bytes = encodePacket(p);
    this.#emit('out', bytes);
    if (this.cx2) await this.#nnseSendStream(bytes);
    else await this.#write(bytes, this.#timeout, 'sending a packet');
  }

  async #packetRecv(timeout = this.#timeout) {
    let bytes;
    if (this.cx2) {
      bytes = await this.#nnseRecvStream(timeout);
    } else {
      await this.#fill(HEADER, timeout, 'a packet');
      if (readBe16(this.#rx, 0) !== MAGIC) {
        this.#rx = new Uint8Array(0);
        throw protocolError('A packet did not start with the NavNet constant.');
      }
      let length = packetLength(this.#rx);
      if (!length) {
        await this.#fill(HEADER + 4, timeout, 'a packet');
        length = packetLength(this.#rx);
      }
      await this.#fill(length, timeout, 'a packet');
      bytes = this.#take(length, 'packet');
    }
    this.#emit('in', bytes);
    return decodePacket(bytes);
  }

  // -------------------------------------------------------------------------
  // NavNet SE (cx2.cpp)

  async #nnseReady(timeout) {
    if (this.#nnseDone) return;
    for (let i = 0; i < NNSE_TRIES && !this.#nnseDone; i++) {
      const m = await this.#nnseRead(timeout);
      if (m) await this.#nnseHandle(m);
    }
    if (!this.#nnseDone) throw new NspireLinkError('BUSY', 'The CX II did not finish connecting.');
  }

  async #nnseSendStream(navnet) {
    await this.#nnseReady(this.#timeout);
    const seqno = this.#nextSeqno();
    await this.#nnseWrite({ service: NNSE.STREAM, reqAck: 1, seqno, data: navnet });
    for (let i = 0; i < NNSE_TRIES; i++) {
      const m = await this.#nnseRead(this.#timeout);
      if (!m) continue;
      const stream = await this.#nnseHandle(m);
      if (stream) {
        this.#streams.push(stream);
        this.#anomaly('keptStream', `${stream.length} bytes before the acknowledgement`);
      }
      if (m.dest === NNSE_ME && m.service === (NNSE.STREAM | NNSE.ACK) && m.seqno === seqno) return;
    }
    throw new NspireLinkError('BUSY', 'The CX II did not acknowledge a packet.');
  }

  async #nnseRecvStream(timeout) {
    await this.#nnseReady(timeout);
    if (this.#streams.length) return this.#streams.shift();
    for (let i = 0; i < NNSE_TRIES; i++) {
      const m = await this.#nnseRead(timeout);
      if (!m) continue;
      const stream = await this.#nnseHandle(m);
      if (stream) return stream;
    }
    throw protocolError('The CX II sent no data.');
  }

  // handlePacket: acknowledge what asks for it, answer the handshake, and
  // return a stream message's NavNet packet.
  async #nnseHandle(m) {
    if (m.dest !== NNSE_ME && m.dest !== NNSE_ALL) return null;
    if (m.service & NNSE.ACK) return null;
    if (m.reqAck & 1) {
      await this.#nnseWrite({ misc: m.misc, service: m.service | NNSE.ACK, src: m.dest, dest: m.src, unknown: m.unknown, reqAck: m.reqAck & ~1, seqno: m.seqno });
    }
    switch (m.service) {
      case NNSE.ADDR_REQ:
        if (m.data.length < 65 || m.data[0] !== 0) return null;
        // cx2.cpp sends the answer twice: the calculator can miss the first
        // one after a reconnect, and ignores the second.
        await this.#nnseSend(NNSE.ADDR_REQ, [0x80]);
        await this.#nnseSend(NNSE.ADDR_REQ, [0x80]);
        return null;
      case NNSE.TIME: {
        if (m.data.length < 1 || m.data[0] !== 0) return null;
        const seconds = Math.floor(Date.now() / 1000);
        await this.#nnseSend(NNSE.TIME, [0x80, ...be32(seconds), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        this.#nnseDone = true;
        return null;
      }
      case NNSE.UNKNOWN:
        if (m.data.length !== 1 || m.data[0] !== 0x01) return null;
        await this.#nnseSend(NNSE.UNKNOWN, [0x81, 0x03]);
        return null;
      case NNSE.STREAM:
        return m.data.slice();
      default:
        return null;
    }
  }

  // sendMessage
  #nnseSend(service, data) {
    return this.#nnseWrite({ service, seqno: this.#nextSeqno(), data });
  }

  #nextSeqno() {
    const s = this.#nnseSeq;
    this.#nnseSeq = (this.#nnseSeq + 1) & 0xFFFF;
    return s;
  }

  #nnseWrite(fields) {
    return this.#write(encodeNnse({ src: NNSE_ME, dest: NNSE_CALC, ...fields }), this.#timeout, 'sending to the CX II');
  }

  // readPacket. libnspire checks the checksum over the last USB transfer
  // only; here it covers the whole message.
  async #nnseRead(timeout) {
    await this.#fill(NNSE_HEADER, timeout, 'a CX II message');
    const length = readBe16(this.#rx, 6);
    if (length < NNSE_HEADER || length > NNSE_MAX) {
      this.#rx = new Uint8Array(0);
      throw protocolError(`A CX II message said it was ${length} bytes long.`);
    }
    await this.#fill(length, timeout, 'a CX II message');
    const m = decodeNnse(this.#take(length, 'CX II message'));
    if (!m) this.#anomaly('badMessage', `service ${hex(bytes[1])}`);
    return m;
  }

  // -------------------------------------------------------------------------
  // USB (usb.c)

  // One packet or message per USB transfer, as libnspire reads them: the
  // buffer is empty when a read starts, so whatever follows `length` came in
  // the transfer that completed it and is padding (a real CX II sends a
  // 64-byte message as 65 bytes). Keeping it would shift every later read.
  #take(length, what) {
    const bytes = this.#rx.slice(0, length);
    if (this.#rx.length > length) this.#anomaly('paddingDropped', `${this.#rx.length - length} bytes after a ${length}-byte ${what}`);
    this.#rx = new Uint8Array(0);
    return bytes;
  }

  // Read until at least `n` bytes are buffered. A read that times out stays
  // pending and the next wait takes it over, so a late packet is never lost
  // to a read nobody awaits; LINK_LOST still closes the link on any timeout
  // outside ready()'s wait for the address request.
  async #fill(n, timeout, what) {
    while (this.#rx.length < n) {
      if (!this.#pendingIn) {
        this.#pendingIn = this.device.transferIn(this.#in.endpointNumber, READ_SIZE);
        this.#pendingIn.catch(() => {});
      }
      const r = await this.#transfer(this.#pendingIn, timeout, `waiting for ${what}`);
      this.#pendingIn = null;
      if (r.status !== 'ok') throw new NspireLinkError('USB_ERROR', `A USB read ended with status ${r.status}.`);
      if (!r.data?.byteLength) continue;
      this.#rx = concat(this.#rx, new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
    }
    return n;
  }

  async #write(bytes, timeout, during) {
    const r = await this.#transfer(this.device.transferOut(this.#out.endpointNumber, bytes), timeout, during);
    if (r.status !== 'ok' || r.bytesWritten !== bytes.length) {
      throw new NspireLinkError('USB_ERROR', `A USB write ended with status ${r.status} after ${r.bytesWritten} of ${bytes.length} bytes.`);
    }
  }

  async #transfer(promise, ms, during) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new NspireLinkError('TIMEOUT', `The calculator did not answer in ${ms} ms (${during}).`, { ms, during })), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } catch (e) {
      if (e instanceof NspireLinkError) throw e;
      if (e?.name === 'NotFoundError') throw new NspireLinkError('DISCONNECTED', 'The calculator was unplugged.', { cause: e });
      if (e?.name === 'TimeoutError') throw new NspireLinkError('TIMEOUT', `The calculator did not answer (${during}).`, { during, cause: e });
      throw new NspireLinkError('USB_ERROR', `USB error (${during}): ${e?.message ?? e}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------

  #run(op, fn, { allowUnready = false } = {}) {
    const run = async () => {
      if (this.#closedReason) throw new NspireLinkError('LINK_CLOSED', this.#closedReason);
      if (!this.opened) throw new NspireLinkError('NOT_OPEN', 'The calculator is not connected. Call open() first.');
      if (!allowUnready && !this.#ready) throw new NspireLinkError('NOT_READY', 'The link is not ready. Call ready() first.');
      try {
        return await fn();
      } catch (e) {
        if (e instanceof NspireLinkError && !e.op) e.op = op;
        if (LINK_LOST.includes(e?.code)) {
          this.#closedReason = `The link closed after an error during ${op}: ${e.message}`;
          if (e.code !== 'DISCONNECTED') await this.#clearHalts();
          await this.close();
        }
        throw e;
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  // Best effort: the close that follows is the real recovery.
  async #clearHalts() {
    if (typeof this.device.clearHalt !== 'function' || !this.#out) return;
    for (const [direction, endpoint] of [['out', this.#out], ['in', this.#in]]) {
      try {
        await this.#transfer(this.device.clearHalt(direction, endpoint.endpointNumber), CLEAR_HALT_MS, 'clearing the endpoint');
      } catch { /* already gone */ }
    }
    this.#anomaly('haltsCleared', 'both endpoints, before closing the link');
  }

  #emit(dir, bytes) {
    try { this.onPacket?.(dir, bytes); } catch { /* a listener never breaks the link */ }
  }

  #anomaly(kind, detail) {
    this.anomalies[kind]++;
    try { this.onAnomaly?.(kind, detail); } catch { /* a listener never breaks the link */ }
  }
}

function hex(n) { return `0x${n.toString(16).padStart(4, '0')}`; }
function hexBytes(b) { return Array.from(b.subarray(0, 16), x => x.toString(16).padStart(2, '0')).join(' '); }
