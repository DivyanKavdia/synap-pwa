@file:Suppress("MissingPermission")

package com.synap.pendant

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.util.ArrayDeque
import java.util.UUID

/**
 * Process-wide BLE owner.
 *
 * Everything here is deliberately not tied to an Activity: GATT callbacks arrive
 * on binder threads and must keep arriving while the screen is off, which is the
 * entire reason this app exists instead of a Trusted Web Activity.
 *
 * Android allows exactly ONE outstanding GATT operation per connection. Every
 * read/write/descriptor/MTU/discovery call therefore goes through [queue]; the
 * next one is only dispatched when the previous callback fires or the watchdog
 * times it out. The PWA has its own `queueGattOperation` on some paths, but not
 * all of them, so this queue is the authoritative one.
 */
@SuppressLint("MissingPermission")
object BleManager {

    private const val TAG = "SynapBle"
    private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    /** Large enough for the firmware's framed audio; it reports the negotiated
     *  value back in its status frame and the PWA rejects anything under 32. */
    private const val DESIRED_MTU = 517
    private const val OP_TIMEOUT_MS = 12_000L

    /** `BluetoothStatusCodes.SUCCESS`, inlined so the pre-33 branch still compiles. */
    private const val GATT_WRITE_OK = 0

    private val main = Handler(Looper.getMainLooper())

    /** Emits to the JS side. Set by [BleBridge]. */
    @Volatile
    var onEvent: ((type: String, payload: Map<String, Any?>) -> Unit)? = null

    private lateinit var appContext: Context

