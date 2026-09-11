(function () {
  "use strict";

  // Shared BLE Protocol v2

  const APP_VERSION = "1.0.0";
  const APP_REVISION = "1.0.0-audio2";
  let deviceAssociation = null;
  let deviceIdentityMessage = "Not connected";
  const PROTOCOL_VERSION = 0x02;

  const SERVICE_UUID =
    "4fa12345-0000-1000-8000-00805f9b34fb";
  const AUDIO_CHAR_UUID =
    "4fa12346-0000-1000-8000-00805f9b34fb";
  const CONTROL_CHAR_UUID =
    "4fa12347-0000-1000-8000-00805f9b34fb";

  const CMD_STOP = 0x00;
  const CMD_START = 0x01;
  const CMD_GET_STATUS = 0x02;

  const AUDIO_MAGIC = 0xA5;
  const STATUS_MAGIC = 0x5A;
  const AUDIO_HEADER_BYTES = 8;
  const PCM_BYTES_PER_FRAME = 1600;
  const DEFAULT_SAMPLE_RATE = 16000;
  // Native protocol-v2 transport. The browser consumes exactly what firmware sends;
  // there is no BLE event rewriting or synthetic re-segmentation layer.
  const MIN_CHUNKS_PER_FRAME = 1;
  const MAX_CHUNKS_PER_FRAME = 20;
  const MAX_AUDIO_PAYLOAD_BYTES = 500;

  const DEVICE_STATE = {
    DISCONNECTED: 0,
    CONNECTED_IDLE: 1,
    STREAMING: 2,
    ERROR: 3
  };

  const ERROR_TEXT = {
    0: "No error",
    1: "BLE MTU is too small. Reconnect using Android Chrome.",
    2: "Audio notifications were not enabled before Start.",
    3: "The ESP audio source failed.",
    4: "PWA and ESP protocol versions do not match.",
    5: "The ESP received an invalid command.",
    6: "BLE transport changed. Stop and start again."
  };

  const RECORDING_RECONNECT_GRACE_MS = 5 * 60 * 1000;
  const START_TIMEOUT_MS = 5000;
  const COMMAND_TIMEOUT_MS = 3500;
  const MIN_STREAM_MTU = 32;
  const AUDIO_STALL_TIMEOUT_MS = 12000;
  const FOREGROUND_STALL_GRACE_MS = 12000;
  const INCOMPLETE_FRAME_TIMEOUT_MS = 900;
  const RECENT_FRAME_WINDOW = 512;
  const AUTO_RECONNECT_DELAYS_MS = [1200, 2600, 5200, 10000, 15000, 20000, 30000, 30000];
  const MAX_AUTO_RECONNECT_ATTEMPTS = AUTO_RECONNECT_DELAYS_MS.length;

  // DOM

  const ui = {
    connectionBadge: document.getElementById("connectionBadge"),
    connectionText: document.getElementById("connectionText"),
    connectButton: document.getElementById("connectButton"),
    connectButtonLabel: document.getElementById("connectButtonLabel"),
    startButton: document.getElementById("startButton"),
    stopButton: document.getElementById("stopButton"),
    recorderTitle: document.getElementById("recorderTitle"),
    recorderSubtitle: document.getElementById("recorderSubtitle"),
    waveformCanvas: document.getElementById("waveformCanvas"),
    timer: document.getElementById("timer"),
    levelText: document.getElementById("levelText"),
    signalMetric: document.getElementById("signalMetric"),
    signalDetail: document.getElementById("signalDetail"),
    framesMetric: document.getElementById("framesMetric"),
    framesDetail: document.getElementById("framesDetail"),
    transportMetric: document.getElementById("transportMetric"),
    transportDetail: document.getElementById("transportDetail"),
    qualityMetric: document.getElementById("qualityMetric"),
    qualityDetail: document.getElementById("qualityDetail"),
    recordingsList: document.getElementById("recordingsList"),
    libraryPagination: document.getElementById("libraryPagination"),
    libraryCountLabel: document.getElementById("libraryCountLabel"),
    showMoreRecordingsButton: document.getElementById("showMoreRecordingsButton"),
    showLessRecordingsButton: document.getElementById("showLessRecordingsButton"),
    recordingsCount: document.getElementById("recordingsCount"),
    datePicker: document.getElementById("datePicker"),
    dateStrip: document.getElementById("dateStrip"),
    selectedDateLabel: document.getElementById("selectedDateLabel"),
    dayLensTitle: document.getElementById("dayLensTitle"),
    glanceRecordings: document.getElementById("glanceRecordings"),
    glanceDuration: document.getElementById("glanceDuration"),
    glanceSummaries: document.getElementById("glanceSummaries"),
    glanceTranscripts: document.getElementById("glanceTranscripts"),
    insightsList: document.getElementById("insightsList"),
    insightsCount: document.getElementById("insightsCount"),
    emptyInsights: document.getElementById("emptyInsights"),
    emptyRecordings: document.getElementById("emptyRecordings"),
    clearRecordingsButton:
      document.getElementById("clearRecordingsButton"),
    diagnosticsLog: document.getElementById("diagnosticsLog"),
    copyDiagnosticsButton:
      document.getElementById("copyDiagnosticsButton"),
    clearDiagnosticsButton:
      document.getElementById("clearDiagnosticsButton"),
    toastRegion: document.getElementById("toastRegion"),
    settingsButton: document.getElementById("settingsButton"),
    chooseDeviceButton: document.getElementById("chooseDeviceButton"),
    recoveryButton: document.getElementById("recoveryButton"),
    settingsDialog: document.getElementById("settingsDialog"),
    settingsForm: document.getElementById("settingsForm"),
    closeSettingsButton:
      document.getElementById("closeSettingsButton"),
    endpointInput: document.getElementById("endpointInput"),
    tokenInput: document.getElementById("tokenInput"),
    llmEndpointInput: document.getElementById("llmEndpointInput"),
    autoProcessInput: document.getElementById("autoProcessInput"),
    queueStatus: document.getElementById("queueStatus"),
    runQueueButton: document.getElementById("runQueueButton"),
    pauseQueueButton: document.getElementById("pauseQueueButton"),
    retrySaveButton: document.getElementById("retrySaveButton"),
    wakeLockInput: document.getElementById("wakeLockInput"),
    installButton: document.getElementById("installButton"),
    appVersion: document.getElementById("appVersion")
  };

  // Runtime state

  let appState = "disconnected";
  let bluetoothDevice = null;
  let gattServer = null;
  let audioCharacteristic = null;
  let controlCharacteristic = null;
  let manualDisconnect = false;
  let connectInProgress = false;
  let needsDeviceSelection = false;
  let firmwareBusy = false;
  let firmwareUpdater = null;
  let checkFirmwareRelease = null;
  let selectedDayKey = localDateKey(new Date());
  let dayActivity = new Map();
  const LIBRARY_PAGE_SIZE = 5;
  let libraryRecordings = [];
  let libraryScope = "all";
  let libraryQuery = "";
  let libraryVisibleCount = LIBRARY_PAGE_SIZE;
  let libraryRenderEpoch = 0;

  let deviceStatus = {
    state: DEVICE_STATE.DISCONNECTED,
    error: 0,
    mtu: 0,
    attCapacity: 0,
    chunksPerFrame: 0,
    headerBytes: AUDIO_HEADER_BYTES,
    sampleRate: DEFAULT_SAMPLE_RATE,
    samplesPerFrame: 800,
    payloadBytes: 0
  };

  let recordingConfirmed = false;
  let recordingStartedAt = 0;
  let timerInterval = null;
  let startTimeout = null;
  let finalizeTimeout = null;
  let finalizing = false;
  let wakeLock = null;
  let recordingSessionId = 0;
  let finalizedSessionId = 0;
  let connectionEpoch = 0;
  let gattQueue = Promise.resolve();

  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let reloadRecoveryRunning = false;
  let lastReloadRecoveryAt = 0;
  let recordingReconnectPending = false;
  let recordingDisconnectedAt = 0;
  let recordingReconnectDeadline = null;
  let recordingResumeDeviceId = null;
  let recordingResumeBluetoothId = null;
  let recordingWasConfirmedBeforeDisconnect = false;

  let pendingFrames = new Map();
  let completedPcmFrames = [];
  let completedSequences = new Set();
  let unsavedAudio = false;
  let lastObservedSequence = null;
  let lastFrameCleanupAt = 0;
  let lastAudioAt = 0;
  let foregroundAt = performance.now();

  let sessionStats = createEmptyStats();
  let levelHistory = [];
  let currentRms = 0;
  let lastDb = -96;
  let waveformPhase = 0;
  let lastWaveDraw = 0;
  let metricsTimer = null;

  let diagnosticLines = [];
  let installPrompt = null;
  let renderedObjectUrls = [];
  let waveformPalette = null;
  let databasePromise = null;
  let currentRecordingId = null;
  let openingCapture = null;
  let persistenceRequested = false;
  const journal = globalThis.DKAudioStore ? new globalThis.DKAudioStore({onError: handleStorageError}) : null;
  let processor = null;

  let settings = {
    endpoint: "",
    llmEndpoint: "",
    autoProcess: false,
    token: "",
    wakeLock: true
  };

  function createEmptyStats() {
    return {
      packetsReceived: 0,
      invalidPackets: 0,
      duplicatePackets: 0,
      completeFrames: 0,
      incompleteFrames: 0,
      missingFrames: 0,
      pcmBytes: 0,
      firstSequence: null,
      lastSequence: null
    };
  }

  // Logging and feedback

  function log(message, detail) {
    const time = new Date().toISOString();
    let line = "[" + time + "] " + message;

    if (detail !== undefined) {
      try {
        line += " " +
          (typeof detail === "string"
            ? detail
            : JSON.stringify(detail));
      } catch (error) {
        line += " [unserializable detail]";
      }
    }

    diagnosticLines.push(line);

    if (diagnosticLines.length > 300) {
      diagnosticLines = diagnosticLines.slice(-300);
    }

    ui.diagnosticsLog.textContent = diagnosticLines.join("\n");
    ui.diagnosticsLog.scrollTop = ui.diagnosticsLog.scrollHeight;
    console.log(line);
  }

  function toast(message, type) {
    const element = document.createElement("div");
    element.className =
      "toast" + (type === "error" ? " toast-error" : "");
    element.textContent = message;
    ui.toastRegion.appendChild(element);

    window.setTimeout(function () {
      element.remove();
    }, 3600);
  }

  function friendlyError(error, operation) {
    if (!error) return "Unknown error";

    const name = error.name || "";
    const message = error.message || (typeof error === "number"
      ? "Operation failed (code " + error + "). See connection diagnostics."
      : String(error));

    // NotSupportedError may be a GATT/device or storage error, not absence of Web Bluetooth.
    return (operation ? operation + ": " : "") + (name ? name + ": " : "") + message;
  }

  function handleStorageError(error) {
    log("Chunk storage failed", friendlyError(error, "IndexedDB"));
    unsavedAudio = true;
    toast("Chunk storage failed. Stopping; use Settings to retry saving or export recovery audio.", "error");
    if (appState === "recording" || appState === "starting") stopRecording();
  }

  // Application state and UI

  function setAppState(nextState, message) {
    if (firmwareBusy) nextState = "updating";
    appState = nextState;
    document.body.dataset.state = nextState;
    if (typeof renderDeviceSetup === "function") renderDeviceSetup();

    ui.connectionBadge.className = "status-badge";
    ui.connectButton.disabled = false;
    ui.startButton.disabled = true;
    ui.stopButton.disabled = true;

    if (nextState === "updating") {
      ui.connectButton.disabled = true;
      ui.connectionText.textContent = "Firmware update";
      ui.connectButtonLabel.textContent = "Updating…";
      ui.recorderTitle.textContent = "Updating your pendant.";
      ui.recorderSubtitle.textContent = "Keep this app open until the update finishes.";
      ui.levelText.textContent = "Recording paused during update";
      return;
    }

    if (nextState === "unsupported") {
      ui.connectionBadge.classList.add("status-error");
      ui.connectionText.textContent = "Bluetooth unavailable";
      ui.connectButtonLabel.textContent = "Not supported";
      ui.connectButton.disabled = true;
      ui.recorderTitle.textContent = "Browser not supported.";
      ui.recorderSubtitle.textContent =
        message ||
        "Open this app in Android Chrome over HTTPS.";
      ui.levelText.textContent = "Web Bluetooth unavailable";
      return;
    }

    if (nextState === "disconnected") {
      ui.connectionBadge.classList.add("status-offline");
      if (recordingReconnectPending) {
        ui.connectionText.textContent = "Recording paused";
        ui.connectButtonLabel.textContent = "Reconnect";
        ui.stopButton.disabled = false;
        ui.recorderTitle.textContent = "Recording paused.";
        ui.recorderSubtitle.textContent =
          message ||
          "Connection was lost. Reconnect to continue the same recording, or Stop to save it.";
        ui.levelText.textContent = "Recording preserved";
        return;
      }
      ui.connectionText.textContent = "Not connected";
      ui.connectButtonLabel.textContent =
        needsDeviceSelection ? "Reselect pendant" : (bluetoothDevice ? "Reconnect" : "Connect pendant");
      ui.recorderTitle.textContent = "Ready when you are.";
      ui.recorderSubtitle.textContent =
        message ||
        "Connect to start recording.";
      ui.levelText.textContent = "Waiting for pendant";
      return;
    }

    if (nextState === "connecting") {
      ui.connectionBadge.classList.add("status-offline");
      ui.connectionText.textContent = "Connecting";
      ui.connectButtonLabel.textContent = "Connecting…";
      ui.connectButton.disabled = true;
      ui.recorderTitle.textContent = "Finding your pendant…";
      ui.recorderSubtitle.textContent =
        "Keep your pendant nearby.";
      ui.levelText.textContent = "Opening Bluetooth connection";
      return;
    }

    if (nextState === "idle") {
      ui.connectionBadge.classList.add("status-ready");
      ui.connectionText.textContent = "Connected";
      ui.connectButtonLabel.textContent = "Disconnect";
      ui.startButton.disabled = deviceStatus.error !== 0 || finalizing;
      ui.recorderTitle.textContent = "Ready to capture.";
      ui.recorderSubtitle.textContent =
        message ||
        "";
      ui.levelText.textContent = "Pendant ready";
      return;
    }

    if (nextState === "starting") {
      ui.connectionBadge.classList.add("status-ready");
      ui.connectionText.textContent = "Starting";
      ui.connectButtonLabel.textContent = "Disconnect";
      ui.connectButton.disabled = true;
      ui.stopButton.disabled = false;
      ui.recorderTitle.textContent = "Starting stream…";
      ui.recorderSubtitle.textContent =
        "";
      ui.levelText.textContent = "Waiting for first audio frame";
      return;
    }

    if (nextState === "recording") {
      ui.connectionBadge.classList.add("status-recording");
      ui.connectionText.textContent = "Recording";
      ui.connectButtonLabel.textContent = "Disconnect";
      ui.connectButton.disabled = true;
      ui.stopButton.disabled = false;
      ui.recorderTitle.textContent = "Capturing the moment.";
      ui.recorderSubtitle.textContent =
        "Keep this app open.";
      ui.levelText.textContent = "Recording";
      return;
    }

    if (nextState === "stopping" || nextState === "saving") {
      ui.connectionBadge.classList.add("status-ready");
      ui.connectionText.textContent = "Finishing";
      ui.connectButtonLabel.textContent = "Disconnect";
      ui.connectButton.disabled = true;
      ui.recorderTitle.textContent = "Finishing recording…";
      ui.recorderSubtitle.textContent =
        nextState === "saving"
          ? "Saving audio…"
          : "Finishing…";
      ui.levelText.textContent = "Finalising locally";
      return;
    }

    if (nextState === "error") {
      ui.connectionBadge.classList.add("status-error");
      ui.connectionText.textContent = "Needs attention";
      ui.connectButtonLabel.textContent =
        isGattConnected() ? "Disconnect" : "Reconnect";
      ui.recorderTitle.textContent = "Pendant needs attention.";
      ui.recorderSubtitle.textContent =
        message || "Check Diagnostics for details.";
      ui.levelText.textContent = message || "Transport error";
    }
  }

  function updateMetrics() {
    if (metricsTimer !== null) return;
    metricsTimer = window.setTimeout(function () {
      metricsTimer = null;
      renderMetrics();
    }, 200);
  }

  function renderMetrics() {
    ui.framesMetric.textContent =
      String(sessionStats.completeFrames);
    ui.framesDetail.textContent =
      sessionStats.incompleteFrames +
      " incomplete · " +
      sessionStats.missingFrames +
      " missing";

    if (deviceStatus.mtu) {
      ui.transportMetric.textContent =
        String(deviceStatus.mtu);
      ui.transportDetail.textContent =
        "MTU · " +
        deviceStatus.chunksPerFrame +
        " chunks/frame";
    } else {
      ui.transportMetric.textContent = "—";
      ui.transportDetail.textContent = "MTU / chunks";
    }

    if (sessionStats.completeFrames > 0) {
      ui.signalMetric.textContent =
        Math.round(lastDb) + " dB";
      ui.signalDetail.textContent =
        Math.round(currentRms * 100) + "% RMS";

      const totalIssues =
        sessionStats.incompleteFrames +
        sessionStats.missingFrames +
        sessionStats.invalidPackets;
      const denominator =
        sessionStats.completeFrames + totalIssues;
      const issueRate =
        denominator > 0 ? totalIssues / denominator : 0;

      if (issueRate === 0) {
        ui.qualityMetric.textContent = "Excellent";
      } else if (issueRate < 0.01) {
        ui.qualityMetric.textContent = "Good";
      } else if (issueRate < 0.05) {
        ui.qualityMetric.textContent = "Fair";
      } else {
        ui.qualityMetric.textContent = "Poor";
      }

      ui.qualityDetail.textContent =
        (issueRate * 100).toFixed(1) + "% issue rate";
    } else {
      ui.signalMetric.textContent = "—";
      ui.signalDetail.textContent = "No stream";
      ui.qualityMetric.textContent = "—";
      ui.qualityDetail.textContent = "Waiting";
    }
  }

  // BLE connection

  function isGattConnected() {
    return Boolean(
      bluetoothDevice &&
      bluetoothDevice.gatt &&
      bluetoothDevice.gatt.connected
    );
  }

  function attachBluetoothDevice(device) {
    stopAdvertisementWatch();
    if (bluetoothDevice) {
      bluetoothDevice.removeEventListener(
        "gattserverdisconnected",
        handleGattDisconnected
      );
    }

    bluetoothDevice = device;

    if (bluetoothDevice) {
      bluetoothDevice.addEventListener(
        "gattserverdisconnected",
        handleGattDisconnected
      );
    }
  }

  let lastGattDisconnectRequest = null;
  function disconnectGatt(reason, device = bluetoothDevice) {
    if (!device?.gatt) return;
    lastGattDisconnectRequest = { device, reason, at: Date.now() };
    log("App requested GATT disconnect", { reason, state: appState,
      visibility: document.visibilityState });
    device.gatt.disconnect();
  }

  const REMEMBERED_RECOVERY_INTERVAL_MS = 30000;
  let rememberedRecoveryTimer = null;
  let advertisementWatch = null;
  let reconnectNotBefore = 0;
  let lastAdvertisementRecoveryAt = 0;
  let reconnectMonitoringReady = false;
  let reconnectPageHidden = false;
  const advertisementUnavailable = new WeakSet();

  function reconnectRequested() {
    const guard = globalThis.SynapSleepStateGuard;
    if (guard?.locked || document.body?.dataset.intentionalSleep === "1") return guard?.reconnectOnWake === true;
    return autoReconnectEnabled();
  }

  function stopAdvertisementWatch() {
    const watch = advertisementWatch;
    advertisementWatch = null;
    if (!watch) return;
    watch.device.removeEventListener("advertisementreceived", watch.receive);
    watch.controller.abort();
  }

  function stopRememberedMonitoring() {
    if (rememberedRecoveryTimer !== null) clearTimeout(rememberedRecoveryTimer);
    rememberedRecoveryTimer = null;
    stopAdvertisementWatch();
  }

  function monitorAllowed() {
    return reconnectMonitoringReady && !reconnectPageHidden && reconnectRequested() && !manualDisconnect &&
      document.visibilityState !== "hidden" && window.isSecureContext && Boolean(navigator.bluetooth) && !isGattConnected();
  }

  function watchRememberedAdvertisements() {
    const device = bluetoothDevice;
    if (!monitorAllowed() || !device || connectInProgress || firmwareBusy || Date.now() < reconnectNotBefore ||
        typeof device.watchAdvertisements !== "function" || advertisementUnavailable.has(device)) return;
    if (advertisementWatch?.device === device) return;
    stopAdvertisementWatch();
    const controller = new AbortController();
    const watch = { device, controller, receive(event) {
      if (advertisementWatch !== watch || bluetoothDevice !== device || event.device !== device || !monitorAllowed() ||
          connectInProgress || Date.now() < reconnectNotBefore || Date.now() - lastAdvertisementRecoveryAt < 3000) return;
      lastAdvertisementRecoveryAt = Date.now();
      recoverRememberedConnection("pendant-advertising", true);
    } };
    advertisementWatch = watch;
    device.addEventListener("advertisementreceived", watch.receive);
    try {
      Promise.resolve(device.watchAdvertisements({ signal: controller.signal })).catch(unavailable);
    } catch (error) { unavailable(error); }
    function unavailable(error) {
      if (advertisementWatch !== watch) return;
      stopAdvertisementWatch();
      advertisementUnavailable.add(device);
      log("Advertisement watching unavailable; using periodic recovery", friendlyError(error));
    }
  }

  function syncRememberedMonitoring() {
    if (!monitorAllowed() || (!bluetoothDevice && typeof navigator.bluetooth.getDevices !== "function")) {
      stopRememberedMonitoring(); return;
    }
    watchRememberedAdvertisements();
    if (rememberedRecoveryTimer !== null) return;
    rememberedRecoveryTimer = window.setTimeout(async function () {
      rememberedRecoveryTimer = null;
      if (!monitorAllowed()) { stopRememberedMonitoring(); return; }
      try { await recoverRememberedConnection("waiting-for-pendant", false); }
      finally { syncRememberedMonitoring(); }
    }, reconnectNotBefore > Date.now() ? reconnectNotBefore - Date.now() : REMEMBERED_RECOVERY_INTERVAL_MS);
  }

  async function restoreKnownPendant() {
    if (
      !navigator.bluetooth ||
      typeof navigator.bluetooth.getDevices !== "function"
    ) {
      log("Reload reconnect unavailable: browser cannot list permitted devices. Tap Connect pendant.");
      setReconnectCapability("Browser cannot restore Bluetooth permission after reload.", "This browser needs a tap on Connect after each reload.");
      return false;
    }

    try {
      const restoreEpoch = connectionEpoch;
      const previousDevice = bluetoothDevice;
      const devices = await withTimeout(navigator.bluetooth.getDevices(), 5000, "Restore Bluetooth permission");
      // A user may select another pendant while permission enumeration is pending.
      if (connectInProgress || manualDisconnect || restoreEpoch !== connectionEpoch || previousDevice !== bluetoothDevice) return false;
      let rememberedId = null;
      try { rememberedId = localStorage.getItem("dk-pendant-device-id"); }
      catch (_) { /* Storage restrictions must not block manual Bluetooth use. */ }
      const namedPendants = devices.filter(function (device) {
        return device.name === "synap" || device.name === "dk-pendant";
      });
      const pendant = rememberedId
        ? devices.find(function (device) { return device.id === rememberedId; })
        : (namedPendants.length === 1 ? namedPendants[0] : null);

      if (!pendant) {
        log("No unambiguous previously permitted pendant. Tap Connect pendant to select one.");
        setReconnectCapability("No unambiguous remembered pendant permission.", "Tap Connect once to select your pendant.");
        return false;
      }

      attachBluetoothDevice(pendant);
      setReconnectCapability("Remembered pendant available. Automatic reconnect is supported here while the app is open; Bluetooth must be on and the pendant advertising nearby.");
      log("Previously authorised pendant restored", {
        name: pendant.name,
        id: pendant.id
      });
      return true;
    } catch (error) {
      log("Known-device restore unavailable", friendlyError(error));
      setReconnectCapability("Could not restore pendant permission: " + friendlyError(error), "Could not restore your pendant. Tap Connect to select it.");
      return false;
    }
  }

  function setReconnectCapability(message, hint = "") {
    log("Reconnect", message);
    const note = document.getElementById("reconnectStatus");
    if (note) { note.textContent = hint; note.hidden = !hint || isGattConnected(); }
  }

  function autoReconnectEnabled() {
    if (document.body?.dataset.intentionalSleep === "1") return false;
    try { return localStorage.getItem("dk-pendant-auto-reconnect") !== "off"; }
    catch (_) { return true; }
  }

  function clearRecordingReconnectDeadline() {
    if (recordingReconnectDeadline !== null) {
      clearTimeout(recordingReconnectDeadline);
      recordingReconnectDeadline = null;
    }
  }

  function clearRecordingReconnectState() {
    clearRecordingReconnectDeadline();
    recordingReconnectPending = false;
    recordingDisconnectedAt = 0;
    recordingResumeDeviceId = null;
    recordingResumeBluetoothId = null;
    recordingWasConfirmedBeforeDisconnect = false;
    document.body.dataset.recordingInterrupted = "false";
  }

  function scheduleRecordingReconnectExpiry(sessionId) {
    clearRecordingReconnectDeadline();
    recordingReconnectDeadline = window.setTimeout(function () {
      recordingReconnectDeadline = null;
      if (!recordingReconnectPending || !isCurrentSession(sessionId)) return;
      log("Recording reconnect window expired", { session: sessionId });
      toast("Could not restore the pendant connection. Saving the recording already captured.", "error");
      finalizeRecording("connection-lost-timeout", sessionId);
    }, RECORDING_RECONNECT_GRACE_MS);
  }

  function markRecordingInterrupted(sessionId) {
    if (!recordingReconnectPending) {
      recordingReconnectPending = true;
      recordingDisconnectedAt = performance.now();
      recordingResumeDeviceId = deviceAssociation?.deviceId || null;
      recordingResumeBluetoothId = bluetoothDevice?.id || null;
      recordingWasConfirmedBeforeDisconnect = recordingConfirmed;
      document.body.dataset.recordingInterrupted = "true";
      scheduleRecordingReconnectExpiry(sessionId);
      log("Recording transport paused; journal kept open", {
        session: sessionId,
        recordingId: currentRecordingId,
        deviceId: recordingResumeDeviceId,
        bluetoothId: recordingResumeBluetoothId
      });
    }
  }

  async function prepareRecordingTransportResume() {
    if (!recordingReconnectPending || !isCurrentSession(recordingSessionId)) return false;
    if (openingCapture && !currentRecordingId) {
      currentRecordingId = await openingCapture;
      openingCapture = null;
    }
    if (!currentRecordingId) throw new Error("Interrupted recording journal is unavailable.");
    cleanupStaleFrames(true);
    pendingFrames.clear();
    completedSequences.clear();
    lastObservedSequence = null;
    lastFrameCleanupAt = 0;
    globalThis.SynapCaptureStability?.beginTransportEpoch(currentRecordingId, 0);
    setAppState("starting");
    return true;
  }

  function completeRecordingTransportResume(source) {
    if (!recordingReconnectPending) return;
    const now = performance.now();
    if (recordingWasConfirmedBeforeDisconnect && recordingStartedAt && recordingDisconnectedAt) {
      recordingStartedAt += Math.max(0, now - recordingDisconnectedAt);
    }
    clearRecordingReconnectState();
    reconnectAttempts = 0;
    clearStartTimeout();
    lastAudioAt = now;
    foregroundAt = now;
    startTimer();
    setAppState("recording");
    if (settings.wakeLock) acquireWakeLock();
    log("Recording resumed in existing journal", {
      source: source,
      session: recordingSessionId,
      recordingId: currentRecordingId
    });
  }

  async function recoverRememberedConnection(reason, force) {
    if (firmwareBusy) return;
    if (reason === "waiting-for-pendant" && reconnectTimer) return;
    const activeJournalBlocksRecovery = Boolean(currentRecordingId) && !recordingReconnectPending;
    if (!reconnectRequested() || manualDisconnect || connectInProgress || reloadRecoveryRunning ||
        reconnectPageHidden || Date.now() < reconnectNotBefore ||
        finalizing || activeJournalBlocksRecovery || isGattConnected() || document.visibilityState === "hidden") return;
    if (!window.isSecureContext || !navigator.bluetooth) {
      setReconnectCapability("Web Bluetooth is unavailable here. Installing the PWA does not add Bluetooth support to an unsupported browser.");
      return;
    }
    if (!force && Date.now() - lastReloadRecoveryAt < 30000 && !recordingReconnectPending) return;
    lastReloadRecoveryAt = Date.now();reloadRecoveryRunning = true;
    try {
      // Never open the chooser without a user gesture, and never select by an ambiguous name.
      if (!bluetoothDevice && !await restoreKnownPendant()) return;
      const journalStillBlocksRecovery = Boolean(currentRecordingId) && !recordingReconnectPending;
      if (!reconnectRequested() || manualDisconnect || connectInProgress || isGattConnected() ||
          reconnectPageHidden || Date.now() < reconnectNotBefore ||
          finalizing || journalStillBlocksRecovery || document.visibilityState === "hidden") return;
      clearReconnectTimer(false);
      log("Remembered-device recovery", {reason, recordingResume: recordingReconnectPending});
      setReconnectCapability("Trying remembered pendant", globalThis.SynapSleepStateGuard?.locked
        ? "Waiting for your pendant to wake." : "Looking for your saved pendant…");
      await connectPendant({ silent: true, autoReconnect: true, recoveryAttempt: true });
    } finally { reloadRecoveryRunning = false; syncRememberedMonitoring(); }
  }

  function bindReconnectRecovery() {
    const preference = document.getElementById("autoReconnectInput");
    preference.checked = reconnectRequested();
    reconnectMonitoringReady = true;
    if (!preference.checked) setReconnectCapability("Automatic reconnect is off. Tap Connect pendant to connect manually.");
    preference.addEventListener("change", function () {
      try {
        const guard = globalThis.SynapSleepStateGuard;
        if (guard?.setReconnectPreference) guard.setReconnectPreference(preference.checked);
        else localStorage.setItem("dk-pendant-auto-reconnect", preference.checked ? "on" : "off");
      }
      catch (_) { preference.checked = reconnectRequested();toast("This browser could not save the reconnect preference.", "error"); }
      if (!preference.checked) {
        clearReconnectTimer(true);
        stopRememberedMonitoring();
        if (connectInProgress && reloadRecoveryRunning) disconnectGatt("Automatic reconnect turned off");
        setReconnectCapability(recordingReconnectPending
          ? "Automatic reconnect is off. Tap Reconnect to continue the same recording, or Stop to save it."
          : "Automatic reconnect is off. An existing connection is not disconnected.");
      }
      else { manualDisconnect = false;recoverRememberedConnection("preference-enabled", true); syncRememberedMonitoring(); }
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") { clearReconnectTimer(false); stopRememberedMonitoring(); return; }
      reconnectPageHidden = false;
      syncRememberedMonitoring();
      foregroundAt = performance.now();
      window.dispatchEvent(new CustomEvent('synap-recording-foreground'));
      recoverRememberedConnection("foreground", true);
      // Audio notifications are the liveness signal during capture. Foreground
      // transitions must not add a status read to a working recording transport.
      if (isGattConnected() && !connectInProgress && !firmwareBusy && !finalizing && !recordingConfirmed) {
        readControlStatus().then(ok=>{if(ok) log("Foreground pendant status resynchronised");});
      }
    });
    window.addEventListener("pageshow", function (event) {
      reconnectPageHidden = false; syncRememberedMonitoring();
      if (event.persisted) recoverRememberedConnection("page-restored", true);
    });
    navigator.bluetooth?.addEventListener?.("availabilitychanged", function (event) {
      if (event.value) { advertisementUnavailable.delete(bluetoothDevice); recoverRememberedConnection("bluetooth-available", true); syncRememberedMonitoring(); }
    });
    window.addEventListener("pagehide", function () {
      reconnectPageHidden = true; clearReconnectTimer(false); stopRememberedMonitoring();
    });
    window.addEventListener("synap-intentional-sleep", function (event) {
      if (event.detail?.active) {
        reconnectNotBefore = Date.now() + 5000;
        clearReconnectTimer(true); stopRememberedMonitoring();
        setReconnectCapability("Pendant is entering sleep", "Waiting for your pendant to wake.");
      }
      syncRememberedMonitoring();
    });
    syncRememberedMonitoring();
  }

  function clearReconnectTimer(resetAttempts) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (resetAttempts) reconnectAttempts = 0;
  }

  function scheduleAutoReconnect() {
    if (
      manualDisconnect ||
      !autoReconnectEnabled() ||
      !bluetoothDevice ||
      (reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS && !recordingReconnectPending) ||
      reconnectTimer
    ) {
      return;
    }

    const attempt = reconnectAttempts + 1;
    const wait = AUTO_RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, MAX_AUTO_RECONNECT_ATTEMPTS - 1)];

    log("Automatic reconnect scheduled", {
      attempt: attempt,
      delayMs: wait,
      recordingResume: recordingReconnectPending
    });

    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      if (document.visibilityState === "hidden" || manualDisconnect || !autoReconnectEnabled() || firmwareBusy || isGattConnected()) return;
      reconnectAttempts = attempt;
      connectPendant({ silent: true, autoReconnect: true, recoveryAttempt: true });
    }, wait);
  }

  async function connectPendant(options) {
    const settings = options || {};
    const silent = Boolean(settings.silent);
    const autoReconnect = Boolean(settings.autoReconnect);
    const resumingRecording = recordingReconnectPending &&
      isCurrentSession(recordingSessionId) && Boolean(currentRecordingId || openingCapture);
    const resumingSessionId = resumingRecording ? recordingSessionId : null;

    if (connectInProgress || finalizing) return;
    if (autoReconnect && !bluetoothDevice) {
      setAppState("disconnected", "Select a pendant once to grant Bluetooth permission.");
      return; // Never invoke a permission chooser from a lifecycle event or timer.
    }

    if (!navigator.bluetooth) {
      setAppState(
        "unsupported",
        "Use Android Chrome over HTTPS. iPhone Web Bluetooth is not available."
      );
      return;
    }

    clearReconnectTimer(!autoReconnect && !resumingRecording);
    connectInProgress = true;
    stopRememberedMonitoring();
    if (globalThis.document?.body) document.body.dataset.autoReconnecting = String(Boolean(settings.recoveryAttempt));
    manualDisconnect = false;
    setAppState("connecting");

    try {
      // A failed restored handle must not trap the user in the same retry loop.
      // Open the chooser directly in this click's activation, never after an await.
      if (!autoReconnect && needsDeviceSelection) {
        cleanupCharacteristics();
        attachBluetoothDevice(null);
      }
      if (!bluetoothDevice) {
        const selectedDevice = await navigator.bluetooth.requestDevice({
          filters: [
            { services: [SERVICE_UUID] }
          ],
          optionalServices: [SERVICE_UUID]
        });

        attachBluetoothDevice(selectedDevice);

        log("BLE device selected", {
          name: bluetoothDevice.name || "unnamed",
          id: bluetoothDevice.id
        });
      }

      if (resumingRecording && recordingResumeBluetoothId &&
          bluetoothDevice.id !== recordingResumeBluetoothId) {
        throw new Error("Reconnect the same pendant to continue this recording.");
      }

      const epoch = connectionEpoch;
      const connectingDevice = bluetoothDevice;
      lastGattDisconnectRequest = null;
      try {
        gattServer = await withTimeout(connectingDevice.gatt.connect(), 12000, "Connection");
      } catch (error) {
        // disconnect() also cancels an outstanding connect, even while connected is false.
        disconnectGatt("Connection attempt failed: " + friendlyError(error), connectingDevice);
        throw error;
      }
      function assertConnection() {
        // Visibility gates new attempts. Native Bluetooth UI can hide the page
        // during a successful handshake; it must not cancel an existing one.
        if (settings.recoveryAttempt && (!reconnectRequested() || manualDisconnect)) {
          throw new Error("Automatic reconnect was cancelled.");
        }
        if (epoch !== connectionEpoch || !isGattConnected()) {
          throw new Error("Connection changed during discovery.");
        }
        if (resumingSessionId !== null && (finalizing || !isCurrentSession(resumingSessionId))) {
          throw new Error("Interrupted recording was already saved.");
        }
      }
      assertConnection();
      log("GATT connected");

      const service =
        await queueGattOperation(function () { return gattServer.getPrimaryService(SERVICE_UUID); });
      assertConnection();
      log("Pendant service resolved");
      let connectedDeviceId = null;
      let identityMessage = "This firmware has no permanent device ID. Recording is available; install identity-enabled firmware to remember this device.";
      try {
        connectedDeviceId = await globalThis.SynapDevices.read(service, queueGattOperation, assertConnection);
      } catch (error) {
        assertConnection();
        identityMessage = "Device ID could not be read. Reconnect to retry setup. Recording is still available.";
        log("Device identity unavailable", friendlyError(error));
      }
      assertConnection();
      if (resumingRecording && recordingResumeDeviceId && connectedDeviceId &&
          connectedDeviceId !== recordingResumeDeviceId) {
        throw new Error("Pendant identity changed. The interrupted recording was not attached to another device.");
      }

      audioCharacteristic =
        await queueGattOperation(function () { return service.getCharacteristic(AUDIO_CHAR_UUID); });
      assertConnection();
      controlCharacteristic =
        await queueGattOperation(function () { return service.getCharacteristic(CONTROL_CHAR_UUID); });
      assertConnection();
      log("Audio and control characteristics resolved");

      audioCharacteristic.addEventListener(
        "characteristicvaluechanged",
        handleAudioNotification
      );
      controlCharacteristic.addEventListener(
        "characteristicvaluechanged",
        handleStatusNotification
      );

      if (resumingRecording) await prepareRecordingTransportResume();

      await queueGattOperation(function () {
        return controlCharacteristic.startNotifications();
      });
      log("Control notifications enabled");

      await queueGattOperation(function () {
        return audioCharacteristic.startNotifications();
      });
      log("Audio notifications enabled");

      // Let the CCCD subscription reach the peripheral before START is possible.
      await delay(180);
      await writeCommand(CMD_GET_STATUS);
      await delay(120);
      await readControlStatus();

      // Android negotiates MTU asynchronously. Give it a bounded settling window.
      for (let retry = 0; deviceStatus.error === 1 && retry < 3; retry += 1) {
        await delay(350);
        await writeCommand(CMD_GET_STATUS);
        await delay(120);
        await readControlStatus();
      }
      assertConnection();

      if (resumingRecording && deviceStatus.state === DEVICE_STATE.CONNECTED_IDLE &&
          deviceStatus.error === 0) {
        log("Interrupted recording found pendant idle; restarting stream in same journal");
        await writeCommand(CMD_START, assertConnection);
        await delay(140);
        await readControlStatus();
        assertConnection();
        if (deviceStatus.state !== DEVICE_STATE.STREAMING || deviceStatus.error !== 0) {
          throw new Error("Pendant did not resume the interrupted recording stream.");
        }
      }

      // A browser refresh can leave the peripheral streaming while the new
      // page has no matching recording session. Normalize it to idle before
      // exposing Start, so the LED and UI cannot disagree. An in-page transport
      // recovery is different: it owns an existing journal and keeps streaming.
      if (!resumingRecording && deviceStatus.state === DEVICE_STATE.STREAMING) {
        log("Recovered orphaned stream; requesting clean stop");
        await writeCommand(CMD_STOP);
        await delay(180);
        await readControlStatus();
      }

      if (resumingRecording &&
          deviceStatus.state === DEVICE_STATE.STREAMING &&
          deviceStatus.error === 0) {
        assertConnection();
        rememberDeviceAssociation(connectedDeviceId, connectingDevice, identityMessage);
        reconnectAttempts = 0;
        needsDeviceSelection = false;
        try { localStorage.setItem("dk-pendant-device-id", bluetoothDevice.id); }
        catch (_) { log("Device preference could not be saved; current recording remains attached to this connection."); }
        if (recordingReconnectPending) completeRecordingTransportResume("reconnect");
        setReconnectCapability("Pendant reconnected. Future brief connection losses will continue this same recording while the app stays open.");
        if (!silent) toast("Recording resumed");
      } else if (
        deviceStatus.state === DEVICE_STATE.CONNECTED_IDLE &&
        deviceStatus.error === 0
      ) {
        // Persist only after identity read and idle acknowledgement belong to the same connection.
        assertConnection();
        rememberDeviceAssociation(connectedDeviceId, connectingDevice, identityMessage);
        reconnectAttempts = 0;
        needsDeviceSelection = false;
        try { localStorage.setItem("dk-pendant-device-id", bluetoothDevice.id); }
        catch (_) { log("Device preference could not be saved; name-based reload recovery remains available."); }
        setReconnectCapability(typeof navigator.bluetooth.getDevices === "function"
          ? "Pendant remembered. Automatic reconnect can restore this permission after reload; a brief in-app connection loss resumes the same recording."
          : "Connected for this page session. This browser needs device selection again after reload because getDevices() is unavailable.");
        setAppState("idle");
        if (!silent) toast("Pendant connected");
      } else if (deviceStatus.state === DEVICE_STATE.STREAMING) {
        throw new Error(
          "Pendant is still streaming without a matching recording session. Reconnect it."
        );
      } else if (deviceStatus.state !== DEVICE_STATE.ERROR) {
        throw new Error("No valid idle acknowledgement. Check that both firmware and PWA are updated.");
      }
    } catch (error) {
      const message = friendlyError(error);
      log("Connection failed", message);
      needsDeviceSelection = Boolean(bluetoothDevice) || needsDeviceSelection;
      if (isGattConnected()) disconnectGatt("Connection setup failed: " + message);
      cleanupCharacteristics();
      setAppState("disconnected", recordingReconnectPending
        ? "Connection is still unavailable. The current recording remains preserved for reconnect."
        : message);

      if (!silent && error && error.name !== "NotFoundError") {
        toast(message, "error");
      }

      if (autoReconnect && !manualDisconnect) {
        scheduleAutoReconnect();
      }
    } finally {
      connectInProgress = false;
      if (globalThis.document?.body) delete document.body.dataset.autoReconnecting;
      if (isGattConnected()) setReconnectCapability("Pendant connection ready");
      syncRememberedMonitoring();
      if (isGattConnected()) checkFirmwareRelease?.();
    }
  }

  async function disconnectPendant() {
    if (firmwareBusy) return;
    manualDisconnect = true;
    clearReconnectTimer(true);
    stopRememberedMonitoring();

    if (
      appState === "recording" ||
      appState === "starting" ||
      appState === "stopping"
    ) {
      await stopRecording();
      await delay(250);
    }

    if (isGattConnected()) {
      disconnectGatt("User disconnected pendant");
    } else {
      cleanupCharacteristics();
      setAppState("disconnected");
    }
  }

  async function handleGattDisconnected(event) {
    if (event && event.target !== bluetoothDevice) return;
    const request = lastGattDisconnectRequest;
    const requestedByApp = request?.device === bluetoothDevice && Date.now() - request.at < 15000;
    lastGattDisconnectRequest = null;
    log("GATT disconnected", {
      origin: requestedByApp ? "app" : "browser-or-peripheral",
      reason: requestedByApp ? request.reason : "No app disconnect request",
      manual: manualDisconnect,
      state: appState,
      recordingId: currentRecordingId,
      visibility: document.visibilityState,
      lastAudioMs: lastAudioAt ? Math.round(performance.now() - lastAudioAt) : null
    });

    const disconnectedSessionId = recordingSessionId;
    const hadRecording =
      recordingConfirmed ||
      completedPcmFrames.length > 0 || Boolean(currentRecordingId) || Boolean(openingCapture);
    const resumableRecording = !manualDisconnect && hadRecording &&
      isCurrentSession(disconnectedSessionId) &&
      (appState === "recording" || appState === "starting" || recordingReconnectPending);

    if (resumableRecording) {
      markRecordingInterrupted(disconnectedSessionId);
      cleanupStaleFrames(true);
    }

    cleanupCharacteristics();
    syncRememberedMonitoring();

    // The connection attempt owns its failure UI and retry scheduling when no
    // recording journal is at risk.
    if (connectInProgress && !hadRecording) return;

    if (resumableRecording) {
      setAppState("disconnected", "Connection was lost. Reconnecting to continue the same recording.");
      toast("Pendant connection lost · recording preserved", "error");
      scheduleAutoReconnect();
      return;
    }

    if (hadRecording) {
      await finalizeRecording(
        "connection-lost",
        disconnectedSessionId
      );
    }

    setAppState(
      "disconnected",
      manualDisconnect
        ? "Pendant disconnected."
        : "Connection was lost. Tap Reconnect to continue."
    );

    if (!manualDisconnect) {
      toast("Pendant connection lost", "error");
      scheduleAutoReconnect();
    }
  }

  function cleanupCharacteristics() {
    globalThis.SynapDevices?.clearService?.();
    deviceAssociation = null;
    deviceIdentityMessage = "Not connected";
    firmwareUpdater?.reset();
    connectionEpoch += 1;
    gattQueue = Promise.resolve();
    clearStartTimeout();
    clearFinalizeTimer();
    if (audioCharacteristic) {
      audioCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        handleAudioNotification
      );
    }

    if (controlCharacteristic) {
      controlCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        handleStatusNotification
      );
    }

    audioCharacteristic = null;
    controlCharacteristic = null;
    gattServer = null;

    deviceStatus = {
      state: DEVICE_STATE.DISCONNECTED,
      error: 0,
      mtu: 0,
      attCapacity: 0,
      chunksPerFrame: 0,
      headerBytes: AUDIO_HEADER_BYTES,
      sampleRate: DEFAULT_SAMPLE_RATE,
      samplesPerFrame: 800,
      payloadBytes: 0
    };
    document.body.dataset.deviceState = "0";

    stopTimer();
    releaseWakeLock();
  }

  function withTimeout(promise, milliseconds, label) {
    let timeout;
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        timeout = window.setTimeout(function () {
          const error = new Error(label + " timed out");
          error.name = "TimeoutError";
          reject(error);
        }, milliseconds);
      })
    ]).finally(function () { clearTimeout(timeout); });
  }

  function queueGattOperation(action, label = "Bluetooth operation") {
    const epoch = connectionEpoch;
    const device = bluetoothDevice;
    let expired = false;
    let started = false;
    const operation = gattQueue.then(async function () {
      if (expired) return; // A timed-out queued command must never run later.
      if (epoch !== connectionEpoch || device !== bluetoothDevice || !isGattConnected()) {
        throw new Error("Bluetooth connection changed.");
      }
      started = true;
      const result = await action();
      if (epoch !== connectionEpoch || device !== bluetoothDevice || !isGattConnected()) {
        throw new Error("Bluetooth connection changed.");
      }
      return result;
    });
    // The native promise owns the queue even after its caller times out. A
    // Promise.race timeout does not cancel an ATT request in the browser.
    gattQueue = operation.catch(function () {});
    return withTimeout(operation, COMMAND_TIMEOUT_MS, label).catch(function (error) {
      expired = true;
      log("GATT operation failed", { operation: label, name: error.name, message: error.message,
        connected: isGattConnected(), queued: !started, session: recordingSessionId });
      if (error.name === "TimeoutError" && epoch === connectionEpoch &&
          device === bluetoothDevice && isGattConnected()) {
        const captureAlive = recordingConfirmed && appState === "recording" &&
          (document.visibilityState === "hidden" || performance.now() - lastAudioAt < AUDIO_STALL_TIMEOUT_MS);
        if (captureAlive) {
          log("GATT reply delayed; preserving recording transport", { operation: label });
        } else if (started) {
          disconnectGatt("GATT timeout: " + label, device);
        }
      }
      throw error;
    });
  }

  async function writeCommand(command, beforeWrite) {
    const characteristic = controlCharacteristic;
    if (!characteristic || !isGattConnected()) {
      throw new Error("Pendant control characteristic is unavailable.");
    }
    const value = new Uint8Array([command, PROTOCOL_VERSION]);
    await queueGattOperation(async function () {
      beforeWrite?.();
      const properties = characteristic.properties;
      if (properties.write && typeof characteristic.writeValueWithResponse === "function") {
        try { return await characteristic.writeValueWithResponse(value); }
        catch (error) {
          if (error.name !== "NotSupportedError" || !properties.writeWithoutResponse ||
              typeof characteristic.writeValueWithoutResponse !== "function") throw error;
          log("Write-with-response rejected; using advertised write-without-response", {
            command, name: error.name, message: error.message
          });
          // START/STOP/GET_STATUS are idempotent. Status, not the write result, is the ACK.
          return characteristic.writeValueWithoutResponse(value);
        }
      }
      if (properties.writeWithoutResponse &&
          typeof characteristic.writeValueWithoutResponse === "function") {
        return characteristic.writeValueWithoutResponse(value);
      }
      return characteristic.writeValue(value);
    }, "Control command 0x" + command.toString(16));
    log("Control command sent", { command, protocol: PROTOCOL_VERSION });
  }

  async function readControlStatus() {
    const characteristic = controlCharacteristic;
    const epoch = connectionEpoch;
    if (!characteristic || !isGattConnected()) return false;
    try {
      const value = await queueGattOperation(function () {
        return characteristic.readValue();
      });
      if (epoch !== connectionEpoch) return false;
      return parseStatusValue(value, "read");
    } catch (error) {
      log("Control status read failed", friendlyError(error));
      return false;
    }
  }

  function handleStatusNotification(event) {
    parseStatusValue(event.target.value, "notification");
  }

  function parseStatusValue(value, source) {
    if (!value || value.byteLength !== 16) {
      log("Ignored short status value", {
        source: source,
        length: value ? value.byteLength : 0
      });
      return false;
    }

    if (value.getUint8(0) !== STATUS_MAGIC) {
      log("Ignored non-status control value", {
        source: source,
        firstByte: value.getUint8(0)
      });
      return false;
    }

    const version = value.getUint8(1);

    if (version !== PROTOCOL_VERSION) {
      const message =
        "Protocol mismatch: PWA " +
        PROTOCOL_VERSION +
        ", pendant " +
        version;
      log(message);
      setAppState("error", message);
      return false;
    }

    const receivedStatus = {
      state: value.getUint8(2),
      error: value.getUint8(3),
      mtu: value.getUint16(4, true),
      attCapacity: value.getUint16(6, true),
      chunksPerFrame: value.getUint8(8),
      headerBytes: value.getUint8(9),
      sampleRate: value.getUint16(10, true),
      samplesPerFrame: value.getUint16(12, true),
      payloadBytes: value.getUint16(14, true)
    };

    if (receivedStatus.state > 3 || receivedStatus.headerBytes !== AUDIO_HEADER_BYTES ||
        receivedStatus.sampleRate !== DEFAULT_SAMPLE_RATE || receivedStatus.samplesPerFrame !== 800) {
      log("Rejected incompatible status layout", receivedStatus);
      return false;
    }
    if (receivedStatus.state === DEVICE_STATE.STREAMING &&
        (receivedStatus.mtu < MIN_STREAM_MTU || receivedStatus.chunksPerFrame < MIN_CHUNKS_PER_FRAME ||
         receivedStatus.chunksPerFrame > MAX_CHUNKS_PER_FRAME || receivedStatus.payloadBytes < 1 ||
         receivedStatus.payloadBytes > MAX_AUDIO_PAYLOAD_BYTES ||
         receivedStatus.payloadBytes + AUDIO_HEADER_BYTES > receivedStatus.attCapacity)) {
      log("Rejected invalid streaming transport", receivedStatus);
      return false;
    }
    deviceStatus = receivedStatus;
    document.body.dataset.deviceState = String(deviceStatus.state);

    log("Pendant status received", {
      source: source,
      state: deviceStatus.state,
      error: deviceStatus.error,
      mtu: deviceStatus.mtu,
      attCapacity: deviceStatus.attCapacity,
      chunks: deviceStatus.chunksPerFrame,
      payload: deviceStatus.payloadBytes,
      sampleRate: deviceStatus.sampleRate
    });

    updateMetrics();

    if (
      deviceStatus.state === DEVICE_STATE.ERROR ||
      deviceStatus.error !== 0
    ) {
      const message =
        ERROR_TEXT[deviceStatus.error] ||
        "Unknown pendant error " + deviceStatus.error;

      clearStartTimeout();
      log("Pendant reported error", message);
      if (recordingConfirmed || appState === "starting" || appState === "stopping") {
        scheduleFinalize(0, "device-error", recordingSessionId);
      }
      setAppState("error", message);
      toast(message, "error");
      return true;
    }

    if (deviceStatus.state === DEVICE_STATE.STREAMING) {
      confirmRecordingStarted("status");
      return true;
    }

    if (deviceStatus.state === DEVICE_STATE.CONNECTED_IDLE) {
      if (appState === "stopping") {
        scheduleFinalize(140, "normal");
      } else if (appState === "recording") {
        scheduleFinalize(0, "peripheral-stopped");
      } else if (
        appState === "idle" && !finalizing
      ) {
        setAppState("idle");
      }
    }

    return true;
  }

  // Recording lifecycle

  function clearFinalizeTimer() {
    if (finalizeTimeout !== null) {
      clearTimeout(finalizeTimeout);
      finalizeTimeout = null;
    }
  }

  function isCurrentSession(id) {
    return id === recordingSessionId && id !== finalizedSessionId;
  }

  async function startRecording() {
    if (firmwareBusy) return;
    if (globalThis.SynapDesktopCapture?.state?.().active) {
      toast("Stop the online meeting capture before starting the pendant.", "error");
      return;
    }
    if (appState !== "idle" || finalizing || !isGattConnected()) return;
    if (journal && unsavedAudio) {
      toast("Resolve the pending local save in Settings before starting another take.", "error");return;
    }
    if (unsavedAudio && !window.confirm("Unsaved audio is still in memory. Download it in Settings first. Discard it and start a new recording?")) return;
    unsavedAudio = false;
    clearRecordingReconnectState();
    clearFinalizeTimer();
    clearStartTimeout();
    const sessionId = ++recordingSessionId;
    resetCollector();
    setAppState("starting");

    try {
      if (journal) {
        processor?.pause();
        if (!persistenceRequested && navigator.storage?.persist) {
          persistenceRequested=true;
          navigator.storage.persist().then(granted=>log("Persistent storage request",{granted}))
            .catch(error=>log("Persistent storage request failed",friendlyError(error,"Storage")));
        }
        openingCapture = journal.begin(defaultRecordingName(new Date()), deviceAssociation);
        currentRecordingId = await openingCapture;
        openingCapture = null;
        if (!isCurrentSession(sessionId) || appState !== "starting") return;
      }
      if (settings.wakeLock) await acquireWakeLock();
      if (!isCurrentSession(sessionId) || appState !== "starting") return;
      // Subscriptions already belong to this connection. Do not reopen GATT
      // subscriptions on every take or race a cancellation with a late START.
      startTimeout = window.setTimeout(async function () {
        if (!isCurrentSession(sessionId) || appState !== "starting") return;
        await readControlStatus();
        if (!isCurrentSession(sessionId) || appState !== "starting") return;
        toast("Start was not acknowledged. Stopping safely.", "error");
        await stopRecording();
      }, START_TIMEOUT_MS);
      await writeCommand(CMD_START);
      await delay(140);
      if (isCurrentSession(sessionId) && appState === "starting") {
        await readControlStatus();
      }
    } catch (error) {
      if (!isCurrentSession(sessionId)) return;
      log("Start failed", friendlyError(error));
      toast(friendlyError(error), "error");
      if (appState === "starting" || appState === "recording") {
        await stopRecording();
      }
    }
  }

  function confirmRecordingStarted(source) {
    if (appState !== "starting" && appState !== "recording") return;
    const firstConfirmation = !recordingConfirmed;
    if (firstConfirmation) {
      recordingConfirmed = true;
      recordingStartedAt = performance.now();
      foregroundAt = recordingStartedAt;
      lastAudioAt = recordingStartedAt;
      clearStartTimeout();
    }
    if (recordingReconnectPending) {
      completeRecordingTransportResume(source);
      return;
    }
    if (firstConfirmation) {
      startTimer();
      setAppState("recording");
      log("Recording confirmed", { source: source, session: recordingSessionId });
    }
  }

  async function stopRecording() {
    if (recordingReconnectPending && appState === "disconnected") {
      const sessionId = recordingSessionId;
      clearReconnectTimer(true);
      await finalizeRecording("connection-lost-user-stop", sessionId);
      return;
    }
    if (appState !== "recording" && appState !== "starting") return;
    const sessionId = recordingSessionId;
    setAppState("stopping");
    clearStartTimeout();

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!isCurrentSession(sessionId) || appState !== "stopping") return;
        if (!isGattConnected()) break;
        await writeCommand(CMD_STOP);
        await delay(150);
        if (!isCurrentSession(sessionId) || appState !== "stopping") return;
        await readControlStatus();
        if (!isCurrentSession(sessionId) || appState !== "stopping") return;
        if (deviceStatus.state === DEVICE_STATE.CONNECTED_IDLE &&
            deviceStatus.error === 0) {
          scheduleFinalize(100, "normal", sessionId);
          return;
        }
        log("Stop not yet acknowledged; retrying", { attempt: attempt + 1 });
      }
      if (!isCurrentSession(sessionId)) return;
      log("Stop unconfirmed; disconnecting to stop the peripheral");
      toast("Stop was not confirmed. Disconnected safely; saving received audio.", "error");
    } catch (error) {
      if (!isCurrentSession(sessionId)) return;
      log("Stop failed; disconnecting safely", friendlyError(error));
    }
    // Never display Ready while the pendant might still be streaming.
    if (isGattConnected()) disconnectGatt("Recording stop was not acknowledged");
    await finalizeRecording("stop-unconfirmed", sessionId);
  }

  function scheduleFinalize(delayMs, reason, sessionId = recordingSessionId) {
    if (!isCurrentSession(sessionId) || finalizing) return;
    clearFinalizeTimer();
    finalizeTimeout = window.setTimeout(function () {
      finalizeTimeout = null;
      if (isCurrentSession(sessionId)) finalizeRecording(reason, sessionId);
    }, delayMs);
  }

  async function finalizeRecording(reason, sessionId = recordingSessionId) {
    if (!isCurrentSession(sessionId) || finalizing) return;
    finalizedSessionId = sessionId;
    finalizing = true;
    clearReconnectTimer(true);
    clearRecordingReconnectState();
    clearFinalizeTimer();
    clearStartTimeout();
    stopTimer();
    cleanupStaleFrames(true);
    setAppState("saving");
    let saveError = "";

    try {
      if (journal) {
        if (openingCapture) currentRecordingId = await openingCapture;
        const saved = currentRecordingId ? await journal.close(currentRecordingId, reason) : null;
        log("Chunk journal sealed", { id: currentRecordingId, reason, stats: saved?.stats });
        toast(saved?.durationMs ? "Recording saved; processing jobs queued" : "No complete frames received; partial chunks retained");
        currentRecordingId = null;unsavedAudio = false;
        resetCollector();await renderRecordings();
        ui.queueStatus.textContent = "Ready to process";
        if (settings.autoProcess) processor?.resume();
        return;
      }
      if (completedPcmFrames.length === 0) {
        log("Session ended without complete PCM frames", {
          session: sessionId, reason: reason,
          packets: sessionStats.packetsReceived,
          invalid: sessionStats.invalidPackets
        });
        if (sessionStats.packetsReceived > 0) {
          toast("No complete audio frames received. Check Diagnostics.", "error");
        }
        resetCollector();
        return;
      }

      const sampleRate = deviceStatus.sampleRate || DEFAULT_SAMPLE_RATE;
      const wavBlob = createWavBlob(completedPcmFrames, sampleRate);
      const durationMs = Math.round(sessionStats.pcmBytes / 2 / sampleRate * 1000);
      const now = new Date();
      const id = now.getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const recording = {
        id, name: defaultRecordingName(now), createdAt: now.toISOString(),
        durationMs, sizeBytes: wavBlob.size, sampleRate, blob: wavBlob,
        notes: "", transcript: "", summary: "", stopReason: reason,
        stats: Object.assign({}, sessionStats)
      };
      await putRecording(recording);
      log("Recording saved", {
        id, session: sessionId, durationMs, sizeBytes: wavBlob.size,
        completeFrames: sessionStats.completeFrames, reason
      });
      toast("Recording saved");
      resetCollector();
      await renderRecordings();
    } catch (error) {
      saveError = friendlyError(error);
      unsavedAudio = Boolean(currentRecordingId) || completedPcmFrames.length > 0;
      log("Could not save recording", saveError);
      // Keep the PCM in memory for the Recovery download button.
      toast("Storage failed. Use Download unsaved audio in Settings.", "error");
    } finally {
      await releaseWakeLock();
      finalizing = false;
      if (saveError) {
        setAppState("error", "Audio is still in memory. Download it before reloading.");
      } else if (!isGattConnected()) {
        setAppState("disconnected");
      } else if (deviceStatus.state === DEVICE_STATE.CONNECTED_IDLE &&
                 deviceStatus.error === 0) {
        setAppState("idle");
      } else {
        setAppState("error", "Pendant is not idle. Disconnect and reconnect to recover.");
      }
    }
  }

  function resetCollector() {
    clearRecordingReconnectState();
    pendingFrames.clear();
    completedSequences.clear();
    completedPcmFrames = [];
    lastObservedSequence = null;
    lastFrameCleanupAt = 0;
    lastAudioAt = 0;
    sessionStats = createEmptyStats();
    recordingConfirmed = false;
    recordingStartedAt = 0;
    levelHistory = [];
    currentRms = 0;
    lastDb = -96;
    ui.timer.textContent = "00:00";
    updateMetrics();
  }

  function clearStartTimeout() {
    if (startTimeout) {
      clearTimeout(startTimeout);
      startTimeout = null;
    }
  }

  // Audio packet assembly

  function handleAudioNotification(event) {
    const original = event?.target?.value;
    const normalizer = globalThis.SynapAudioCodecV3?.normalizePacket;
    const values = typeof normalizer === "function"
      ? normalizer(original, event?.target || audioCharacteristic)
      : [original];
    for (const value of values) handleNormalizedAudioValue(value);
  }

  function handleNormalizedAudioValue(value) {
    if (!value || value.byteLength < AUDIO_HEADER_BYTES) {
      sessionStats.invalidPackets += 1;
      return;
    }

    if (
      value.getUint8(0) !== AUDIO_MAGIC ||
      value.getUint8(1) !== PROTOCOL_VERSION
    ) {
      sessionStats.invalidPackets += 1;
      log("Rejected audio packet with invalid marker/version", {
        marker: value.getUint8(0),
        version: value.getUint8(1),
        length: value.byteLength
      });
      updateMetrics();
      return;
    }

    if (
      appState !== "recording" &&
      appState !== "starting" &&
      appState !== "stopping"
    ) {
      return;
    }

    const sequence = value.getUint16(2, true);
    const chunkIndex = value.getUint8(4);
    const totalChunks = value.getUint8(5);
    const payloadLength = value.getUint16(6, true);

    sessionStats.packetsReceived += 1;

    if (
      totalChunks < MIN_CHUNKS_PER_FRAME ||
      totalChunks > MAX_CHUNKS_PER_FRAME ||
      chunkIndex >= totalChunks ||
      payloadLength === 0 ||
      payloadLength > MAX_AUDIO_PAYLOAD_BYTES ||
      AUDIO_HEADER_BYTES + payloadLength !== value.byteLength
    ) {
      sessionStats.invalidPackets += 1;
      log("Rejected malformed audio packet", {
        sequence: sequence,
        chunk: chunkIndex,
        total: totalChunks,
        payload: payloadLength,
        packetLength: value.byteLength
      });
      updateMetrics();
      return;
    }

    if (appState === "starting") confirmRecordingStarted("first-audio-packet");
    lastAudioAt = performance.now();
    if (completedSequences.has(sequence)) {
      sessionStats.duplicatePackets += 1;
      return;
    }
    let frame = pendingFrames.get(sequence);

    if (!frame) {
      observeSequence(sequence);

      frame = {
        sequence: sequence,
        totalChunks: totalChunks,
        chunks: new Array(totalChunks),
        receivedChunks: 0,
        receivedBytes: 0,
        createdAt: performance.now()
      };

      pendingFrames.set(sequence, frame);
    }

    if (frame.totalChunks !== totalChunks) {
      pendingFrames.delete(sequence);
      sessionStats.invalidPackets += 1;
      log("Chunk count changed inside frame", {
        sequence: sequence
      });
      return;
    }

    if (frame.chunks[chunkIndex]) {
      sessionStats.duplicatePackets += 1;
      return;
    }

    const payload = new Uint8Array(payloadLength);
    payload.set(
      new Uint8Array(
        value.buffer,
        value.byteOffset + AUDIO_HEADER_BYTES,
        payloadLength
      )
    );

    if (journal && currentRecordingId) {
      try {journal.append(currentRecordingId, {sequence, chunk:chunkIndex, total:totalChunks, payload});}
      catch(error){handleStorageError(error);return;}
    }

    frame.chunks[chunkIndex] = payload;
    frame.receivedChunks += 1;
    frame.receivedBytes += payloadLength;

    if (frame.receivedChunks === frame.totalChunks) {
      completeFrame(frame);
      pendingFrames.delete(sequence);
    }

    const now = performance.now();

    if (now - lastFrameCleanupAt > 250) {
      lastFrameCleanupAt = now;
      cleanupStaleFrames(false);
    }
  }
  function observeSequence(sequence) {
    if (sessionStats.firstSequence === null) {
      sessionStats.firstSequence = sequence;
    }

    if (lastObservedSequence !== null) {
      const delta =
        (sequence - lastObservedSequence + 65536) % 65536;

      if (delta > 1 && delta < 32768) {
        sessionStats.missingFrames += delta - 1;
      }
    }

    if (lastObservedSequence === null ||
        (sequence - lastObservedSequence + 65536) % 65536 < 32768) {
      lastObservedSequence = sequence;
    }
    sessionStats.lastSequence = sequence;
  }

  function completeFrame(frame) {
    if (frame.receivedBytes !== PCM_BYTES_PER_FRAME) {
      sessionStats.incompleteFrames += 1;
      log("Dropped frame with incorrect PCM length", {
        sequence: frame.sequence,
        bytes: frame.receivedBytes
      });
      updateMetrics();
      return;
    }

    const pcm = new Uint8Array(PCM_BYTES_PER_FRAME);
    let offset = 0;

    for (let index = 0; index < frame.totalChunks; index += 1) {
      const chunk = frame.chunks[index];

      if (!chunk) {
        sessionStats.incompleteFrames += 1;
        return;
      }

      pcm.set(chunk, offset);
      offset += chunk.length;
    }

    // With the journal enabled, only the waveform/assembly window stays in RAM.
    if (!journal) completedPcmFrames.push(pcm);
    completedSequences.add(frame.sequence);
    // Retain recent duplicates without rejecting the next uint16 counter cycle.
    if (completedSequences.size > RECENT_FRAME_WINDOW) {
      completedSequences.delete(completedSequences.keys().next().value);
    }
    sessionStats.completeFrames += 1;
    sessionStats.pcmBytes += pcm.length;

    updateAudioLevel(pcm);
    updateMetrics();
  }

  function cleanupStaleFrames(force) {
    const now = performance.now();

    pendingFrames.forEach(function (frame, sequence) {
      if (
        force ||
        now - frame.createdAt > INCOMPLETE_FRAME_TIMEOUT_MS
      ) {
        pendingFrames.delete(sequence);
        sessionStats.incompleteFrames += 1;
      }
    });

    updateMetrics();
  }

  function updateAudioLevel(pcm) {
    const view = new DataView(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength
    );
    let sumSquares = 0;
    const samples = pcm.byteLength / 2;

    for (let index = 0; index < samples; index += 1) {
      const normalized =
        view.getInt16(index * 2, true) / 32768;
      sumSquares += normalized * normalized;
    }

    currentRms = Math.sqrt(sumSquares / samples);
    lastDb =
      20 * Math.log10(Math.max(currentRms, 0.000016));
    levelHistory.push(currentRms);

    if (levelHistory.length > 150) {
      levelHistory.shift();
    }
  }

  // WAV creation

  function createWavBlob(pcmFrames, sampleRate) {
    const dataLength = pcmFrames.reduce(function (total, frame) {
      return total + frame.byteLength;
    }, 0);

    const header = new ArrayBuffer(44);
    const view = new DataView(header);

    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, dataLength, true);

    return new Blob(
      [header].concat(pcmFrames),
      { type: "audio/wav" }
    );
  }

  function writeAscii(view, offset, text) {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  }

  // Timer, wake lock and waveform

  function startTimer() {
    stopTimer();
    updateTimer();
    timerInterval = window.setInterval(updateTimer, 200);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function updateTimer() {
    if (!recordingConfirmed || !recordingStartedAt) return;

    const elapsed = performance.now() - recordingStartedAt;
    const clock = formatClock(elapsed);
    if (ui.timer.textContent !== clock) ui.timer.textContent = clock;
    const now = performance.now();
    if (appState === "recording" && document.visibilityState === "visible" &&
        now - foregroundAt > FOREGROUND_STALL_GRACE_MS &&
        now - lastAudioAt > AUDIO_STALL_TIMEOUT_MS) {
      log("Audio stalled while foregrounded; stopping safely", {
        stalledMs: Math.round(now-lastAudioAt), session: recordingSessionId
      });
      toast("Audio stream stalled. Saving what was received.", "error");
      stopRecording();
    }
  }

  function formatClock(milliseconds) {
    const totalSeconds = Math.max(
      0,
      Math.floor(milliseconds / 1000)
    );
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return (
        pad2(hours) +
        ":" +
        pad2(minutes) +
        ":" +
        pad2(seconds)
      );
    }

    return pad2(minutes) + ":" + pad2(seconds);
  }

  function pad2(number) {
    return String(number).padStart(2, "0");
  }

  async function acquireWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock) return;

    try {
      const sessionId = recordingSessionId;
      const lock = await navigator.wakeLock.request("screen");
      if ((!firmwareBusy && (!isCurrentSession(sessionId) ||
          (appState !== "starting" && appState !== "recording"))) || wakeLock) {
        await lock.release();
        return;
      }
      wakeLock = lock;
      lock.addEventListener("release", function () {
        if (wakeLock === lock) wakeLock = null;
        log("Screen wake lock released");
      });
      log("Screen wake lock acquired");
    } catch (error) {
      log("Wake lock unavailable", friendlyError(error));
    }
  }

  async function releaseWakeLock() {
    if (!wakeLock) return;

    try {
      await wakeLock.release();
    } catch (error) {
      log("Wake lock release failed", friendlyError(error));
    } finally {
      wakeLock = null;
    }
  }

  function drawWaveform() {
    if (performance.now() - lastWaveDraw < 50) {
      window.requestAnimationFrame(drawWaveform);return;
    }
    lastWaveDraw = performance.now();
    const canvas = ui.waveformCanvas;
    if (document.visibilityState === "hidden" || !canvas.getClientRects().length) {
      window.requestAnimationFrame(drawWaveform);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);

    const centerY = height / 2;
    const gradient = context.createLinearGradient(0, 0, width, 0);
    const paletteKey = document.documentElement.dataset.theme + ':' + document.documentElement.dataset.palette;
    if (waveformPalette?.key !== paletteKey) {
      const style = getComputedStyle(document.documentElement);
      waveformPalette = {key: paletteKey, colors: ['--accent', '--brand-indigo', '--brand-cyan', '--wave-grid'].map(name => style.getPropertyValue(name).trim())};
    }
    gradient.addColorStop(0, waveformPalette.colors[0]);
    gradient.addColorStop(.5, waveformPalette.colors[1]);
    gradient.addColorStop(1, waveformPalette.colors[2]);

    context.strokeStyle = waveformPalette.colors[3];
    context.lineWidth = ratio;
    context.beginPath();
    context.moveTo(0, centerY);
    context.lineTo(width, centerY);
    context.stroke();

    const values =
      levelHistory.length > 2
        ? levelHistory
        : createIdleWaveValues(90);
    const barCount = Math.min(values.length, 120);
    const spacing = width / barCount;

    context.strokeStyle = gradient;
    context.lineWidth = Math.max(2 * ratio, spacing * .33);
    context.lineCap = "round";

    for (let index = 0; index < barCount; index += 1) {
      const sourceIndex =
        Math.floor(
          (index / Math.max(1, barCount - 1)) *
          (values.length - 1)
        );
      const value = values[sourceIndex];
      const boosted =
        levelHistory.length > 2
          ? Math.min(1, value * 4.8)
          : value;
      const amplitude =
        Math.max(3 * ratio, boosted * height * .39);
      const x = spacing * index + spacing / 2;

      context.beginPath();
      context.moveTo(x, centerY - amplitude);
      context.lineTo(x, centerY + amplitude);
      context.stroke();
    }

    waveformPhase += .018;
    requestAnimationFrame(drawWaveform);
  }

  function createIdleWaveValues(count) {
    const values = [];

    for (let index = 0; index < count; index += 1) {
      const position = index / count;
      const envelope = Math.sin(position * Math.PI);
      const value =
        .035 +
        Math.abs(
          Math.sin(index * .37 + waveformPhase)
        ) *
        .05 *
        envelope;
      values.push(value);
    }

    return values;
  }

  // IndexedDB recording storage

  function openDatabase() {
    if (journal) return journal.open();
    if (databasePromise) return databasePromise;

    databasePromise = new Promise(function (resolve, reject) {
      const request =
        indexedDB.open("dk-pendant-recordings", 1);

      request.onupgradeneeded = function () {
        const database = request.result;

        if (!database.objectStoreNames.contains("recordings")) {
          const store = database.createObjectStore(
            "recordings",
            { keyPath: "id" }
          );
          store.createIndex("createdAt", "createdAt");
        }
      };

      request.onsuccess = function () {
        resolve(request.result);
      };

      request.onerror = function () {
        reject(request.error);
      };
    });

    return databasePromise;
  }

  async function putRecording(recording) {
    const database = await openDatabase();

    return new Promise(function (resolve, reject) {
      const transaction =
        database.transaction("recordings", "readwrite");
      transaction.objectStore("recordings").put(recording);
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () {
        reject(transaction.error);
      };
      transaction.onabort = function () { reject(transaction.error || new Error("Storage transaction aborted")); };
    });
  }

  async function updateRecordingFields(id, fields) {
    const database = await openDatabase();
    return new Promise(function (resolve, reject) {
      const transaction = database.transaction("recordings", "readwrite");
      const store = transaction.objectStore("recordings");
      const request = store.get(id);
      let updated = false;
      request.onsuccess = function () {
        // A delayed notes save or transcription must never resurrect a deletion.
        if (!request.result) return;
        store.put(Object.assign({}, request.result, fields));
        updated = true;
      };
      transaction.oncomplete = function () { resolve(updated); };
      transaction.onerror = transaction.onabort = function () {
        reject(transaction.error || new Error("Local edit transaction failed"));
      };
    });
  }

  async function getAllRecordings() {
    const database = await openDatabase();

    return new Promise(function (resolve, reject) {
      const transaction =
        database.transaction("recordings", "readonly");
      const request =
        transaction.objectStore("recordings").getAll();
      request.onsuccess = function () {
        resolve(request.result || []);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  async function deleteRecording(id) {
    if (journal) return journal.remove(id);
    const database = await openDatabase();

    return new Promise(function (resolve, reject) {
      const transaction =
        database.transaction("recordings", "readwrite");
      transaction.objectStore("recordings").delete(id);
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () {
        reject(transaction.error);
      };
    });
  }

  async function clearAllRecordings() {
    if (journal) return journal.clear();
    const database = await openDatabase();

    return new Promise(function (resolve, reject) {
      const transaction =
        database.transaction("recordings", "readwrite");
      transaction.objectStore("recordings").clear();
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () {
        reject(transaction.error);
      };
    });
  }

  // Recording library UI

  function localDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")].join("-");
  }

  function dateFromKey(key) {
    const parts = String(key).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function selectDay(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || localDateKey(dateFromKey(key)) !== key || key > localDateKey(new Date())) return;
    selectedDayKey = key;
    ui.datePicker.value = key;
    renderDateStrip();
    renderRecordings();
  }

  function requestDay(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || localDateKey(dateFromKey(key)) !== key || key > localDateKey(new Date())) return;
    ui.datePicker.value = key;
    // Every date entry point uses this event: Today, brain, weekly review and
    // cloud history must all observe the same selected day.
    ui.datePicker.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function moveDay(amount) {
    const date = dateFromKey(selectedDayKey);
    date.setDate(date.getDate() + amount);
    requestDay(localDateKey(date));
  }

  function renderDateStrip() {
    const today = new Date();
    const todayKey = localDateKey(today);
    ui.datePicker.max = todayKey;
    ui.datePicker.value = selectedDayKey;
    const selected = dateFromKey(selectedDayKey);
    const start = new Date(selected);
    start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const weekLabel = document.getElementById("calendarWeekLabel");
    if (weekLabel) weekLabel.textContent = start.toLocaleDateString([], { day: "numeric", month: "short" }) + " – " + end.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    const todayButton = document.getElementById("jumpToToday");
    if (todayButton) todayButton.disabled = selectedDayKey === todayKey;
    document.querySelectorAll("[data-day-step]").forEach(function (button) {
      const next = new Date(selected);
      next.setDate(next.getDate() + Number(button.dataset.dayStep));
      button.disabled = localDateKey(next) > todayKey;
    });
    const focusKey = ui.dateStrip.contains(document.activeElement) ? document.activeElement?.dataset.day : "";
    ui.dateStrip.replaceChildren();
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(start);
      date.setDate(date.getDate() + offset);
      const key = localDateKey(date);
      const activity = dayActivity.get(key) || 0;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "date-chip";
      button.dataset.day = key;
      button.disabled = key > todayKey;
      button.setAttribute("aria-label", date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + (activity ? ", " + activity + " saved recording" + (activity === 1 ? "" : "s") : ""));
      button.classList.toggle("selected", key === selectedDayKey);
      button.setAttribute("aria-pressed", String(key === selectedDayKey));
      const weekday = document.createElement("span");
      weekday.textContent = date.toLocaleDateString([], { weekday: "short" });
      const day = document.createElement("strong");
      day.textContent = String(date.getDate());
      const marker = document.createElement("span");
      marker.className = "date-activity";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = activity ? String(activity) : "";
      button.classList.toggle("is-today", key === todayKey);
      button.append(weekday, day, marker);
      button.addEventListener("click", function () { requestDay(key); });
      ui.dateStrip.appendChild(button);
    }
    if (focusKey) ui.dateStrip.querySelector('[data-day="' + focusKey + '"]')?.focus({ preventScroll: true });
  }

  function renderDayLens(recordings) {
    const date = dateFromKey(selectedDayKey);
    const todayKey = localDateKey(new Date());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const relative = selectedDayKey === todayKey ? "Today" :
      selectedDayKey === localDateKey(yesterday) ? "Yesterday" :
        date.toLocaleDateString([], { weekday: "long" });
    const totalDuration = recordings.reduce(function (sum, recording) {
      return sum + (Number(recording.durationMs) || 0);
    }, 0);
    ui.dayLensTitle.textContent = relative;
    ui.selectedDateLabel.textContent = date.toLocaleDateString([], {
      day: "numeric", month: "short",
      ...(date.getFullYear() !== new Date().getFullYear() ? {year: "numeric"} : {})
    });
    ui.glanceRecordings.textContent = String(recordings.length);
    ui.glanceDuration.textContent = totalDuration >= 3600000
      ? (totalDuration / 3600000).toFixed(1) + "h"
      : Math.round(totalDuration / 60000) + "m";
    ui.glanceSummaries.textContent = String(recordings.filter(function (item) {
      return Boolean(item.summary && item.summary.trim());
    }).length);
    ui.glanceTranscripts.textContent = String(recordings.filter(function (item) {
      return Boolean(item.transcript && item.transcript.trim());
    }).length);
  }

  function createInsightCard(recording) {
    const card = document.createElement("details");
    card.className = "insight-card";
    card.dataset.recordingId = String(recording.id);
    const top = document.createElement("summary");
    top.className = "insight-top";
    const heading = document.createElement("h3");
    heading.textContent = recording.name;
    const time = document.createElement("time");
    time.dateTime = recording.createdAt;
    time.textContent = new Date(recording.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    top.append(heading, time);
    card.appendChild(top);
    if (recording.summary && recording.summary.trim()) {
      const label = document.createElement("span");
      label.className = "insight-label";
      label.textContent = "Meeting summary";
      const summary = document.createElement("p");
      summary.className = "insight-summary";
      summary.textContent = recording.summary;
      card.append(label, summary);
    }
    if (recording.transcript && recording.transcript.trim()) {
      const transcript = document.createElement("details");
      transcript.className = "transcript-preview";
      const summary = document.createElement("summary");
      summary.textContent = "View transcript";
      const text = document.createElement("p");
      text.textContent = recording.transcript;
      transcript.append(summary, text);
      card.appendChild(transcript);
    }
    const open = document.createElement("button");
    open.type = "button";
    open.className = "text-button insight-open";
    open.textContent = "Open recording";
    open.addEventListener("click", function () {
      revealRecording(recording.id);
    });
    card.appendChild(open);
    return card;
  }

  function renderInsights(recordings) {
    const existing = new Map(Array.from(ui.insightsList.children).filter(card => card.dataset.recordingId).map(card => [card.dataset.recordingId, card]));
    const processed = recordings.filter(function (recording) {
      return Boolean((recording.summary && recording.summary.trim()) ||
        (recording.transcript && recording.transcript.trim()));
    });
    ui.insightsCount.textContent = String(processed.length);
    ui.emptyInsights.classList.toggle("hidden", processed.length > 0);
    const retained = new Set();
    processed.forEach(function (recording, index) {
      const id = String(recording.id), previous = existing.get(id);
      const signature = JSON.stringify([recording.name, recording.createdAt, recording.summary, recording.transcript, recording.notes, recording.meeting, recording.conversations]);
      let card = previous;
      if (!card || card.synapMemorySignature !== signature) {
        card = createInsightCard(recording);
        card.synapMemorySignature = signature;
        card.open = Boolean(previous?.open);
        previous?.remove();
      }
      retained.add(id);
      if (ui.insightsList.children[index] !== card) ui.insightsList.insertBefore(card, ui.insightsList.children[index] || null);
    });
    for (const [id, card] of existing) if (!retained.has(id)) card.remove();
    globalThis.dispatchEvent(new CustomEvent('synap-insights-rendered'));
  }

  async function renderRecordings() {
    const epoch = ++libraryRenderEpoch;
    const dayKey = selectedDayKey;
    // Keep the current cards visible while IndexedDB/cloud hydration completes.
    // Reconcile by recording ID below: replacing the list closes the tile and
    // destroys its native audio player immediately after a source is opened.

    let recordings = [];

    try {
      recordings = await getAllRecordings();
    } catch (error) {
      if (epoch !== libraryRenderEpoch) return;
      log("Could not load recordings", friendlyError(error));
      toast("Could not load local recordings", "error");
      return;
    }

    if (epoch !== libraryRenderEpoch) return;

    recordings.sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    dayActivity = new Map();
    recordings.forEach(function (recording) {
      const key = localDateKey(recording.createdAt);
      if (key) dayActivity.set(key, (dayActivity.get(key) || 0) + 1);
    });
    renderDateStrip();
    const dayRecordings = recordings.filter(function (recording) {
      return localDateKey(recording.createdAt) === dayKey;
    });
    renderDayLens(dayRecordings);
    renderInsights(dayRecordings);
    if (libraryScope === "day") recordings = dayRecordings;
    ui.recordingsCount.textContent = String(recordings.length);
    const hint = document.getElementById("libraryScopeHint");
    if (hint) hint.textContent = libraryScope === "all" ? "All recordings saved in this browser" : "Recordings for " + formatDate(dateFromKey(dayKey));
    const emptyCopy = document.querySelector("#emptyRecordings p");
    if (emptyCopy) emptyCopy.textContent = libraryScope === "all" ? "No recordings saved in this browser yet. Capture a moment, or sign in to restore your history." : "No recordings for this day. Choose All dates to see your other recordings.";

    ui.emptyRecordings.classList.toggle(
      "hidden",
      recordings.length > 0
    );
    ui.clearRecordingsButton.classList.toggle(
      "hidden",
      recordings.length === 0
    );

    libraryRecordings = recordings;
    renderLibraryPage();
  }

  function renderLibraryPage() {
    const matches = libraryRecordings.filter(recording => recordingMatchesQuery(recording, libraryQuery));
    const count = Math.min(libraryVisibleCount, matches.length);
    const searchStatus = document.getElementById("librarySearchStatus");
    if (searchStatus) {
      searchStatus.hidden = !libraryQuery.trim();
      searchStatus.textContent = matches.length ? matches.length + " matching recording" + (matches.length === 1 ? "" : "s") :
        "No matching recordings. Try another name, topic or phrase.";
    }
    const clearSearch = document.getElementById("clearLibrarySearch");
    if (clearSearch) clearSearch.hidden = !libraryQuery;
    const validIds = new Set(libraryRecordings.map(recording => "recording-" + recording.id));
    Array.from(ui.recordingsList.children).forEach(function (card) {
      if (validIds.has(card.id)) return;
      globalThis.SynapSpeechUI?.dispose(card);
      const urls = card.querySelector('.recording-content')?.synapAudioUrls || [];
      card.querySelectorAll("audio").forEach(function (audio) {
        audio.pause();
      });
      urls.forEach(function (url) {
        if (renderedObjectUrls.includes(url)) {
          URL.revokeObjectURL(url);
          renderedObjectUrls = renderedObjectUrls.filter(value => value !== url);
        }
      });
      card.remove();
    });
    for (let index = 0; index < count; index += 1) {
      const recording = matches[index];
      let card = Array.from(ui.recordingsList.children).find(node => node.id === "recording-" + recording.id);
      if (card) updateRecordingCard(card, recording);
      else card = createRecordingCard(recording);
      const position = ui.recordingsList.children[index];
      if (position !== card) {
        if (position) ui.recordingsList.insertBefore(card, position);
        else ui.recordingsList.appendChild(card);
      }
    }
    Array.from(ui.recordingsList.children).forEach(function (card, index) {
      card.hidden = index >= count;
      if (card.hidden) {
        card.open = false;
        card.querySelectorAll("audio").forEach(function (audio) { audio.pause(); });
      }
    });
    const remaining = matches.length - count;
    ui.libraryPagination.hidden = matches.length <= LIBRARY_PAGE_SIZE;
    ui.libraryCountLabel.textContent = count + " of " + matches.length;
    ui.showMoreRecordingsButton.hidden = remaining <= 0;
    ui.showMoreRecordingsButton.textContent = "Show " + Math.min(LIBRARY_PAGE_SIZE, remaining) + " more";
    ui.showLessRecordingsButton.hidden = count <= LIBRARY_PAGE_SIZE;
  }

  function recordingMatchesQuery(recording, query) {
    const terms = String(query || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const meeting = recording.meeting || {};
    const conversations = Array.isArray(meeting.conversations) ? meeting.conversations :
      (Array.isArray(recording.conversations) ? recording.conversations : []);
    const people = Array.isArray(meeting.people) ? meeting.people : [];
    const text = [recording.name, recording.notes, recording.transcript, recording.summary, meeting.executive_summary,
      ...people.map(person => person.name),
      ...conversations.flatMap(conversation => [conversation.title, conversation.summary,
        ...(Array.isArray(conversation.people) ? conversation.people.map(person => person.name) : []),
        ...(Array.isArray(conversation.topics) ? conversation.topics : [])])
    ].join(" ").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }

  function recordingRowMeta(recording) {
    const date = new Date(recording.createdAt);
    const label = date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    return label + " · " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + formatDuration(recording.durationMs);
  }

  function resetLibrarySearch() {
    libraryQuery = "";
    const input = document.getElementById("librarySearch");
    if (input) input.value = "";
  }

  function updateRecordingCard(card, recording) {
    Object.assign(card.synapRecording, recording);
    const name = card.querySelector(".recording-row-name");
    if (name) name.textContent = recording.name || "Untitled recording";
    const meta = card.querySelector(".recording-row-meta");
    if (meta) meta.textContent = recordingRowMeta(recording);
    const preview = card.querySelector(".recording-row-preview");
    if (preview) {
      preview.textContent = recording.summary || recording.meeting?.executive_summary || "";
      preview.hidden = !preview.textContent;
    }
    const content = card.querySelector(".recording-content");
    if (!content) return;
    // Update generated evidence in place, never replace a playing audio element
    // or an editable note/name field while a background refresh is arriving.
    let transcript = content.querySelector(".recording-transcript");
    if (recording.transcript && !transcript) {
      transcript = document.createElement("textarea");
      transcript.className = "recording-transcript";
      transcript.setAttribute("aria-label", "Transcript");
      transcript.readOnly = true;
      content.appendChild(recordingDisclosure("Transcript", transcript));
    }
    if (transcript && document.activeElement !== transcript) {
      if (recording.processingStage === "ready" || recording.summary) transcript.readOnly = true;
      if (transcript.readOnly) transcript.value = recording.transcript || "";
    }
    let summary = content.querySelector(".recording-summary");
    if (recording.summary && !summary) {
      summary = document.createElement("p");
      summary.className = "recording-summary";
      content.appendChild(recordingDisclosure("Summary", summary));
    }
    if (summary) summary.textContent = recording.summary || "";
  }

  function revealRecording(id) {
    resetLibrarySearch();
    const index = libraryRecordings.findIndex(function (recording) { return recording.id === id; });
    if (index < 0) return;
    libraryVisibleCount = Math.max(libraryVisibleCount, Math.ceil((index + 1) / LIBRARY_PAGE_SIZE) * LIBRARY_PAGE_SIZE);
    renderLibraryPage();
    const target = document.getElementById("recording-" + id);
    target.open = true;
    window.location.hash = "#library";
    window.requestAnimationFrame(function () {
      target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      target.querySelector("summary").focus({ preventScroll: true });
    });
  }

  function createRecordingCard(recording) {
    const card = document.createElement("details");
    card.className = "recording-card recording-accordion";
    card.id = "recording-" + recording.id;
    card.synapRecording = recording;
    const summary = document.createElement("summary");
    summary.className = "recording-row";
    const info = document.createElement("span");
    info.className = "recording-row-info";
    const name = document.createElement("span");
    name.className = "recording-row-name";
    name.textContent = recording.name || "Untitled recording";
    const meta = document.createElement("span");
    meta.className = "recording-row-meta";
    meta.textContent = recordingRowMeta(recording);
    const preview = document.createElement("span");
    preview.className = "recording-row-preview";
    preview.textContent = recording.summary || recording.meeting?.executive_summary || "";
    preview.hidden = !preview.textContent;
    const chevron = document.createElement("span");
    chevron.className = "recording-row-chevron";
    chevron.appendChild(recordingIcon("i-chevron"));
    chevron.setAttribute("aria-hidden", "true");
    info.append(name, meta, preview);
    const badge = document.createElement("span");
    badge.className = "recording-row-icon";
    badge.appendChild(recordingIcon("i-wave"));
    summary.append(badge, info, chevron);
    card.appendChild(summary);
    let loaded = false;
    card.addEventListener("toggle", function () {
      if (card.open && !loaded) {
        card.appendChild(createRecordingContent(recording, name));
        loaded = true;
      } else if (!card.open) {
        card.querySelectorAll("audio").forEach(function (audio) { audio.pause(); });
      }
    });
    return card;
  }

  function createRecordingContent(recording, rowName) {
    const card = document.createElement("div");
    card.className = "recording-content";
    card.synapAudioUrls = [];

    const titleRow = document.createElement("div");
    titleRow.className = "recording-title-row";

    const title = document.createElement("input");
    title.className = "recording-title";
    title.value = recording.name;
    title.setAttribute("aria-label", "Recording name");
    title.addEventListener("change", async function () {
      recording.name =
        title.value.trim() || defaultRecordingName(new Date());
      title.value = recording.name;
      rowName.textContent = recording.name;
      await updateRecordingFields(recording.id, { name: recording.name });
      log("Recording renamed", { id: recording.id });
    });
    titleRow.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "recording-meta";

    [
      formatDate(recording.createdAt),
      formatDuration(recording.durationMs),
      formatBytes(recording.sizeBytes),
      String(recording.sampleRate || DEFAULT_SAMPLE_RATE) + " Hz",
      recording.journal ? (recording.stats?.packetsReceived || 0) + " stored packets · " +
        (recording.stats?.incompleteFrames || 0) + " incomplete · " +
        (recording.stats?.missingFrames || 0) + " missing frames" : "Legacy WAV"
    ].forEach(function (text) {
      const item = document.createElement("span");
      item.textContent = text;
      meta.appendChild(item);
    });

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    if (recording.blob) {
      const audioUrl = URL.createObjectURL(recording.blob);
      renderedObjectUrls.push(audioUrl);card.synapAudioUrls.push(audioUrl);audio.src = audioUrl;
    }

    const actions = document.createElement("div");
    actions.className = "recording-actions";
    if (recording.journal) actions.appendChild(makeActionButton("Load audio", async function () {
      const blob = await journal.blob(recording);
      const url = URL.createObjectURL(blob);renderedObjectUrls.push(url);card.synapAudioUrls.push(url);audio.src = url;audio.load();
      toast("Audio loaded. Press Play.");
    }));

    actions.appendChild(
      makeActionButton("Download", function () {
        return downloadRecording(recording);
      })
    );

    const transcribeButton =
      makeActionButton("Process queue", async function () {
        if (firmwareBusy || recordingConfirmed || finalizing || appState === "starting") {
          toast("Stop and save before processing.");return;
        }
        if (!recording.journal) await journal.enqueueLegacy(recording.id);
        return processor?.resume();
      });
    actions.appendChild(transcribeButton);

    actions.appendChild(
      makeActionButton("Delete", async function () {
        if (!window.confirm("Delete this recording permanently?")) {
          return;
        }
        processor?.pause();
        await deleteRecording(recording.id);
        log("Recording deleted", { id: recording.id });
        await renderRecordings();
      }, true)
    );

    const notes = document.createElement("textarea");
    notes.className = "recording-notes";
    notes.placeholder = "Add a note…";
    notes.value = recording.notes || "";
    notes.setAttribute("aria-label", "Recording notes");
    bindDebouncedSave(notes, async function () {
      recording.notes = notes.value;
      await updateRecordingFields(recording.id, { notes: recording.notes });
    });

    card.appendChild(audio);
    card.appendChild(actions);
    globalThis.SynapSpeechUI?.attach(card, audio,
      () => recording.blob || journal.blob(recording), () => recording.name);
    card.appendChild(recordingDisclosure("Notes", notes));

    if (recording.transcript) {
      const transcript = document.createElement("textarea");
      transcript.className = "recording-transcript";
      transcript.value = recording.transcript;
      transcript.setAttribute("aria-label", "Transcript");
      if (recording.processingStage === "ready" || recording.processingState === "done" || recording.summary) {
        transcript.readOnly = true;
        transcript.title = "Transcript is source evidence for this memory. Refresh memory to rebuild it safely.";
      } else {
        bindDebouncedSave(transcript, async function () {
          recording.transcript = transcript.value;
          await updateRecordingFields(recording.id, { transcript: recording.transcript });
        });
      }
      card.appendChild(recordingDisclosure("Transcript", transcript));
    }

    if (recording.summary) {
      const summary = document.createElement("p");
      summary.className = "recording-summary";
      summary.textContent = recording.summary;
      card.appendChild(recordingDisclosure("Summary", summary));
    }

    card.appendChild(recordingDisclosure("Edit name & details", titleRow, meta));
    return card;
  }

  function recordingIcon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }

  function recordingDisclosure(label, ...contents) {
    const details = document.createElement("details");
    details.className = "recording-disclosure";
    const summary = document.createElement("summary");
    summary.textContent = label;
    summary.appendChild(recordingIcon("i-chevron"));
    details.append(summary, ...contents);
    return details;
  }

  function makeActionButton(label, handler, danger) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      danger
        ? "button button-danger button-small"
        : "button button-secondary button-small";
    button.textContent = label;
    button.addEventListener("click", function (event) {
      Promise.resolve().then(function () { return handler(event); }).catch(function (error) {
        log(label + " failed", friendlyError(error));
        toast(label + " failed: " + friendlyError(error), "error");
      });
    });
    return button;
  }

  function bindDebouncedSave(element, saveFunction) {
    let timeout = null;

    element.addEventListener("input", function () {
      clearTimeout(timeout);
      timeout = window.setTimeout(function () {
        Promise.resolve(saveFunction()).catch(function (error) {
          log("Local edit save failed", friendlyError(error));
          toast("Could not save your edit. Please try again.", "error");
        });
      }, 500);
    });
  }

  async function downloadRecording(recording) {
    const blob = recording.blob || await journal.blob(recording);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download =
      sanitizeFilename(recording.name) + ".wav";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    log("Recording downloaded", { id: recording.id });
  }

  // Settings and PWA lifecycle

  function loadSettings() {
    try {
      const stored =
        JSON.parse(localStorage.getItem("dk-pendant-settings") || "{}");
      settings = {
        endpoint: stored.endpoint || "",
        llmEndpoint: stored.llmEndpoint || "",
        autoProcess: stored.autoProcess === true,
        token: "",
        wakeLock: stored.wakeLock !== false
      };
      // Migrate v3 preferences without retaining its plaintext access token.
      if (stored.token) {
        localStorage.setItem("dk-pendant-settings", JSON.stringify({
          endpoint: settings.endpoint, llmEndpoint: settings.llmEndpoint,
          autoProcess: settings.autoProcess, wakeLock: settings.wakeLock
        }));
      }
    } catch (error) {
      log("Settings could not be parsed; defaults restored");
    }

    ui.endpointInput.value = settings.endpoint;
    ui.llmEndpointInput.value = settings.llmEndpoint;
    ui.autoProcessInput.checked = settings.autoProcess;
    ui.tokenInput.value = settings.token;
    ui.wakeLockInput.checked = settings.wakeLock;
  }

  function validHttpsEndpoint(value) {
    if (!value) return true;
    try { return new URL(value).protocol === "https:"; }
    catch (_) { return false; }
  }

  function saveSettings() {
    const endpoint = ui.endpointInput.value.trim();
    const llmEndpoint = ui.llmEndpointInput.value.trim();
    if (!validHttpsEndpoint(llmEndpoint)) {
      toast("Use a valid HTTPS LLM endpoint.", "error");return false;
    }
    if (!validHttpsEndpoint(endpoint)) {
      toast("Use a valid HTTPS transcription endpoint.", "error");
      return false;
    }
    settings = {
      endpoint: endpoint,
      llmEndpoint: llmEndpoint,
      autoProcess: ui.autoProcessInput.checked,
      token: ui.tokenInput.value.trim(),
      wakeLock: ui.wakeLockInput.checked
    };

    localStorage.setItem(
      "dk-pendant-settings",
      JSON.stringify({ endpoint: settings.endpoint, llmEndpoint: settings.llmEndpoint,
        autoProcess: settings.autoProcess, wakeLock: settings.wakeLock })
    );

    log("Settings saved", {
      endpointConfigured: Boolean(settings.endpoint),
      tokenConfigured: Boolean(settings.token),
      wakeLock: settings.wakeLock
    });
    toast("Settings saved");
    return true;
  }

  function rememberDeviceAssociation(id, device, unavailableMessage) {
    deviceAssociation = null;
    deviceIdentityMessage = unavailableMessage;
    if (!id) return;
    try {
      deviceAssociation = new globalThis.SynapDevices.Registry(localStorage).associate(id, device);
      deviceIdentityMessage = "Connected";
    } catch (error) {
      if (error.code === "DEVICE_ID_CHANGED") throw error;
      deviceAssociation = { deviceId: id };
      deviceIdentityMessage = "Device identified, but its association could not be saved. Check browser storage and reconnect.";
      log("Device association not saved", friendlyError(error));
    }
  }

  function renderDeviceSetup() {
    const status = document.getElementById("setupDeviceStatus");
    if (!status) return;
    const connected = isGattConnected();
    const states = {connecting:"Connecting…",starting:"Starting…",recording:"Recording",saving:"Saving…",stopping:"Saving…",updating:"Updating…",error:"Needs attention"};
    status.textContent = recordingReconnectPending && !connected ? "Recording paused" :
      (states[appState] || (connected ? "Connected" : "Not connected"));
    status.dataset.connected = String(connected);
    ui.chooseDeviceButton.disabled = firmwareBusy || connectInProgress || recordingConfirmed || finalizing || !!currentRecordingId;
    if (!connected && !firmwareBusy) {
      const updateStatus = document.getElementById("otaStatus");
      if (/^(Up to date|Update \d+ available|Checking|Connect to check)/.test(updateStatus.textContent)) {
        updateStatus.textContent = "Connect to check";
        document.getElementById("firmwareNotice").hidden = true;
      }
      document.getElementById("otaLatest").hidden = true;
    }
  }

  function openSettings() {
    if (ui.settingsDialog.open) { globalThis.SynapSettingsPanel.close(); return; }
    ui.endpointInput.value = settings.endpoint;
    ui.llmEndpointInput.value = settings.llmEndpoint;
    ui.autoProcessInput.checked = settings.autoProcess;
    ui.tokenInput.value = settings.token;
    ui.wakeLockInput.checked = settings.wakeLock;
    renderDeviceSetup();
    globalThis.SynapSettingsPanel.open();
  }

  function bindFirmwareUpdate() {
    const cancel = document.getElementById("otaCancel");
    const status = document.getElementById("otaStatus");
    const progress = document.getElementById("otaProgress");
    const targetId = () => deviceAssociation?.deviceId || null;
    const requireTarget = info => {
      if(info.protocol!==3) throw Error(globalThis.SynapOTA.MIGRATION_MESSAGE);
      if(!targetId() || info.deviceId!==targetId()) throw Error("Connect and identify the intended pendant before updating. Device ID mismatch or unavailable.");
      return info.deviceId;
    };
    let discoveryBusy=false;
    firmwareUpdater = new globalThis.SynapOTA.Client({
      connected:isGattConnected, queue:queueGattOperation,
      getService:()=>queueGattOperation(()=>gattServer.getPrimaryService(SERVICE_UUID),"Find pendant service"),
      progress:(message,value,committing)=>{
        status.textContent=message;progress.value=value;progress.hidden=false;cancel.disabled=committing;
      }
    });
    const eligible = ()=>isGattConnected() && !connectInProgress && !recordingConfirmed &&
      !finalizing && !currentRecordingId && !openingCapture && !unsavedAudio &&
      !["starting","stopping","saving"].includes(appState);
    const lock = value=>{
      if (value) clearReconnectTimer(true);
      firmwareBusy=value;cancel.disabled=true;cancel.hidden=!value;progress.hidden=!value;
      ui.chooseDeviceButton.disabled=value;
      for (const id of ["otaLatest","otaReleaseCheck","firmwareUpdateButton"]) {
        const control=document.getElementById(id);if(control)control.disabled=value;
      }
      ui.runQueueButton.disabled=value;
      setAppState(isGattConnected() ? (deviceStatus.error ? "error" : "idle") : "disconnected");
    };
    cancel.addEventListener("click",()=>{
      firmwareUpdater.cancel();cancel.disabled=true;status.textContent="Cancelling transfer…";
    });

    if (!globalThis.SynapReleases) return;
    const releases=globalThis.SynapReleases;
    const notice=document.getElementById("firmwareNotice"),noticeText=document.getElementById("firmwareNoticeText");
    const latestButton=document.getElementById("otaLatest"),bannerButton=document.getElementById("firmwareUpdateButton");
    let offered=null,offeredDevice=null,lastCheck=0,downloadController=null;
    const pendingKey=id=>"synap-ota-pending-device:"+id;
    const savePending=(id,m)=>{try{if(m)localStorage.setItem(pendingKey(id),JSON.stringify(m));else localStorage.removeItem(pendingKey(id));}catch(_){} };
    const getPending=id=>{try{const m=JSON.parse(localStorage.getItem(pendingKey(id)));return m?releases.validateManifest(m):null;}catch(_){return null;}};
    const announce=message=>{notice.hidden=false;noticeText.textContent=message;status.textContent=message;};
    const offerLabel=continuing=>{latestButton.textContent=continuing?'Continue update':'Update now';bannerButton.textContent=continuing?'Continue update':'Update pendant';};
    async function identity() {
      const epoch=connectionEpoch;
      try {
        const service=await queueGattOperation(()=>gattServer.getPrimaryService(SERVICE_UUID),"Find firmware identity service");
        const characteristic=await queueGattOperation(()=>service.getCharacteristic(releases.IDENTITY_UUID),"Find firmware identity");
        const value=await queueGattOperation(()=>characteristic.readValue(),"Read firmware identity");
        if(epoch!==connectionEpoch)throw Error("Pendant connection changed.");
        return new TextDecoder().decode(value);
      } catch(error){if(error.name==='NotFoundError')return null;throw error;}
    }
    async function inspect(force=false) {
      if(force && !eligible()) {status.textContent=isGattConnected()?"Stop and save before updating.":"Connect to check";return;}
      if(discoveryBusy||firmwareBusy||!eligible()||document.visibilityState==='hidden'||(!force&&Date.now()-lastCheck<60000))return;
      discoveryBusy=true;lastCheck=Date.now();const epoch=connectionEpoch;status.textContent="Checking…";
      const discoveryControls=[latestButton,bannerButton,document.getElementById('otaReleaseCheck')];
      discoveryControls.forEach(control=>control.disabled=true);
      // Discovery only reads through the GATT queue. It must not take the
      // firmware transfer lock or interrupt normal recording/FIFO processing.
      try {
        const info=await firmwareUpdater.check();
        const id=requireTarget(info),board=await identity(),pending=getPending(id);
        if(epoch!==connectionEpoch || !isGattConnected())throw Error('Pendant connection changed.');
        let verified=false;
        if(pending) {
          verified=info.build===pending.build&&board===pending.identity;
          if(verified){savePending(id,null);bannerButton.hidden=true;latestButton.hidden=true;announce(`Update complete · ${info.build}`);}
          else if([3,4].includes(info.state)&&info.session) {
            offered=pending;offeredDevice=id;bannerButton.hidden=false;latestButton.hidden=false;offerLabel(true);
            announce(`Paused at ${Math.floor(info.offset*100/pending.size)}% · Continue within 2 minutes`);
            return;
          } else announce(`Update not confirmed · Retry update`);
        }
        // A slow/offline public feed must not keep recording controls locked.
        const m=await releases.latest();
        if(firmwareBusy||!eligible())return;
        if(epoch!==connectionEpoch||id!==targetId()||!isGattConnected())throw Error('Pendant connection changed.');
        if(releases.compatible(m,info,board)) {
          offered=m;offeredDevice=id;bannerButton.hidden=false;latestButton.hidden=false;
          offerLabel(false);
          announce(`Update ${m.build} available`);
        } else {
          offered=null;bannerButton.hidden=true;latestButton.hidden=true;
          if(!pending&&!verified)status.textContent=`Up to date · ${info.build}`;
          if(!pending)notice.hidden=true;
        }
      }catch(error){if(firmwareBusy)return;offered=null;bannerButton.hidden=true;latestButton.hidden=true;
        announce("Update check: "+friendlyError(error));
      }finally{discoveryBusy=false;if(!firmwareBusy)discoveryControls.forEach(control=>control.disabled=false);}
    }
    checkFirmwareRelease=()=>inspect().catch(error=>log('Firmware check',friendlyError(error)));
    document.getElementById("otaReleaseCheck").addEventListener("click",()=>inspect(true));
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkFirmwareRelease();});
    setInterval(()=>checkFirmwareRelease(),60000);
    cancel.addEventListener('click',()=>downloadController?.abort());
    async function updateLatest() {
      if(firmwareBusy||discoveryBusy)return;
      if(!eligible()){openSettings();status.textContent='Connect, then stop and save before updating.';return;}
      if(!offered||offeredDevice!==targetId()){await inspect(true);return;}
      const m=offered,id=targetId();
      if(!window.confirm(`Update synap to ${m.build}?\n${id}\n\nKeep your pendant nearby and this app open.`))return;
      openSettings();lock(true);processor?.pause();ui.queueStatus.textContent="Paused · Tap Process recordings to resume";progress.value=0;
      let commitSent=false,resumeInterrupted=false;
      try {
        const info=await firmwareUpdater.check();
        if(requireTarget(info)!==id)throw Error('The connected pendant is not the selected update target.');
        const board=await identity();
        if(!releases.compatible(m,info,board))throw Error('This release is already installed or older than the running firmware.');
        if(![1,3,4,6].includes(info.state))throw Error('An update is already pending. Wait for reboot or transfer timeout.');
        const epoch=connectionEpoch;
        await acquireWakeLock();status.textContent='Downloading update…';cancel.disabled=false;
        downloadController=new AbortController();
        const binary=await releases.download(m,info.capacity,undefined,downloadController.signal);
        if(downloadController.signal.aborted)throw Error('Download cancelled. Nothing was flashed.');
        if(epoch!==connectionEpoch||id!==targetId()||!isGattConnected())throw Error('Pendant connection changed during download. Nothing was flashed.');
        savePending(id,m);
        try{await firmwareUpdater.update(binary,id);commitSent=true;}
        catch(error){if(!firmwareUpdater.committing){if(error.resumable)resumeInterrupted=true;else savePending(id,null);throw error;}commitSent=true;}
        status.textContent='Restarting pendant…';cancel.disabled=true;
        const deadline=Date.now()+8000;
        while(isGattConnected()&&Date.now()<deadline)await delay(100);
        if(isGattConnected())disconnectGatt("Firmware update completed; reconnect for verification");
        await delay(1500);
        let verified=false;
        for(let attempt=0;attempt<4;attempt++) {
          if(!isGattConnected())await connectPendant({silent:true,autoReconnect:true});
          if(isGattConnected()) {
            const running=await firmwareUpdater.check();
            if(requireTarget(running)!==id)throw Error('Reconnect the original pendant device ID to verify its update.');
            const runningIdentity=await identity();
            if(running.build===m.build&&runningIdentity===m.identity){verified=true;break;}
          }
          await delay(2000);
        }
        if(!verified)throw Error(`Update not confirmed. Reconnect to check.`);
        savePending(id,null);offered=null;bannerButton.hidden=true;latestButton.hidden=true;
        announce(`Update complete · ${m.build}`);
      }catch(error){announce(error.resumable?'Update paused · Reconnect to continue':friendlyError(error));}
      finally{
        downloadController=null;firmwareUpdater.reset();
        await releaseWakeLock();lock(false);
        if((commitSent||resumeInterrupted)&&!isGattConnected())recoverRememberedConnection('firmware-update',true);
      }
    }
    latestButton.addEventListener('click',updateLatest);bannerButton.addEventListener('click',updateLatest);
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    try {
      const showUpdate = function (event) {
        if (event.data && event.data.type === "APP_VERSION" && (event.data.revision || event.data.version) !== APP_REVISION) {
          const notice = document.getElementById("updateNotice");
          notice.hidden = false;
          notice.textContent = "App update ready. Finish recording, then reload.";
        }
      };
      const checkVersion = function () {
        if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "GET_VERSION" });
      };
      navigator.serviceWorker.addEventListener("message", showUpdate);
      navigator.serviceWorker.addEventListener("controllerchange", checkVersion);
      const registration =
        await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      await registration.update();
      checkVersion();
      let lastCheck = Date.now();
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && Date.now() - lastCheck > 60000) {
          lastCheck = Date.now();
          registration.update().then(checkVersion).catch(error => log("Update check failed", friendlyError(error)));
        }
      });
      log("Service worker registered", {
        scope: registration.scope
      });
    } catch (error) {
      log("Service worker registration failed", friendlyError(error));
    }
  }

  function setupInstallPrompt() {
    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      installPrompt = event;
      ui.installButton.title = "Install synap";
    });

    window.addEventListener("appinstalled", function () {
      installPrompt = null;
      ui.installButton.title = "synap is installed";
      toast("synap installed");
      log("PWA installed");
    });
  }

  // Formatting

  function defaultRecordingName(date) {
    return (
      "Recording " +
      date.toLocaleDateString([], {
        day: "2-digit",
        month: "short"
      }) +
      " " +
      date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })
    );
  }

  function formatDate(value) {
    return new Date(value).toLocaleString([], {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatDuration(milliseconds) {
    return formatClock(milliseconds || 0);
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";

    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );

    return (
      (bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0) +
      " " +
      units[index]
    );
  }

  function sanitizeFilename(value) {
    const cleaned = String(value || "recording")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/\s+/g, " ")
      .trim();

    return cleaned.slice(0, 80) || "recording";
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, milliseconds);
    });
  }

  // Event wiring

  let coreControlsBound = false;

  function bindCoreControls() {
    if (coreControlsBound) return;
    coreControlsBound = true;

    ui.connectButton.addEventListener("click", function () {
      if (isGattConnected()) {
        disconnectPendant();
      } else {
        connectPendant();
      }
    });
    ui.settingsButton.addEventListener("click", function (event) {
      openSettings();
      event.preventDefault();
    });
  }

  function bindEvents() {
    bindCoreControls();
    document.querySelectorAll("[data-day-step]").forEach(function (button) {
      button.addEventListener("click", function () { moveDay(Number(button.dataset.dayStep)); });
    });
    document.getElementById("jumpToToday")?.addEventListener("click", function () { requestDay(localDateKey(new Date())); });
    document.getElementById("librarySearch")?.addEventListener("input", function (event) {
      libraryQuery = event.target.value;
      libraryVisibleCount = LIBRARY_PAGE_SIZE;
      renderLibraryPage();
    });
    document.getElementById("clearLibrarySearch")?.addEventListener("click", function () {
      resetLibrarySearch();
      libraryVisibleCount = LIBRARY_PAGE_SIZE;
      renderLibraryPage();
      document.getElementById("librarySearch")?.focus();
    });
    window.addEventListener("synap-library-source", function (event) {
      resetLibrarySearch();
      const index = libraryRecordings.findIndex(recording => String(recording.id) === String(event.detail?.recordingId));
      if (index >= 0) libraryVisibleCount = Math.max(libraryVisibleCount, Math.ceil((index + 1) / LIBRARY_PAGE_SIZE) * LIBRARY_PAGE_SIZE);
      renderLibraryPage();
    });
    document.querySelectorAll("[data-library-scope]").forEach(function (button) {
      button.addEventListener("click", function () {
        libraryScope = button.dataset.libraryScope === "day" ? "day" : "all";
        libraryVisibleCount = LIBRARY_PAGE_SIZE;
        document.querySelectorAll("[data-library-scope]").forEach(function (choice) {
          choice.setAttribute("aria-pressed", String(choice.dataset.libraryScope === libraryScope));
        });
        renderRecordings();
      });
    });
    ui.showMoreRecordingsButton.addEventListener("click", function () {
      libraryVisibleCount += LIBRARY_PAGE_SIZE;
      renderLibraryPage();
      if (ui.showMoreRecordingsButton.hidden) ui.showLessRecordingsButton.focus();
    });
    ui.showLessRecordingsButton.addEventListener("click", function () {
      libraryVisibleCount = LIBRARY_PAGE_SIZE;
      ui.recordingsList.querySelectorAll("details").forEach(function (card) { card.open = false; });
      renderLibraryPage();
      ui.showMoreRecordingsButton.focus();
    });
    ui.datePicker.addEventListener("change", function () {
      if (ui.datePicker.value && ui.datePicker.value <= localDateKey(new Date())) {
        selectDay(ui.datePicker.value);
      }
    });
    ui.runQueueButton.addEventListener("click", function () {
      if (firmwareBusy || recordingConfirmed || finalizing || appState === "starting") {
        toast("Stop and save before running processing jobs.");return;
      }
      processor?.retry();
    });
    ui.pauseQueueButton.addEventListener("click", function () {processor?.pause();});
    ui.retrySaveButton.addEventListener("click", async function () {
      if (!journal || finalizing || recordingConfirmed || appState === "starting") return;
      try {
        await journal.retryFlush();
        if (currentRecordingId) await journal.close(currentRecordingId,"retried-local-save");
        currentRecordingId=null;unsavedAudio=false;await renderRecordings();
        setAppState(isGattConnected() && deviceStatus.state === 1 ? "idle" : "disconnected");
        toast("Local save completed");
      } catch(e){toast(friendlyError(e,"Local save"),"error");}
    });
    ui.startButton.addEventListener("click", startRecording);
    ui.stopButton.addEventListener("click", stopRecording);
    ui.chooseDeviceButton.addEventListener("click", function () {
      if (firmwareBusy) return;
      if (recordingConfirmed || finalizing || appState === "starting" || appState === "stopping" || recordingReconnectPending) {
        toast("Stop and save this recording before switching devices.", "error");
        return;
      }
      manualDisconnect = true;
      clearReconnectTimer(true);
      if (isGattConnected()) disconnectGatt("User selected another pendant");
      cleanupCharacteristics();
      attachBluetoothDevice(null);
      ui.settingsDialog.close();
      connectPendant();
    });
    ui.recoveryButton.addEventListener("click", async function () {
      if (appState === "recording" || appState === "starting" || finalizing) {
        toast("Stop the recording first.", "error");
        return;
      }
      if (journal && currentRecordingId) {
        try { await downloadRecording(await journal.get("recordings",currentRecordingId)); }
        catch(e){toast(friendlyError(e,"Recovery export"),"error");}
        return;
      }
      if (!completedPcmFrames.length) {
        toast("There is no unsaved audio in memory.");
        return;
      }
      downloadRecording({
        name: "Recovered recording", id: "recovery",
        blob: createWavBlob(completedPcmFrames, DEFAULT_SAMPLE_RATE)
      });
      // Keep this copy until the user closes the page or starts a new take.
    });

    ui.closeSettingsButton.addEventListener("click", function () {
      ui.settingsDialog.close();
    });

    ui.settingsForm.addEventListener("submit", function (event) {
      event.preventDefault();
      try {
        if (saveSettings()) ui.settingsDialog.close();
      } catch (error) {
        toast("Could not save preferences: " + friendlyError(error), "error");
      }
    });

    ui.installButton.addEventListener("click", async function () {
      if (!installPrompt) {
        toast(window.matchMedia("(display-mode: standalone)").matches
          ? "synap is already running as an installed app."
          : "No install prompt is available. Check your browser menu for Install app or Add to Home Screen, or open synap if already installed.");
        return;
      }
      const prompt = installPrompt;
      installPrompt = null;
      ui.installButton.disabled = true;
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch (error) {
        toast("Could not open the install prompt. Try your browser's install menu.", "error");
      } finally {
        ui.installButton.disabled = false;
      }
    });

    ui.clearRecordingsButton.addEventListener(
      "click",
      async function () {
        if (currentRecordingId || openingCapture || recordingConfirmed || finalizing) {
          toast("Stop and save the active take before clearing recordings.", "error");return;
        }
        if (
          !window.confirm(
            "Delete all locally stored recordings permanently?"
          )
        ) {
          return;
        }

        processor?.pause();
        await clearAllRecordings();
        log("All local recordings deleted");
        await renderRecordings();
      }
    );

    ui.copyDiagnosticsButton.addEventListener(
      "click",
      async function () {
        const text = diagnosticLines.join("\n");

        try {
          await navigator.clipboard.writeText(text);
          toast("Diagnostics copied");
        } catch (error) {
          const area = document.createElement("textarea");
          area.value = text;
          area.readOnly = true;
          area.style.cssText = "position:fixed;opacity:0;font-size:16px";
          // Elements outside an open modal are inert and cannot be selected.
          (ui.settingsDialog.open ? ui.settingsDialog : document.body).appendChild(area);
          try {
            area.focus();
            area.select();
            area.setSelectionRange(0, text.length);
            if (!document.execCommand("copy")) throw new Error("Copy unavailable");
            toast("Diagnostics copied");
          } catch (_) {
            toast("Could not copy. Select the log text to copy it.", "error");
          } finally {
            area.remove();
            ui.copyDiagnosticsButton.focus();
          }
        }
      }
    );

    ui.clearDiagnosticsButton.addEventListener("click", function () {
      diagnosticLines = [];
      ui.diagnosticsLog.textContent = "";
      log("Diagnostics cleared");
    });

    document.addEventListener("visibilitychange", function () {
      if (
        document.visibilityState === "visible" &&
        (recordingConfirmed || firmwareBusy) &&
        settings.wakeLock
      ) {
        acquireWakeLock();
      }
    });

    window.addEventListener("beforeunload", function (event) {
      if (firmwareBusy || recordingConfirmed || finalizing || unsavedAudio || recordingReconnectPending) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }

  // Start-up

  // Presentation only: anchors remain usable even if Bluetooth is unavailable.
  function bindSectionNavigation() {
    const links = Array.from(document.querySelectorAll(".rail-link"));
    const sections = links.map(function (link) {
      return document.querySelector(link.getAttribute("href"));
    });
    let scheduled = false;
    function applySelection(selected) {
      links.forEach(function (link, index) {
        link.classList.toggle("active", index === selected);
        if (index === selected) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }
    links.forEach(function (link, index) {
      link.addEventListener("click", function () {
        applySelection(index);
      });
    });
    function update() {
      scheduled = false;
      // A prior anchor must never override the section currently on screen.
      const header = document.querySelector(".topbar");
      const boundary = (header ? header.getBoundingClientRect().bottom : 80) + 32;
      let selected = 0;
      sections.forEach(function (section, index) {
        if (section && section.getBoundingClientRect().top <= boundary) selected = index;
      });
      if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) {
        selected = links.length - 1;
      }
      applySelection(selected);
    }
    function schedule() {
      if (!scheduled) { scheduled = true; window.requestAnimationFrame(update); }
    }
    window.addEventListener("scroll", schedule, {passive:true});
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(schedule);
      const main = document.querySelector("main");
      if (main) observer.observe(main);
      sections.forEach(section => { if (section) observer.observe(section); });
    }
    update();
  }

  async function initialize() {
    if (!journal) throw new Error("Audio storage module did not load. Deploy all v5 files and reload.");
    if (!navigator.locks) throw new Error("This build needs Web Locks for safe local storage. Use current Android Chrome over HTTPS.");
    await new Promise(function (resolve, reject) {
      navigator.locks.request("dk-pendant-app", {ifAvailable:true}, async function (lock) {
        if (!lock) {reject(new Error("Another pendant tab is open. Close it before using this one."));return;}
        resolve();await new Promise(function () {}); // Released automatically when this page closes.
      }).catch(reject);
    });
    // Core navigation must remain usable even if IndexedDB recovery fails.
    bindCoreControls();
    await journal.open();
    const recovered = await journal.recover();
    ui.appVersion.textContent = APP_VERSION;
    loadSettings();
    processor = new globalThis.DKFIFOProcessor(journal, {settings:()=>settings,canRun:()=>!firmwareBusy,onChange:function (message) {
      ui.queueStatus.textContent=message;log("FIFO",message);
      if (message === "Queue complete") renderRecordings();
    }});
    if (recovered) log("Recovered interrupted recordings from stored chunks", {count:recovered});
    bindEvents();
    bindFirmwareUpdate();
    bindReconnectRecovery();
    setupInstallPrompt();
    drawWaveform();
    updateMetrics();
    renderDateStrip();

    log("Application started", {
      version: APP_VERSION,
      protocol: PROTOCOL_VERSION,
      secureContext: window.isSecureContext,
      webBluetooth: Boolean(navigator.bluetooth),
      userAgent: navigator.userAgent
    });

    if (!window.isSecureContext) {
      setAppState(
        "unsupported",
        "This page must be hosted over HTTPS for Web Bluetooth."
      );
    } else if (!navigator.bluetooth) {
      setAppState(
        "unsupported",
        "Use Android Chrome. Web Bluetooth is unavailable in this browser."
      );
    } else {
      setAppState("disconnected");
    }

    await renderRecordings();
    if (settings.autoProcess) processor.resume();
    registerServiceWorker();
    await recoverRememberedConnection("page-load", true);
  }

  bindSectionNavigation();
  initialize().catch(function (error) {
    const message = friendlyError(error);
    log("Fatal initialization error", message);
    setAppState("error", message);
  });
})();
