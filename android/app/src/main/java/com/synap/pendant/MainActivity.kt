package com.synap.pendant

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.bluetooth.BluetoothDevice
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var bridge: BleBridge? = null
    private var chooserDialog: AlertDialog? = null

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            val missing = granted.filterValues { !it }.keys
            if (missing.any { it == Manifest.permission.BLUETOOTH_SCAN || it == Manifest.permission.BLUETOOTH_CONNECT }) {
                Toast.makeText(
                    this,
                    getString(R.string.bluetooth_permission_required),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        BleManager.install(this)
        requestRuntimePermissions()

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        setContentView(webView)
        applyWindowInsets()
        installBackNavigation()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(false)
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val bleBridge = BleBridge(
            webView = webView,
            chooser = ::showChooser,
            onLinkStateChanged = { connected ->
                if (connected) PendantService.start(this) else PendantService.stop(this)
            },
        )
        bridge = bleBridge
        webView.addJavascriptInterface(bleBridge, "SynapBleNative")
        webView.addJavascriptInterface(ShellBridge(), "SynapNative")

        installShim()

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // getUserMedia inside the PWA. Only ever grant the microphone,
                // and only once Android has granted RECORD_AUDIO to us.
                val wanted = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                val holdsRecordAudio = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.RECORD_AUDIO,
                ) == PackageManager.PERMISSION_GRANTED
                if (wanted.isNotEmpty() && holdsRecordAudio) request.grant(wanted.toTypedArray())
                else request.deny()
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val inApp = url.scheme == "https" &&
                    "${url.scheme}://${url.host}" == BuildConfig.PWA_ORIGIN
                if (inApp) return false
                openExternally(url.toString())
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // Only used when DOCUMENT_START_SCRIPT is unavailable.
                lateShimSource?.let { view.evaluateJavascript(it, null) }
            }
        }

        if (savedInstanceState == null) webView.loadUrl(BuildConfig.PWA_START_URL)
        else webView.restoreState(savedInstanceState)
    }

    /**
     * The shim has to be in place before any page script reads
     * `navigator.bluetooth`, which `app.js` does during module init.
     */
    /**
     * Keeps the page out from under the status and navigation bars.
     *
     * targetSdk 35 means Android 15 lays the activity out edge-to-edge, and the
     * PWA is built for that: index.html sets `viewport-fit=cover` and styles.css
     * pads the topbar and rail with `env(safe-area-inset-*)`. But WebView reports
     * those insets as 0 — Chrome feeds them to an installed PWA, a plain WebView
     * host does not — so every one of those paddings collapses and the topbar
     * slides under the notification bar.
     *
     * Padding the WebView itself gives the page a correctly sized viewport; the
     * strip behind the status bar then shows windowBackground, which is set to
     * the same #F4F7F5 as the PWA's theme-color meta.
     */
    /**
     * Back should move through the app, not drop out of it.
     *
     * Without this, the system Back button finishes the Activity on the first
     * press, which is the single clearest tell that something is a wrapped web
     * page rather than an app. Walk the WebView history first and only leave
     * when there is nowhere left to go.
     */
    private fun installBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    private fun applyWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
            val bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            // The keyboard supersedes the navigation bar rather than stacking on it.
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            windowInsets
        }
    }

    private var lateShimSource: String? = null

    private fun installShim() {
        val source = assets.open("synap-ble-shim.js").bufferedReader().use { it.readText() }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, source, setOf(BuildConfig.PWA_ORIGIN))
            return
        }
        // Older WebView: inject as early as the client allows. This races page
        // scripts on a cold load, so surface it rather than failing silently.
        lateShimSource = source
        Toast.makeText(this, getString(R.string.webview_update_recommended), Toast.LENGTH_LONG).show()
    }

    // ------------------------------------------------------------------ chooser

    private fun showChooser(request: BleBridge.ChooserRequest) {
        if (!hasBluetoothPermissions()) {
            requestRuntimePermissions()
            bridge?.settleChooser(request.requestId, null, null)
            return
        }

        val found = ArrayList<Pair<String, String>>()
        val adapter = ArrayAdapter<String>(this, android.R.layout.simple_list_item_1)

        var settled = false
        fun settle(address: String?, name: String?) {
            if (settled) return
            settled = true
            BleManager.stopScan()
            bridge?.settleChooser(request.requestId, address, name)
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.chooser_title)
            .setAdapter(adapter) { _, index ->
                val (address, name) = found[index]
                settle(address, name)
            }
            .setNegativeButton(R.string.cancel) { _, _ -> settle(null, null) }
            .setOnCancelListener { settle(null, null) }
            .create()

        chooserDialog?.dismiss()
        chooserDialog = dialog
        dialog.show()

        BleManager.startScan(
            serviceUuids = request.serviceUuids.mapNotNull { runCatching { java.util.UUID.fromString(it) }.getOrNull() },
            namePrefixes = request.namePrefixes,
            onFound = { device: BluetoothDevice, rssi: Int ->
                val name = runCatching { device.name }.getOrNull() ?: getString(R.string.unnamed_device)
                found.add(device.address to name)
                adapter.add("$name  ·  $rssi dBm")
                adapter.notifyDataSetChanged()
            },
            onError = { message ->
                Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
                dialog.dismiss()
                settle(null, null)
            },
        )
    }

    // -------------------------------------------------------------- permissions

    private fun bluetoothPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun hasBluetoothPermissions(): Boolean = bluetoothPermissions().all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestRuntimePermissions() {
        val wanted = bluetoothPermissions().toMutableList()
        wanted += Manifest.permission.RECORD_AUDIO
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = wanted.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) permissionLauncher.launch(missing.toTypedArray())
    }

    // ------------------------------------------------------------ shell bridge

    inner class ShellBridge {
        /**
         * Google Sign-In refuses to run inside a WebView. The PWA's existing
         * pairing transaction already handles that case for Bluefy on iOS; this
         * is the Android arm of the same flow, handing the login to real Chrome.
         */
        @JavascriptInterface
        fun openExternal(url: String) {
            runOnUiThread { openExternally(url) }
        }

        @JavascriptInterface
        fun isNativeShell(): Boolean = true
    }

    private fun openExternally(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme != "https") return
        runCatching {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, uri)
        }.onFailure {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
        }
    }

    // ------------------------------------------------------------- lifecycle

    /**
     * Deliberately does NOT call `webView.onPause()` or `pauseTimers()`.
     *
     * That is the single line that makes background capture work: WebView only
     * freezes JS when the host app asks it to. Paired with the foreground
     * service and its partial wake lock, the page's timers and the GATT
     * callbacks both keep running once the screen goes off.
     */
    override fun onPause() {
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        chooserDialog?.dismiss()
        bridge?.detach()
        BleManager.stopScan()
        super.onDestroy()
    }
}