    private val adapter: BluetoothAdapter?
        get() = (appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    fun install(context: Context) {
        appContext = context.applicationContext
    }

    fun isSupported(): Boolean = adapter != null
    fun isEnabled(): Boolean = adapter?.isEnabled == true

    // ---------------------------------------------------------------- scanning

    private var scanning = false
    private var scanCallback: ScanCallback? = null

    /**
     * Starts a scan. [onFound] is called on the main thread for each distinct
     * device. Callers are responsible for calling [stopScan].
     */
    fun startScan(
        serviceUuids: List<UUID>,
        namePrefixes: List<String>,
        onFound: (BluetoothDevice, Int) -> Unit,
        onError: (String) -> Unit,
    ) {
        val scanner = adapter?.bluetoothLeScanner
        if (scanner == null) {
            onError("Bluetooth is off")
            return
        }
        stopScan()

        // Filtering on the service UUID in the scan filter keeps this compatible
        // with `neverForLocation` and avoids waking on every beacon nearby.
        val filters = serviceUuids.map {
            ScanFilter.Builder().setServiceUuid(ParcelUuid(it)).build()
        }.ifEmpty { listOf(ScanFilter.Builder().build()) }

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .build()

        val seen = HashSet<String>()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device ?: return
                val name = result.scanRecord?.deviceName ?: runCatching { device.name }.getOrNull()
                if (namePrefixes.isNotEmpty() && serviceUuids.isEmpty()) {
                    if (name == null || namePrefixes.none { name.startsWith(it, true) }) return
                }
                if (!seen.add(device.address)) return
                main.post { onFound(device, result.rssi) }
            }

            override fun onScanFailed(errorCode: Int) {
                main.post { onError("Scan failed ($errorCode)") }
            }
        }
        scanCallback = cb
        scanning = true
        runCatching { scanner.startScan(filters, settings, cb) }
            .onFailure {
                scanning = false
                onError(it.message ?: "Scan could not start")
            }
    }

    fun stopScan() {
        val cb = scanCallback ?: return
        scanCallback = null
        scanning = false
        runCatching { adapter?.bluetoothLeScanner?.stopScan(cb) }
    }

    // -------------------------------------------------------------- advertising

    private val advertisementWatches = HashMap<String, ScanCallback>()

    /** Backs `device.watchAdvertisements()`: a narrow scan for one address. */
    fun watchAdvertisements(address: String) {
        if (advertisementWatches.containsKey(address)) return
        val scanner = adapter?.bluetoothLeScanner ?: return
        val filter = ScanFilter.Builder().setDeviceAddress(address).build()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
            .build()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                emit(
                    "advertisementreceived",
                    mapOf("id" to address, "rssi" to result.rssi, "name" to result.scanRecord?.deviceName),
                )
            }
        }
        advertisementWatches[address] = cb
        runCatching { scanner.startScan(listOf(filter), settings, cb) }
            .onFailure { advertisementWatches.remove(address) }
    }

    fun unwatchAdvertisements(address: String) {
        val cb = advertisementWatches.remove(address) ?: return
        runCatching { adapter?.bluetoothLeScanner?.stopScan(cb) }
    }

    // ------------------------------------------------------------- connections

    private class Op(
        val label: String,
        val requestId: String?,
        val action: () -> Boolean,
    )

    private class Link(val address: String) {
        var gatt: BluetoothGatt? = null
        var mtu: Int = 23
        var ready = false
        val queue: ArrayDeque<Op> = ArrayDeque()
        var current: Op? = null
        var timeout: Runnable? = null
        var connectRequest: String? = null
    }

    private val links = HashMap<String, Link>()

    fun isConnected(address: String): Boolean {
        val link = links[address] ?: return false
        return link.ready && link.gatt != null
    }

    fun connect(address: String, requestId: String) {
        val device = runCatching { adapter?.getRemoteDevice(address) }.getOrNull()
        if (device == null) {
            settle(requestId, false, mapOf("message" to "Unknown Bluetooth device"))
            return
        }
        val existing = links[address]
        if (existing != null && existing.ready) {
            settle(requestId, true, mapOf("id" to address))
            return
        }
        val link = existing ?: Link(address).also { links[address] = it }
        link.connectRequest = requestId
        link.ready = false
        main.post {
            // autoConnect=false gives a fast direct connect; the PWA drives its
            // own reconnect policy and we must not fight it with a background
            // auto-connect that reconnects after a deliberate disconnect.
            link.gatt = device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }
    }

    fun disconnect(address: String) {
        val link = links[address] ?: return
        val gatt = link.gatt
        link.ready = false
        clearQueue(link, "Disconnected")
        runCatching { gatt?.disconnect() }
    }

    private fun teardown(link: Link) {
        val gatt = link.gatt
        link.gatt = null
        link.ready = false
        clearQueue(link, "Disconnected")
        runCatching { gatt?.close() }
    }

    // ------------------------------------------------------------------ queue

    /**
     * Every queue mutation runs on the main looper.
     *
     * Calls arrive from at least three threads: `@JavascriptInterface` methods
     * run on a WebView binder thread, GATT callbacks on another, and the chooser
     * on the UI thread. Funnelling them here removes the locks entirely and makes
     * the "one outstanding GATT operation" invariant genuinely single-threaded.
     */
    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }

    private fun enqueue(link: Link, op: Op): Unit = onMain {
        link.queue.add(op)
        pump(link)
    }

    // Explicit Unit: pump() recurses, and an inferred return type cannot be
    // resolved from a body that calls itself.
    private fun pump(link: Link): Unit = onMain {
        if (link.current == null) {
            val next = link.queue.poll()
            if (next != null) {
                link.current = next
                val started = runCatching { next.action() }.getOrDefault(false)
                if (!started) {
                    link.current = null
                    next.requestId?.let {
                        settle(it, false, mapOf("message" to "${next.label} could not start"))
                    }
                    pump(link)
                } else {
                    val watchdog = Runnable {
                        if (link.current === next) {
                            link.current = null
                            next.requestId?.let {
                                settle(
                                    it,
                                    false,
                                    mapOf("message" to "${next.label} timed out", "name" to "TimeoutError"),
                                )
                            }
                            pump(link)
                        }
                    }
                    link.timeout = watchdog
                    main.postDelayed(watchdog, OP_TIMEOUT_MS)
                }
            }
        }
    }

    private fun finish(link: Link, requestId: String?, ok: Boolean, payload: Map<String, Any?>): Unit = onMain {
        link.timeout?.let { main.removeCallbacks(it) }
        link.timeout = null
        link.current = null
        requestId?.let { settle(it, ok, payload) }
        pump(link)
    }

    private fun clearQueue(link: Link, reason: String): Unit = onMain {
        link.timeout?.let { main.removeCallbacks(it) }
        link.timeout = null
        val pending = ArrayList<Op>()
        link.current?.let { pending.add(it) }
        link.current = null
        // poll() is a platform type, so isNotEmpty() + poll() infers Op? and
        // would let a null into the list. Drain on the poll result instead.
        while (true) pending.add(link.queue.poll() ?: break)
        pending.forEach { op ->
            op.requestId?.let { settle(it, false, mapOf("message" to reason)) }
        }
    }

    // ------------------------------------------------------------- GATT verbs

    private fun characteristic(link: Link, service: String, char: String): BluetoothGattCharacteristic? {
        val gatt = link.gatt ?: return null
        val svc = gatt.getService(UUID.fromString(service)) ?: return null
        return svc.getCharacteristic(UUID.fromString(char))
    }

    fun read(address: String, service: String, char: String, requestId: String) {
        val link = links[address] ?: return settle(requestId, false, mapOf("message" to "Not connected"))
        enqueue(link, Op("Read", requestId, action@{
            val c = characteristic(link, service, char) ?: return@action false
            link.gatt?.readCharacteristic(c) ?: false
        }))
    }

    fun write(address: String, service: String, char: String, value: ByteArray, withResponse: Boolean, requestId: String) {
        val link = links[address] ?: return settle(requestId, false, mapOf("message" to "Not connected"))
        val type = if (withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        enqueue(link, Op("Write", requestId, action@{
            val c = characteristic(link, service, char) ?: return@action false
            val gatt = link.gatt ?: return@action false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(c, value, type) == GATT_WRITE_OK
            } else {
                @Suppress("DEPRECATION")
                run {
                    c.writeType = type
                    c.value = value
                    gatt.writeCharacteristic(c)
                }
            }
        }))
    }

    fun setNotify(address: String, service: String, char: String, enable: Boolean, requestId: String) {
        val link = links[address] ?: return settle(requestId, false, mapOf("message" to "Not connected"))
        enqueue(link, Op(if (enable) "Subscribe" else "Unsubscribe", requestId, action@{
            val c = characteristic(link, service, char) ?: return@action false
            val gatt = link.gatt ?: return@action false
            if (!gatt.setCharacteristicNotification(c, enable)) return@action false
            val cccd = c.getDescriptor(CCCD) ?: return@action false
            val indicate = c.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
            val on = if (indicate) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            val payload = if (enable) on else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeDescriptor(cccd, payload) == GATT_WRITE_OK
            } else {
                @Suppress("DEPRECATION")
                run {
                    cccd.value = payload
                    gatt.writeDescriptor(cccd)
                }
            }
        }))
    }

    /** Full inventory in one call: the shim builds its service and characteristic
     *  objects from this instead of round-tripping per lookup. */
    fun inventory(address: String): List<Map<String, Any?>> {
        val gatt = links[address]?.gatt ?: return emptyList()
        return gatt.services.map { svc ->
            mapOf(
                "uuid" to svc.uuid.toString(),
                "characteristics" to svc.characteristics.map { c ->
                    mapOf(
                        "uuid" to c.uuid.toString(),
                        "properties" to mapOf(
                            "read" to (c.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0),
                            "write" to (c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0),
                            "writeWithoutResponse" to
                                (c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0),
                            "notify" to (c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0),
                            "indicate" to (c.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0),
                        ),
                    )
                },
            )
        }
    }

    fun mtuOf(address: String): Int = links[address]?.mtu ?: 23

    // --------------------------------------------------------------- callback

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val address = gatt.device.address
            val link = links[address] ?: return
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                // MTU first, discovery second. The firmware reports the negotiated
                // MTU in its status frame and the PWA refuses to stream below 32,
                // so discovering before the exchange leaves it stuck at 23.
                enqueue(link, Op("MTU", null) { gatt.requestMtu(DESIRED_MTU) })
                enqueue(link, Op("Discover services", null) { gatt.discoverServices() })
                return
            }
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                val pendingConnect = link.connectRequest
                link.connectRequest = null
                teardown(link)
                if (pendingConnect != null) {
                    settle(pendingConnect, false, mapOf("message" to "Connection failed (status $status)"))
                } else {
                    emit("gattserverdisconnected", mapOf("id" to address, "status" to status))
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            val link = links[gatt.device.address] ?: return
            link.mtu = mtu
            finish(link, null, true, emptyMap())
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val address = gatt.device.address
            val link = links[address] ?: return
            finish(link, null, status == BluetoothGatt.GATT_SUCCESS, emptyMap())
            val request = link.connectRequest
            link.connectRequest = null
            if (status == BluetoothGatt.GATT_SUCCESS) {
                link.ready = true
                DeviceStore.remember(appContext, address, runCatching { gatt.device.name }.getOrNull())
                request?.let { settle(it, true, mapOf("id" to address, "mtu" to link.mtu)) }
            } else {
                request?.let { settle(it, false, mapOf("message" to "Service discovery failed ($status)")) }
                runCatching { gatt.disconnect() }
            }
        }

        @Deprecated("Pre-33 delivery path")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            deliverRead(gatt, c, c.value ?: ByteArray(0), status)
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) = deliverRead(gatt, c, value, status)

        override fun onCharacteristicWrite(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            val link = links[gatt.device.address] ?: return
            val op = link.current
            finish(
                link, op?.requestId, status == BluetoothGatt.GATT_SUCCESS,
                if (status == BluetoothGatt.GATT_SUCCESS) emptyMap()
                else mapOf("message" to "Write failed ($status)"),
            )
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            val link = links[gatt.device.address] ?: return
            val op = link.current
            finish(
                link, op?.requestId, status == BluetoothGatt.GATT_SUCCESS,
                if (status == BluetoothGatt.GATT_SUCCESS) emptyMap()
                else mapOf("message" to "Subscription failed ($status)"),
            )
        }

        @Deprecated("Pre-33 delivery path")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, c: BluetoothGattCharacteristic) {
            deliverNotification(gatt, c, c.value ?: ByteArray(0))
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
        ) = deliverNotification(gatt, c, value)
    }

    private fun deliverRead(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
        val link = links[gatt.device.address] ?: return
        val op = link.current
        if (status == BluetoothGatt.GATT_SUCCESS) {
            finish(link, op?.requestId, true, mapOf("value" to Codec.encode(value)))
        } else {
            finish(link, op?.requestId, false, mapOf("message" to "Read failed ($status)"))
        }
    }

    private fun deliverNotification(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
        emit(
            "characteristicvaluechanged",
            mapOf(
                "id" to gatt.device.address,
                "service" to (c.service?.uuid?.toString() ?: ""),
                "characteristic" to c.uuid.toString(),
                "value" to Codec.encode(value),
            ),
        )
    }

    // ---------------------------------------------------------------- plumbing

    private fun settle(requestId: String, ok: Boolean, payload: Map<String, Any?>) {
        emit("settle", payload + mapOf("requestId" to requestId, "ok" to ok))
    }

    private fun emit(type: String, payload: Map<String, Any?>) {
        val sink = onEvent
        if (sink == null) {
            Log.w(TAG, "Dropped $type: no JS sink attached")
            return
        }
        sink(type, payload)
    }
}
