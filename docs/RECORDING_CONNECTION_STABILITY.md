# Recording connection stability

This repair removes two reproducible app-triggered disconnect paths. The user's iPhone screenshots show connect/disconnect notifications but do not identify the underlying radio or browser cause.

## Confirmed failures and changes

- A recovery handshake rejected a healthy GATT connection if the page became hidden during discovery. Visibility now prevents starting new automatic attempts, while an already-started handshake can finish. Explicit disconnect and disabling reconnect still cancel recovery.
- Every GATT operation exceeding 3.5 seconds previously disconnected the pendant, including a slow status read while audio notifications continued. A request deadline now reports failure without disconnecting an active recording receiving audio, or one whose callbacks may be suspended while hidden. The existing foreground audio-stall watchdog remains responsible for a silent stream.
- The underlying native operation retains the serialized queue until it settles. A caller timing out does not release that queue. Requests that expire while queued never execute later, and results belonging to an old connection are rejected. Idle request failures can still reset a stuck transport; Stop still deliberately disconnects if its command cannot be acknowledged.
- Returning to the foreground no longer polls status during an active recording. Audio and control notifications continue to drive capture state.
- All PWA-requested disconnects now log their reason. The disconnect event records whether the app requested it, visibility and elapsed time since audio. `browser-or-peripheral` means no app request was observed; Web Bluetooth does not supply the peripheral's radio termination reason in this event.

The queue follows the Web Bluetooth connection lifetime: [disconnect and connection checking](https://webbluetoothcg.github.io/web-bluetooth/#dom-bluetoothremotegattserver-disconnect). The specification's [visibility handling](https://webbluetoothcg.github.io/web-bluetooth/#visibility) concerns scanning; a hidden-page event is not an application-level instruction to tear down a recording.

## Firmware review

Reviewed `synap-firmware` main `21a0f7924aec76fa75cefedc7808e919515fd4cd`, including its battery-power changes. Active capture still selects the active CPU profile, disconnected automatic sleep is guarded by `!streamingEnabled`, and BLE standby leaves the connection available. The latest change alters paused OTA power and idle loop delay, not streaming transport. No firmware change or physical flash is part of this repair. These source checks do not establish which build is currently on the user's pendant or rule out physical radio/power failures.

## Verification

Before the repair, targeted behavioral tests reproduced cancellation on a hidden recovery handshake, a disconnect on delayed reads during capture, and acceptance of a late result from an old connection.

The full PWA browser fixture exercises recording recovery while native UI hides the page, a timed-out read with audio still arriving, foreground resumption, day and section navigation, reload/wake recovery and Stop while a native read is blocked. It checks one journal per take, saved PCM and serialized GATT requests. Unit checks cover cancelled queued commands, background capture, idle/stopping recovery and stale-connection completion. Existing memory workflows remain in CI.

These are simulated Bluetooth checks, not a physical iPhone/pendant endurance test. If disconnects continue, use **Settings → Diagnostics → Download log** immediately afterward so the new app-origin marker can guide the next investigation.

Cache generation: `1.0.0-shell47-ble-stability`.
