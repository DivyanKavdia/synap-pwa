package com.synap.pendant

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The `@JavascriptInterface` surface the shim talks to.
 *
 * Calls in are synchronous and cheap (they only enqueue); every result comes back
 * asynchronously through [dispatch]. Notifications are coalesced into batches:
 * at full audio rate the pendant produces well over a hundred notifications a
 * second, and one `evaluateJavascript` per frame is a needless amount of JNI and
 * string parsing. The shim replays a batch in order, so per-frame semantics on
 * the PWA side are unchanged.
 */
class BleBridge(
    private val webView: WebView,
    private val chooser: (request: ChooserRequest) -> Unit,
    private val onLinkStateChanged: (connected: Boolean) -> Unit,
) {

    data class ChooserRequest(
        val requestId: String,
        val serviceUuids: List<String>,
        val namePrefixes: List<String>,
        val acceptAll: Boolean,
    )

    private val main = Handler(Looper.getMainLooper())
    private val pending = ArrayList<JSONObject>(64)
    private var flushScheduled = false

    private val FLUSH_INTERVAL_MS = 16L
    private val FLUSH_THRESHOLD = 24

    init {
        BleManager.onEvent = { type, payload ->
            val event = Codec.json(payload).put("type", type)
            var flushNow = false
            synchronized(pending) {
                pending.add(event)
                if (pending.size >= FLUSH_THRESHOLD) flushNow = true
                else if (!flushScheduled) {
                    flushScheduled = true
                    main.postDelayed(::flush, FLUSH_INTERVAL_MS)
                }
            }
            if (type == "gattserverdisconnected") onLinkStateChanged(false)
            if (flushNow) main.post(::flush)
        }
    }

    private fun flush() {
        val batch: JSONArray
        synchronized(pending) {
            flushScheduled = false
            if (pending.isEmpty()) return
            batch = JSONArray()
            pending.forEach { batch.put(it) }
            pending.clear()
        }
        val script = "window.__synapBleNative && window.__synapBleNative.dispatch($batch);"
        if (Looper.myLooper() == Looper.getMainLooper()) {
            webView.evaluateJavascript(script, null)
        } else {
            main.post { webView.evaluateJavascript(script, null) }
        }
    }

    fun detach() {
        BleManager.onEvent = null
    }

    // --------------------------------------------------------- JS entry points

    @JavascriptInterface
    fun isSupported(): Boolean = BleManager.isSupported()

    @JavascriptInterface
    fun isEnabled(): Boolean = BleManager.isEnabled()

    /** Opens the device chooser. Mirrors `navigator.bluetooth.requestDevice`. */
    @JavascriptInterface
    fun requestDevice(optionsJson: String, requestId: String) {
        val options = runCatching { JSONObject(optionsJson) }.getOrDefault(JSONObject())
        val services = LinkedHashSet<String>()
        val prefixes = LinkedHashSet<String>()

        options.optJSONArray("filters")?.let { filters ->
            for (i in 0 until filters.length()) {
                val filter = filters.optJSONObject(i) ?: continue
                filter.optJSONArray("services")?.let { list ->
                    for (j in 0 until list.length()) services.add(list.optString(j).lowercase())
                }
                filter.optString("namePrefix").takeIf { it.isNotBlank() }?.let { prefixes.add(it) }
                filter.optString("name").takeIf { it.isNotBlank() }?.let { prefixes.add(it) }
            }
        }
        options.optJSONArray("optionalServices")?.let { list ->
            for (j in 0 until list.length()) services.add(list.optString(j).lowercase())
        }

        main.post {
            chooser(
                ChooserRequest(
                    requestId = requestId,
                    serviceUuids = services.toList(),
                    namePrefixes = prefixes.toList(),
                    acceptAll = options.optBoolean("acceptAllDevices", false),
                )
            )
        }
    }

    @JavascriptInterface
    fun getDevices(): String =
        JSONArray(DeviceStore.list(webView.context).map { Codec.json(it) }).toString()

    @JavascriptInterface
    fun forgetDevice(address: String) = DeviceStore.forget(webView.context, address)

    @JavascriptInterface
    fun connect(address: String, requestId: String) {
        BleManager.connect(address, requestId)
        onLinkStateChanged(true)
    }

    @JavascriptInterface
    fun disconnect(address: String) {
        BleManager.disconnect(address)
        onLinkStateChanged(false)
    }

    @JavascriptInterface
    fun isConnected(address: String): Boolean = BleManager.isConnected(address)

    @JavascriptInterface
    fun inventory(address: String): String =
        JSONArray(BleManager.inventory(address).map { Codec.json(it) }).toString()

    @JavascriptInterface
    fun mtu(address: String): Int = BleManager.mtuOf(address)

    @JavascriptInterface
    fun read(address: String, service: String, characteristic: String, requestId: String) =
        BleManager.read(address, service, characteristic, requestId)

    @JavascriptInterface
    fun write(
        address: String,
        service: String,
        characteristic: String,
        base64: String,
        withResponse: Boolean,
        requestId: String,
    ) = BleManager.write(
        address, service, characteristic, Codec.decode(base64), withResponse, requestId,
    )

    @JavascriptInterface
    fun setNotify(
        address: String,
        service: String,
        characteristic: String,
        enable: Boolean,
        requestId: String,
    ) = BleManager.setNotify(address, service, characteristic, enable, requestId)

    @JavascriptInterface
    fun watchAdvertisements(address: String) = BleManager.watchAdvertisements(address)

    @JavascriptInterface
    fun unwatchAdvertisements(address: String) = BleManager.unwatchAdvertisements(address)

    /** Called by the chooser once the user has picked, or cancelled. */
    fun settleChooser(requestId: String, address: String?, name: String?) {
        val payload = if (address == null) {
            mapOf("requestId" to requestId, "ok" to false, "message" to "User cancelled the requestDevice() chooser.", "name" to "NotFoundError")
        } else {
            DeviceStore.remember(webView.context, address, name)
            mapOf("requestId" to requestId, "ok" to true, "id" to address, "name" to name)
        }
        val event = Codec.json(payload).put("type", "settle")
        synchronized(pending) { pending.add(event) }
        main.post(::flush)
    }
}
