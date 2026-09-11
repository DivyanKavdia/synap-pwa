# Reload and wake reconnection

With **Reconnect automatically** enabled, the visible PWA restores its previously permitted pendant after reload and continues recovery when the pendant becomes available later. A saved sleep flag no longer permanently blocks that recovery.

## Behavior

- Restore the saved browser device ID through `navigator.bluetooth.getDevices()`. If there is no saved ID, use only one unambiguous permitted Synap device. Never open a device picker from a timer, page event or advertisement.
- Keep the existing short reconnect attempts. After they are exhausted, try at 30-second intervals while the page is visible. Each GATT connection attempt remains bounded by its existing 12-second timeout; permission enumeration is bounded at five seconds.
- Where `BluetoothDevice.watchAdvertisements()` is available, an advertisement from the remembered device can trigger recovery sooner. Reject stale/other-device events and coalesce bursts. If watching is unsupported or rejected, periodic recovery remains available.
- Allow a five-second settling period after a sleep event. The sleep guard preserves the user's actual reconnect preference separately from its temporary sleep suppression. A failed probe does not clear sleep; a live GATT service does. Changing the preference during sleep is respected after wake.
- Stop monitoring when connected, after manual disconnect, when the page is hidden/closed, or when automatic reconnect is off. Do not compete with an active capture, finalization or firmware update. Background connection attempts keep the Capture tile's collapsed state.
- Keep current recording behavior: a brief transport interruption can resume the existing journal; reload reconnects without issuing a new START. An orphaned hardware stream on reload is still stopped by the existing recovery logic.

The firmware's current gestures remain unchanged: double tap wakes **BLE standby** and starts recording; triple tap wakes **deep sleep**. One or two touches during deep sleep do not initialize BLE. See the [firmware controls](https://github.com/DivyanKavdia/synap-firmware/blob/21a0f7924aec76fa75cefedc7808e919515fd4cd/README.md).

## Browser boundary

Saved IDs alone cannot recreate Bluetooth permission. A browser that does not expose permitted-device restoration still needs a manual Connect tap after reload; Capture now explains that directly. Installing a PWA does not add a missing Bluetooth API. Wake recovery is limited to when the browser allows the visible page to run.

The APIs are capability-detected, following the [Chrome permitted-device sample](https://googlechrome.github.io/samples/web-bluetooth/get-devices.html) and [advertisement sample](https://googlechrome.github.io/samples/web-bluetooth/watch-advertisements.html). No browser-specific support is assumed.

## Verification

- All 202 PWA tests pass, including continued recovery after retry exhaustion, sleep preference handling, advertisement filtering, disabled/hidden/manual states, sleep settling and advertisement fallback.
- The production shell with simulated Bluetooth passes recording interruption/recovery, reload without another picker or START, wake by advertisement, delayed wake by polling, preference changes during sleep, a persisted sleep flag across reload, and manual connection on a browser without `getDevices()`.
- The memory browser journeys pass at 320 px light, 390 px dark and 1440 px light. The expanded Bluetooth journey is included in GitHub CI.

The Bluetooth fixture tests browser logic and protocol handoffs. Physical pendant wake latency and the user's iPhone browser capabilities are not measured here. Firmware is unchanged by this PWA release.

Cache generation: `1.0.0-shell46-wake-reconnect`.
