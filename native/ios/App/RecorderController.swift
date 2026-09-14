import Foundation
import CoreBluetooth
import Combine

struct NearbyPendant: Identifiable { let id: UUID; var name: String; var rssi: Int }
struct RecorderViewState {
    var phase = "disconnected", message = "Connect your pendant to begin."
    var deviceID = "", battery: Int?, received: Double = 0, missing: Int64 = 0
    var transport = "PCM16 preferred", lastAudio: Date?, active = false, connected = false
    var devices: [NearbyPendant] = [], recordings: [RecordingInfo] = []
}

final class RecorderController: ObservableObject {
    static let shared = RecorderController()
    @Published private(set) var view = RecorderViewState()
    private let queue = DispatchQueue(label: "com.synap.capture", qos: .userInitiated)
    private var link: PendantLink!
    private var root: URL!
    private var journal: CaptureJournal?
    private var state = RecorderViewState()
    private var generation = 0
    private var preparedToken: Data?
    private var preparedGeneration: UInt32?
    private var allowReconnect = true
    private var bound = false, configured = false, foreground = true
    private var bufferedPackets: [(Data, Double)] = []
    private var lastPublish: Double = 0
    private var stopDeadline: Date?
    private var started = false
    private var recoveryFailed = false
    private var activeURL: URL { root.appendingPathComponent("active.json") }

