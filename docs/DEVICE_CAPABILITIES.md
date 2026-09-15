# Device capabilities

## Catalog and ownership

The canonical catalog is `devices/catalog.json` in **synap-firmware**. This repository stores an exact copy. `tools/device-catalog.cjs` generates `devices/profiles.js`, used by module decoding, OTA target validation and firmware release selection. The browser never downloads configuration to decide which hardware it can flash.

```sh
node tools/device-catalog.cjs --from ../synap-firmware
node tools/device-catalog.cjs --check
```

Commit the catalog and generated profiles together. `npm test` rejects stale generated profiles. Device target strings, numeric module IDs, product markers and wire-bit positions are compatibility contracts; do not rename them as part of a UI change.

| Module ID | Target                  | Driver profile        | Optional functions                                   |
| --------- | ----------------------- | --------------------- | ---------------------------------------------------- |
| 1         | `esp32s3-fh4r2-qspi-4m` | S3 / external I2S     | Touch, battery, standby                              |
| 2         | `esp32c3-supermini-4m`  | C3 / external I2S     | Touch, battery telemetry, standby                    |
| 3         | `xiao-esp32s3-sense-8m` | Chakshu / onboard PDM | Camera, photo, video, SD, local voice/model services |

## Three independent checks

1. **Supported:** the known device profile permits a feature and firmware advertises its capability bit. Unexpected extra bits cannot enable a camera on C3/S3. Media and voice services additionally require their advertised protocol version.
2. **Ready:** firmware reports that the relevant hardware initialized. Photo/video need a ready camera; paired video additionally needs a ready microphone and SD recordings need ready storage. Missing SD does not block PWA capture or an embedded flash voice model. A legacy identity can identify C3/S3 but cannot claim hardware readiness or unlock Chakshu.
3. **Allowed now:** the account is associated with the current Chakshu, the physical GATT service is still current, and the operation has ownership. OTA, recovery/finalization, another tab's recording, account changes and stale connections can block an otherwise supported and ready operation.

`devices/capabilities.js` owns the first two checks. `devices/identity.js`, the recorder and Chakshu media controller own connection/account permissions. A permanent public device ID is an association key, not authentication or proof of exclusive physical ownership. Bluetooth display names are presentation only.

## User-facing availability

| Operation                 | Required state                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Audio only                | Normal recorder handshake, microphone and valid negotiated audio transport                                     |
| Browse saved visuals      | Associated Chakshu on the signed-in account; cached association works offline                                  |
| Take photo / online video | Associated connected Chakshu, media v1, ready camera and photo/video capability                                |
| Video with sound          | Online video plus a separately owned ordinary audio recording                                                  |
| Offline video / SD import | Current media protocol and ready SD; paired recording also needs ready camera, microphone and SD audio support |
| Hardware recheck          | Chakshu hardware-check support and idle GATT ownership; readiness is not required to retry initialization      |
| Local voice controls      | Voice v1 and initialized listener/model; the PWA lease is account/visibility/connection bound                  |
| Embedded model OTA        | Chakshu image with embedded model; no SD requirement                                                           |
| Automatic BLE standby     | Safe firmware build and supported standby feature; current Chakshu profile remains awake                       |

A stop operation remains reachable even if hardware readiness is lost after capture starts. Failure of optional camera or voice initialization must not disable core audio connection or the ability to install firmware.

## Source map

| Responsibility                                                 | Source                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Catalog generation and fixed release limits                    | `tools/device-catalog.cjs`, `devices/catalog.json`, `devices/profiles.js` |
| Feature and readiness rules                                    | `devices/capabilities.js`                                                 |
| Device identity and published connection lease                 | `devices/identity.js`                                                     |
| Descriptor decoding and hardware-check client                  | `devices/modules.js`                                                      |
| Device settings and capability badges                          | `devices/panel.js`, `devices/panel.css`                                   |
| Firmware-compatible standby                                    | `devices/power.js`                                                        |
| Chakshu capture, media storage, player and voice/model clients | `devices/chakshu/`                                                        |
| Header recording/camera/video actions                          | `capture-ui.js`                                                           |
| Image validation and production manifest selection             | `ota.js`, `releases.js`                                                   |

The 20-byte descriptor at `4fa12350` preserves its existing format. Bytes 4–5 contain supported bits, 6–7 readiness, 14 the media extension, and 15 the voice extension. See the [firmware capability contract](https://github.com/DivyanKavdia/synap-firmware/blob/main/docs/DEVICE_CAPABILITIES.md) for complete fields.

## Changing a capability

Update the firmware catalog and implementation first. Preserve the wire contract or introduce an explicit protocol version. Synchronize this repository, add tests for both enabled and excluded devices, and run the relevant browser journeys. Add scripts to `index.html` in dependency order and to `sw.js`; advance cache/query revisions together. Release both repositories through their checks. A deployed PWA must remain usable with older firmware long enough to update it.
