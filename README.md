<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# nspirelink

A JavaScript library that talks to a TI-Nspire over WebUSB: device
information (model, OS, boot versions, storage), folder listings, and
sending, receiving, deleting and moving files and folders. It is a port of
[libnspire](https://github.com/tangrs/libnspire), including its NavNet SE
layer for the CX II family. Where it departs from libnspire, the code says
why.

calcplex.com uses it to send games from its TI-Nspire pages; the page code it
serves is in `calcplex/`.

Plain ES modules, no dependencies, no build step. Runs in Chrome or Edge
(WebUSB), and in Node 20+ for the tests.

| File | What it is |
|---|---|
| `nspirelink.mjs` | The link: `NspireLink`, `NspireLinkError`, the framing |
| `sim/calculator.mjs` | A simulated CX and CX II behind a `USBDevice`-shaped interface; the test oracle |
| `calcplex/` | The games page code calcplex.com serves |
| `test/` | The tests: `npm test` |

## Use

```js
import { NspireLink } from './nspirelink.mjs';
const link = await NspireLink.request();   // call from a click
await link.open();
await link.ready();
const info = await link.info();             // { model, name, os, boot1, boot2, storageFree, ... }
const files = await link.list('/');         // '/' is My Documents
await link.put('/Game.tns', bytes, { onProgress: (sent, total) => {} });
const copy = await link.get('/Game.tns');
await link.delete('/Game.tns');
```

Errors are `NspireLinkError` with a stable `code`; the ones in `LINK_LOST`
close the link. Operations on one link run one at a time.

## Status

Tested against the simulator, and the classic path against TI's OS 4.5.5 in
an emulator. Observed on hardware with a CX II CAS (OS 5.0) through Chrome on
macOS; the original CX has not been tried on hardware yet, and Windows and
Linux have not been tried.

## Platforms

Chromium browsers only (WebUSB). An original CX on Windows needs a WinUSB
driver, which TI's own software does not work with, so TI's software is the
better way there. Linux needs a udev rule for the device.

## Licence

GPL-3.0-or-later, as libnspire. See `LICENSE` and `CREDITS.md`.

Most of this code was written with AI.