    private init() {}
    func launch() {
        queue.async {
            guard !self.started else { return }; self.started = true
            do {
                self.root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Recordings", isDirectory: true)
                try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
                try CaptureJournal.protect(self.root)
                if let data = try? Data(contentsOf: self.activeURL), let id = try? JSONDecoder().decode(String.self, from: data), UUID(uuidString: id) != nil {
                    do {
                        let restored = try CaptureJournal(restoring: self.root.appendingPathComponent(id))
                        if !restored.info.closed { self.journal = restored; self.state.phase = "reconnecting" }
                        else { try? FileManager.default.removeItem(at: self.activeURL) }
                    } catch {
                        self.recoveryFailed = true
                        self.state.phase = "recovery-failed"
                        self.state.message = "An interrupted take needs recovery. Its original files are kept. " + error.localizedDescription
                    }
                }
                self.reloadLibrary()
                let remembered = UserDefaults.standard.string(forKey: "synap.pendant").flatMap(UUID.init(uuidString:))
                self.link = PendantLink(queue: self.queue, restoring: self.recoveryFailed ? nil : self.journal?.info.peripheralID ?? remembered)
                self.bindLink(); self.scheduleStopDeadline(); self.emit()
            } catch { self.state.phase = "error"; self.state.message = error.localizedDescription; self.emit() }
        }
    }
    private func bindLink() {
        link.onDevice = { [weak self] id, name, rssi in
            guard let self else { return }
            self.state.devices.removeAll { $0.id == id }; self.state.devices.append(NearbyPendant(id: id, name: name, rssi: rssi)); self.emit()
        }
        link.onMessage = { [weak self] message in self?.state.message = message; self?.emit() }
        link.onReady = { [weak self] in self?.configure() }
        link.onDisconnected = { [weak self] message in self?.disconnected(message) }
        link.onValue = { [weak self] uuid, data in self?.received(uuid, data) }
    }
    func scan() { queue.async { guard self.journal == nil, !self.recoveryFailed else { return }; self.link?.scan() } }
    func connect(_ id: UUID) {
        queue.async {
            guard self.journal == nil, !self.recoveryFailed else { return }
            self.allowReconnect = true
            self.state.phase = "connecting"; self.state.message = "Connecting…"; self.emit(); self.link?.connect(id)
        }
    }
    func disconnect() {
        queue.async {
            guard self.journal == nil else { return }
            self.allowReconnect = false; self.generation += 1
            UserDefaults.standard.removeObject(forKey: "synap.pendant")
            self.link?.disconnect(); self.state.connected = false; self.state.phase = "disconnected"
            self.state.message = "Pendant disconnected."; self.emit()
        }
    }
    private func operation(_ uuid: CBUUID, _ kind: PendantLink.OperationKind, _ next: @escaping (Data) -> Void) {
        let owner = generation
        link.perform(uuid, kind) { [weak self] result in
            guard let self, self.generation == owner else { return }
            switch result {
            case .success(let bytes): next(bytes)
            case .failure(let error):
                if self.link.connected { self.fail(error.localizedDescription) }
                else { self.state.message = "Connection interrupted. Received audio is safe."; self.emit() }
            }
        }
    }
    private func configure() {
        generation += 1; configured = false; bound = false; preparedToken = nil; preparedGeneration = nil; bufferedPackets.removeAll()
        state.connected = true; state.phase = journal == nil ? "connecting" : "reconnecting"; state.message = "Preparing audio connection…"; emit()
        operation(PendantLink.audio, .subscribe) { _ in
            self.operation(PendantLink.control, .subscribe) { _ in
                self.operation(PendantLink.identity, .read) { bytes in
                    let identity = String(data: bytes, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    guard identity.range(of: "^SYNAP-[0-9A-Fa-f]{12}$", options: .regularExpression) != nil else { self.fail("The pendant identity was invalid."); return }
                    if let journal = self.journal, journal.info.deviceID != identity || journal.info.peripheralID != self.link.peripheral?.identifier {
                        self.fail("This is a different pendant. The received take has been saved."); return
                    }
                    self.state.deviceID = identity
                    UserDefaults.standard.set(self.link.peripheral?.identifier.uuidString, forKey: "synap.pendant")
                    self.operation(PendantLink.control, .read) { bytes in
                        guard let status = PendantStatus(bytes), status.error == 0 else { self.fail("The pendant reported a recording error. Check its firmware."); return }
                        self.operation(PendantLink.recovery, .read) { bytes in
                            guard let recovery = RecoveryStatus(bytes), recovery.available else { self.fail("Update the pendant firmware to enable recording recovery."); return }
                            self.configured = true
                            if self.journal != nil { self.resume(recovery, status: status) }
                            else if status.state == 1 { self.prepareIdle() }
                            else { self.fail("The pendant already has another recording. Stop it before starting here.") }
                        }
                    }
                }
            }
        }
    }
    private func prepareIdle() {
        guard journal == nil, link.connected else { return }
        let token = Data((0..<8).map { _ in UInt8.random(in: .min ... .max) })
        preparedToken = token; preparedGeneration = nil; state.phase = "connecting"
        operation(PendantLink.recovery, .write(RecoveryStatus.command(1, token: token))) { _ in
            self.pollRecovery { status in status.belongs(to: token) && !status.waiting } completion: { status in
                guard self.journal == nil else { return }
                self.preparedGeneration = status.generation
                self.state.phase = "idle"; self.state.message = "Ready. Start here or double-tap your pendant."; self.emit()
            }
        }
    }
    private func pollRecovery(attempt: Int = 0, condition: @escaping (RecoveryStatus) -> Bool, completion: @escaping (RecoveryStatus) -> Void) {
        let owner = generation
        queue.asyncAfter(deadline: .now() + 0.06) {
            guard self.generation == owner, self.link.connected else { return }
            self.operation(PendantLink.recovery, .read) { bytes in
                if let status = RecoveryStatus(bytes), condition(status) { completion(status) }
                else if attempt < 12 { self.pollRecovery(attempt: attempt + 1, condition: condition, completion: completion) }
                else { self.fail("The pendant did not acknowledge recording recovery. Received audio has been kept.") }
            }
        }
    }
    private func makeJournal() throws {
        guard journal == nil, let token = preparedToken, let id = link.peripheral?.identifier else { throw LinkFailure(message: "Reconnect the pendant before recording.") }
        let stamp = DateFormatter(); stamp.dateStyle = .medium; stamp.timeStyle = .short
        let info = RecordingInfo(name: "Recording " + stamp.string(from: Date()), peripheralID: id, deviceID: state.deviceID, token: token)
        let created = try CaptureJournal(root: root, info: info)
        try JSONEncoder().encode(info.id).write(to: activeURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        journal = created; bound = false; stopDeadline = nil; state.lastAudio = nil
    }
    func startRecording() {
        queue.async {
            guard self.state.phase == "idle", self.journal == nil else { return }
            do { try self.makeJournal() } catch { self.fail(error.localizedDescription); return }
            self.state.phase = "starting"; self.state.message = "Starting…"; self.emit()
            self.operation(PendantLink.control, .write(Data([1, 2]))) { _ in self.bindStartedStream() }
        }
    }
    private func bindStartedStream() {
        guard let current = journal, !bound else { return }
        let id = current.info.id
        let expected = preparedGeneration.map { $0 &+ 1 }
        pollRecovery { $0.belongs(to: current.info.token, generation: expected) && expected != nil && !$0.waiting && !$0.finishing } completion: { status in
            guard self.journal?.info.id == id else { return }
            do { try current.setGeneration(status.generation); try self.acceptBufferedAudio() }
            catch { self.fail(error.localizedDescription); return }
            self.state.phase = "recording"; self.state.message = "Recording on your iPhone."; self.emit()
            if current.info.stopRequested { self.sendStop() }
        }
    }
    private func resume(_ recovery: RecoveryStatus, status: PendantStatus) {
        guard let current = journal else { return }
        let action = RecoveryAction.decide(status: status, recovery: recovery, token: current.info.token, generation: current.info.generation)
        if action == .finish {
            finish(reason: "session-interrupted", message: "The pendant session ended. Received audio has been saved.")
            if status.state == 1 { prepareIdle() }
            else { fail("The pendant has another session. Stop it before starting here.") }
            return
        }
        guard action != .unsupported else { fail("Update the pendant to resume this interrupted take safely."); return }
        do { try current.checkpoint() } catch { fail(error.localizedDescription); return }
        if action == .drain {
            do { try acceptBufferedAudio() } catch { fail(error.localizedDescription); return }
            state.phase = "stopping"; state.message = "Finishing buffered audio…"; emit()
            if !current.info.stopRequested {
                do { try current.requestStop() } catch { fail(error.localizedDescription); return }
            }
            scheduleStopDeadline(); sendStop(); return
        }
        let command: UInt8 = action == .resume ? 2 : 3
        let ack = recovery.acknowledgement, id = current.info.id
        operation(PendantLink.recovery, .write(RecoveryStatus.command(command, token: current.info.token, sequence: current.assembler.lastCompleteRaw ?? .max))) { _ in
            self.pollRecovery { value in
                value.belongs(to: current.info.token, generation: current.info.generation) && !value.waiting && (command == 2 || value.acknowledgement != ack)
            } completion: { _ in
                guard self.journal?.info.id == id else { return }
                do { try self.acceptBufferedAudio() } catch { self.fail(error.localizedDescription); return }
                self.state.phase = current.info.stopRequested ? "stopping" : "recording"
                self.state.message = "Recording resumed. Any unrecoverable gap stays marked."; self.emit()
                if current.info.stopRequested { self.sendStop() }
            }
        }
    }
    private func acceptBufferedAudio() throws {
        bound = true
        let waiting = bufferedPackets; bufferedPackets.removeAll()
        for (bytes, time) in waiting { try journal?.receive(bytes, at: time) }
        if journal?.assembler.receivedFrames ?? 0 > 0 { state.lastAudio = Date() }
    }
    private func received(_ uuid: CBUUID, _ bytes: Data) {
        if uuid == PendantLink.audio {
            guard let current = journal else { return }
            let framesBefore = current.assembler.receivedFrames
            do {
                if bound { try current.receive(bytes) }
                else {
                    // Allow a restored notification burst while identity reads complete.
                    // This remains bounded to about 4 MiB of maximum-size packet payloads.
                    guard bufferedPackets.count < 8192 else { throw LinkFailure(message: "Could not verify this stream. Previously saved audio is kept.") }
                    bufferedPackets.append((bytes, Date().timeIntervalSince1970))
                }
                if current.assembler.receivedFrames > framesBefore { state.lastAudio = Date() }
                emit(force: false)
            } catch { fail(error.localizedDescription) }
        } else if uuid == PendantLink.control, configured, let status = PendantStatus(bytes) {
            if status.error != 0 { fail("The pendant stopped with error \(status.error). Received audio has been kept."); return }
            if status.state == 2, journal == nil, state.phase == "idle", preparedToken != nil {
                do { try makeJournal(); state.phase = "starting"; bindStartedStream() }
                catch { fail(error.localizedDescription) }
            } else if status.state == 1, journal != nil, bound {
                finish(reason: journal?.info.stopRequested == true ? "user-stop" : "pendant-stop", message: "Recording saved on your iPhone.")
                prepareIdle()
            }
        } else if bytes.count == 12, bytes[0] == 0xb7, bytes[1] == 2 {
            state.battery = bytes[3] & 1 != 0 ? Int(bytes[2]) : nil; emit(force: false)
        }
    }
    func stopRecording() {
        queue.async {
            guard let journal = self.journal else { return }
            do { try journal.requestStop() } catch { self.fail(error.localizedDescription); return }
            self.state.phase = self.link.connected ? "stopping" : "reconnecting"
            self.state.message = "Saving received audio and finishing the pendant stream…"; self.emit()
            if self.bound, self.link.connected { self.sendStop() }
            else if !self.link.connected { self.link.reconnect() }
            self.scheduleStopDeadline()
        }
    }
    private func scheduleStopDeadline() {
        guard let journal, journal.info.stopRequested else { return }
        let deadline = (journal.info.stopRequestedAt ?? Date()).addingTimeInterval(40), id = journal.info.id
        stopDeadline = deadline
        queue.asyncAfter(deadline: .now() + max(0, deadline.timeIntervalSinceNow)) {
            if self.journal?.info.id == id, self.journal?.info.stopRequested == true {
                self.allowReconnect = false
                self.finish(reason: "stop-interrupted", message: "Received audio was saved; the pendant did not finish its drain.")
                self.link.disconnect()
            }
        }
    }
    private func sendStop() {
        operation(PendantLink.control, .write(Data([0, 2]))) { _ in
            self.operation(PendantLink.control, .read) { _ in }
        }
    }
    func mark() {
        queue.async {
            guard self.bound, self.state.phase == "recording", let journal = self.journal,
                  !journal.info.stopRequested, journal.assembler.receivedFrames > 0,
                  Date().timeIntervalSince(self.state.lastAudio ?? .distantPast) <= 2 else { return }
            do { try journal.mark(); self.state.message = "Moment marked."; self.emit() }
            catch { self.fail(error.localizedDescription) }
        }
    }
    private func disconnected(_ message: String) {
        guard !recoveryFailed else { return }
        generation += 1; configured = false; bound = false; bufferedPackets.removeAll(); preparedToken = nil
        state.connected = false; state.phase = journal == nil ? "disconnected" : "reconnecting"; state.message = message
        do { try journal?.checkpoint() } catch { state.message = error.localizedDescription }
        emit()
        if journal != nil, allowReconnect { link.reconnect() }
    }
    private func finish(reason: String, message: String) {
        guard let current = journal else { return }
        state.phase = "saving"; emit()
        do {
            try current.close(reason: reason)
            try? FileManager.default.removeItem(at: activeURL)
            journal = nil; bound = false; bufferedPackets.removeAll(); stopDeadline = nil
            state.phase = link.connected ? "idle" : "disconnected"; state.message = message
            reloadLibrary(); emit()
        } catch { state.phase = "save-failed"; state.message = "Audio files are kept. " + error.localizedDescription; emit() }
    }
    private func fail(_ message: String) {
        allowReconnect = false
        if journal != nil { finish(reason: "interrupted", message: message) }
        state.phase = journal == nil ? "error" : "save-failed"; state.message = message; emit()
        // Closing our central link lets the firmware's bounded disconnect policy stop it.
        generation += 1; configured = false; bound = false; link?.disconnect()
    }
    func retrySave() {
        queue.async {
            if self.recoveryFailed {
                self.link?.disconnect(); self.started = false; self.recoveryFailed = false; self.launch()
            } else { self.finish(reason: "recovered", message: "Recording saved.") }
        }
    }
    func foregrounded() {
        queue.async {
            self.foreground = true; self.reloadLibrary()
            if let deadline = self.stopDeadline, Date() > deadline, self.journal?.info.stopRequested == true {
                self.allowReconnect = false
                self.finish(reason: "stop-interrupted", message: "Received audio has been saved."); self.link.disconnect()
            } else if self.journal != nil, self.bound, self.link?.connected == true, self.state.phase == "recording",
                      Date().timeIntervalSince(self.state.lastAudio ?? .distantPast) > 2 {
                // A live GATT connection alone is not evidence of audio delivery.
                // Reclaim only our current generation; never restart the microphone.
                self.bound = false; self.state.phase = "reconnecting"
                self.state.message = "Checking interrupted audio…"
                self.operation(PendantLink.control, .read) { bytes in
                    guard let status = PendantStatus(bytes) else { self.fail("The pendant status was invalid."); return }
                    self.operation(PendantLink.recovery, .read) { bytes in
                        guard let recovery = RecoveryStatus(bytes) else { self.fail("The pendant recovery status was invalid."); return }
                        self.resume(recovery, status: status)
                    }
                }
            }
            self.emit()
        }
    }
    func backgrounded(completion: @escaping () -> Void) {
        queue.async {
            self.foreground = false
            do { try self.journal?.checkpoint() } catch { self.fail(error.localizedDescription) }
            completion()
        }
    }
    private func reloadLibrary() {
        guard let root else { return }
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        state.recordings = folders.compactMap { try? CaptureJournal.readInfo(at: $0) }.filter { $0.closed }.sorted { $0.createdAt > $1.createdAt }
    }
    func audioURL(for recording: RecordingInfo) -> URL {
        root.appendingPathComponent(recording.id).appendingPathComponent("recording.wav")
    }
    func delete(_ recording: RecordingInfo) {
        queue.async {
            guard recording.closed, UUID(uuidString: recording.id) != nil, recording.id != self.journal?.info.id else { return }
            do { try FileManager.default.removeItem(at: self.root.appendingPathComponent(recording.id)); self.reloadLibrary(); self.emit() }
            catch { self.state.message = error.localizedDescription; self.emit() }
        }
    }
    private func emit(force: Bool = true) {
        let now = Date().timeIntervalSince1970
        guard force || (foreground && now - lastPublish >= 0.5) else { return }
        lastPublish = now; state.active = journal != nil
        if let journal {
            state.received = journal.receivedSeconds; state.missing = journal.assembler.missingFrames
            state.transport = journal.assembler.receivedFrames == 0 ? "Waiting for audio format" :
                journal.assembler.adpcmFrames > 0 ? "ADPCM fallback received" : "Uncompressed PCM16"
        }
        let snapshot = state
        DispatchQueue.main.async { self.view = snapshot }
    }
}
