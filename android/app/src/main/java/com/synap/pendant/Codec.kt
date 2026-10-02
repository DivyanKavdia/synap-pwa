package com.synap.pendant

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Byte payloads cross the JS bridge as base64; the shim turns them into DataViews. */
object Codec {
    fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    fun decode(text: String): ByteArray = Base64.decode(text, Base64.NO_WRAP)

    fun json(map: Map<String, Any?>): JSONObject {
        val out = JSONObject()
        map.forEach { (key, value) -> out.put(key, wrap(value)) }
        return out
    }

    private fun wrap(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { obj ->
            value.forEach { (k, v) -> obj.put(k.toString(), wrap(v)) }
        }
        is List<*> -> JSONArray().also { arr -> value.forEach { arr.put(wrap(it)) } }
        else -> value
    }
}

/**
 * Backs `navigator.bluetooth.getDevices()`.
 *
 * Web Bluetooth returns devices the origin was previously granted. We keep the
 * same contract with SharedPreferences, keyed by MAC address — which is what the
 * PWA stores in `localStorage["dk-pendant-device-id"]`, so `restoreKnownPendant()`
 * matches across app restarts. That is actually stronger than Chrome, where the
 * id is an origin-scoped hash that resets when site data is cleared.
 */
object DeviceStore {
    private const val PREFS = "synap-permitted-devices"

    fun remember(context: Context, address: String, name: String?) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putString(address, name ?: prefs.getString(address, null) ?: "").apply()
    }

    fun forget(context: Context, address: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(address).apply()
    }

    fun list(context: Context): List<Map<String, Any?>> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.all.entries
            .sortedBy { it.key }
            .map { mapOf("id" to it.key, "name" to (it.value as? String)?.ifBlank { null }) }
    }
}
