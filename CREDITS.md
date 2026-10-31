<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Credits

## libnspire

nspirelink is a port of parts of [libnspire](https://github.com/tangrs/libnspire)
by tangrs (GPL-3.0-or-later), read as vendored in libnspire-sys 0.3.4 from
[libnspire-rs](https://github.com/lights0123/libnspire-rs) by lights0123:

- the NavNet packet layer and its checksums (`packet.c`),
- the data and service layers and the connection (`data.c`, `service.c`, `init.c`, `usb.c`),
- NavNet SE, the CX II's transport (`cx2.cpp`),
- the device information, folder and file services (`services/devinfo.c`, `dir.c`, `file.c`),
- the way OS versions pack minor and patch into one byte (libnspire-rs `info.rs`).
