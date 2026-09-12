# Recording notifications and iOS Dynamic Island

## Current PWA

Enable **Settings → Device → While listening → Recording notification** and allow the browser's notification permission. Permission is requested only from that switch, never on startup or automatically from a pendant gesture. The preference takes effect immediately.

On browsers exposing notification actions (including supported Android Chrome installations), a silent Synap notification appears once the pendant confirms recording. It offers:

- **Stop & save** through the existing recorder's stop/drain/save path.
- **Mark moment** through the existing journal-backed bookmark path, while pendant audio is connected.
- Tap the notification body to return to the recording page.

The browser controls button count and presentation. Stop has priority when only one action is available. A supported desktop meeting capture has Stop & save; pendant bookmarks are not offered for desktop audio. Notification content contains generic source/status text and a start timestamp, without conversation names, transcripts or people. The OS may display the timestamp; there is no promised second-by-second notification timer.

During a disconnect the notification says the connection is interrupted, hides Mark moment, and offers Save received audio when the recorder can safely stop recovery. Stopping/saving updates reflect the core recorder state; the notification closes when the take ends. Disabling the preference removes the notification and leaves capture running. Closing or reloading a recording page remains subject to existing recording recovery limits.

Notifications do not keep Bluetooth or audio alive. Android can suspend the page, and `requireInteraction` does not make a web notification a pinned Android foreground-service notification. Keep Synap open while listening. Browser permission, OS notification settings and device behavior still apply.

## Ownership and failures

The service worker stores the recording page's client ID and its take ID in notification data. Pendant take IDs include a page nonce, so reloading cannot reuse them. Actions are sent to that page only and checked against the currently confirmed take. No action toggles capture or issues START. Duplicate in-flight actions, expired messages, inactive takes and old session IDs are rejected.

The worker waits up to four seconds for an action response. If the page is suspended, the action fails, or no page remains, it focuses or opens Synap. Opening a new page never replays Stop or Mark. A slow stop can continue through the existing recorder while Synap is brought forward. Notification display/close operations are serialized; a slow display cannot overwrite a later Stop. Startup removes orphaned notifications without clearing a notification owned by another live page. An abruptly killed browser may leave a stale notification until the next app visit or tap.

## Platform support and native implementation boundary

| Surface | Current PWA | Native work required |
| --- | --- | --- |
| Android recording notification actions | Supported where the browser exposes notification actions, with permission and a live recording page | A foreground service owning BLE capture/storage for dependable background recording; a `connectedDevice` service for pendant capture, and `microphone` only when capturing the phone mic |
| iOS web notifications | Home Screen web apps can receive Web Push; this feature does not add push alerts or claim live recording controls | A native app for recording controls with dependable access to its recording session |
| iOS Lock Screen Live Activity | Unavailable in the PWA | ActivityKit + a WidgetKit extension, driven by the native recorder |
| iOS Dynamic Island | Unavailable in the PWA | The same Live Activity, with compact/minimal status and expanded actions on compatible iPhones |

For an iOS implementation, keep the Synap web UI if useful, but place BLE connection ownership, audio journaling and recording state in native code. A web view wrapper alone cannot provide dependable background capture. A native recording session should drive the Live Activity's source, start time, connection state, saving state and available actions. Stop and Mark must execute through native App Intents, validate the session ID, update durable state, and then refresh/end the Live Activity. Interactive buttons require iOS 17 or later and belong in the expanded/Lock Screen presentation; compact Dynamic Island displays status. Device authentication may be required for an interaction. Pause/resume is not implemented by the current pendant protocol and must be designed before exposing it.

No native Xcode/Android project, Live Activity extension, signing configuration or distributable mobile build is included in this PWA change.

## Sources

- [Notifications API standard](https://notifications.spec.whatwg.org/): service worker notifications, action limits and click events.
- [WebKit: Web Push for Home Screen web apps on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
- [Apple: displaying live data with Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities).
- [Apple: adding interactivity to widgets and Live Activities](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities).
- [Android: foreground service types and prerequisites](https://developer.android.com/about/versions/14/changes/fgs-types-required).

## Validation

`node --test tests/recording-notifications.cjs` covers notification lifecycle, ownership, timeouts, stale/duplicate actions, denied permissions, unavailable iOS controls, action limits and slow display ordering.

`node tools/recording-notifications-smoke.cjs` uses the production page, service worker, browser messaging and IndexedDB with simulated pendant and OS notification display. It checks Mark persistence, Stop/save/cleanup, rejection of an earlier take's Stop and opt-out. Headless Chromium has no notification center, so physical Android notification shade/Lock Screen behavior and OS background suspension require a real-device check; this test does not certify those behaviors.
