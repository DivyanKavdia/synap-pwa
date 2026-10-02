# Synap for Android

A native shell that runs the existing Synap PWA with **real Android BLE underneath
it**, so the pendant link survives the screen going off.

`app.js`, `devices/*`, `ota.js`, `event-channel.js` and `disconnect-protection.js`
are used **completely unmodified**. The only PWA change is a 33-line auth patch,
supplied separately as `synap-pwa-native-shell-auth.patch`.

---

## 1. Why this exists rather than a TWA

Android System WebView has never implemented Web Bluetooth. A Trusted Web
Activity avoids that by running the page in Chrome — but then Chrome owns the
lifecycle and freezes the page once it is backgrounded, so capture stops when
the screen goes off. A pendant you have to keep unlocked on screen is not a
pendant.

So the WebView belongs to us, and one line is what makes background capture work:

```kotlin
override fun onPause() {
    super.onPause()   // deliberately does NOT call webView.onPause() / pauseTimers()
}
```

WebView only freezes JavaScript when the host app asks it to. Paired with the
foreground service in `PendantService.kt` and its partial wake lock, the page's
timers and the GATT callbacks both keep running with the screen off.

---

## 2. How the pieces fit

```
  PWA (unmodified, loaded from https://divyankavdia.github.io/synap-pwa/)
        │  navigator.bluetooth.*
  synap-ble-shim.js        injected at document start, before app.js runs
        │  SynapBleNative.*  (@JavascriptInterface)
  BleBridge.kt             batches events, marshals base64 payloads
        │
  BleManager.kt            BluetoothGatt + serial operation queue
        │
  PendantService.kt        foreground service, keeps the process alive
```

**The WebView loads the live origin, not bundled assets.** Your backend's CORS
allowlist (`backend/src/config.ts`) and the Google OAuth client are both
registered against `https://divyankavdia.github.io`. Loading from
`file://` or an asset-loader origin would break every backend call, and
`app.js` gates on `window.isSecureContext` anyway. A useful side effect: PWA
updates ship to the app without rebuilding the APK.

### The shim

`app/src/main/assets/synap-ble-shim.js` implements exactly the Web Bluetooth
subset the PWA uses:

| | |
| --- | --- |
| `navigator.bluetooth` | `requestDevice`, `getDevices`, `getAvailability`, `availabilitychanged` |
| `BluetoothDevice` | `id`, `name`, `gatt`, `watchAdvertisements`, `forget`, `gattserverdisconnected`, `advertisementreceived` |
| `gatt` | `connected`, `connect`, `disconnect`, `getPrimaryService` |
| service | `getCharacteristic` |
| characteristic | `readValue`, `writeValueWithResponse`, `writeValueWithoutResponse`, `startNotifications`, `stopNotifications`, `value`, `characteristicvaluechanged` |

It is injected with `WebViewCompat.addDocumentStartJavaScript`, scoped to the PWA
origin, so it is in place before `app.js` reads `navigator.bluetooth`.

Two details that were load-bearing:

- **`device.id` is the MAC address**, which is stable across app restarts.
  `restoreKnownPendant()` keys off `localStorage["dk-pendant-device-id"]`, so
  reconnect-after-reload works. This is actually stronger than Chrome, where the
  id is an origin-scoped hash that resets when site data is cleared.
- **`error.name` survives the bridge.** `app.js` branches on
  `error.name === "TimeoutError"` to decide whether a native request may still be
  in flight; losing that would break the reconnect path.

### The GATT queue

Android permits exactly one outstanding GATT operation per connection. Every
read, write, descriptor write, MTU exchange and discovery goes through the queue
in `BleManager.kt`, with a 12-second watchdog per operation. The PWA has its own
`queueGattOperation`, but not on every path, so this queue is the authoritative
one.

`requestMtu(517)` is enqueued **before** service discovery. `app.js:1357` already
notes that Android negotiates MTU asynchronously, and the firmware reports the
negotiated value in its status frame — discovering first leaves it pinned at 23,
below the PWA's `MIN_STREAM_MTU = 32` guard, and streaming never starts.

Notifications are coalesced into ~16 ms batches before crossing into JS. At full
audio rate the pendant produces well over a hundred notifications a second, and
one `evaluateJavascript` per frame is a lot of JNI for nothing. The shim replays
each batch in order, so per-frame semantics on the PWA side are unchanged.

### Google Sign-In

Google refuses Sign in with Google inside a WebView. Your PWA already solved this
shape of problem for Bluefy on iOS — `google-auth.js` starts a pairing
transaction, Safari completes the sign-in, Bluefy claims it. The patch generalises
that: the Android shell takes the same path and hands the login to **Chrome via a
Custom Tab**, which Google accepts.

Plain Android Chrome has no shell bridge and keeps the direct GIS path. The
existing test *"Android must keep direct GIS login"* still passes.

No User-Agent spoofing. That is the usual workaround, it violates Google's
policy, and they have been steadily hardening against it.

---

## 3. Building

Needs Android Studio, or a command-line SDK with platform 35 and build-tools 35.

```bash
./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

Install on the phone:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Then apply the PWA patch and deploy it, or sign-in will not work in the shell:

```bash
cd /path/to/synap-pwa
git apply /path/to/synap-pwa-native-shell-auth.patch
node tests/auth-pairing.cjs
```

**I could not build the APK for you.** `dl.google.com` and `repo1.maven.org` are
both blocked from this sandbox, so neither the Android SDK nor the Kotlin
compiler could be fetched. The Kotlin here is unit-verified by review only —
expect to fix a compile error or two on the first `assembleDebug`. The JavaScript
shim, which is the part with the subtle semantics, **is** tested (see below).

---

## 4. Verifying

```bash
node tools/shim-contract.cjs
```

Runs the real shim against a fake native bridge and replays app.js's actual
connect sequence: requestDevice with the filter shape `runtime-compat.js`
produces, connect, discovery, subscribe, a batched notification pair, read,
both write flavours, a `TimeoutError` rejection, advertisement watching with an
`AbortController`, disconnect, and a reconnect that must rebuild the service
graph rather than hand back characteristics bound to the dead link.

It also asserts the shim object stays monkey-patchable, because
`runtime-compat.js` rebinds `requestDevice` and sets
`__synapDiscoveryCompatInstalled` on it.

---

## 5. Known gaps, honestly

- **Not built or run on a device.** Everything below the shim is unexercised.
- **Battery.** A partial wake lock plus a live BLE link plus a WebView that is
  never paused is a real drain. Measure before drawing conclusions about the
  pendant's battery, because the phone's will move too.
- **OEM battery killers.** Xiaomi, Oppo, Vivo and Samsung kill foreground
  services aggressively regardless of what the docs say. The app requests a
  battery-optimisation exemption; on some skins the user must also pin the app in
  the recents screen. Test on the handsets you actually care about.
- **`watchAdvertisements`** is implemented as a filtered low-power scan. The PWA
  already degrades to periodic recovery if it fails, so this is an optimisation,
  not a dependency.
- **No `requestLEScan`, no `bluetooth.referringDevice`.** The PWA uses neither.
- **Chooser UI is a plain list dialog.** Functional, not designed. It shows name
  and RSSI, live as devices are found.
