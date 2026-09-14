import Foundation

public struct RecordingInfo: Codable, Identifiable {
    public var id = UUID().uuidString.lowercased()
    public var name: String
    public var createdAt = Date()
    public var peripheralID: UUID
    public var deviceID: String
    public var token: Data
    public var generation: UInt32?
    public var stopRequested = false
    public var stopRequestedAt: Date?
    public var closed = false
    public var stopReason: String?
    public var receivedFrames: Int64 = 0
    public var timelineFrames: Int64 = 0
    public var missingFrames: Int64 = 0
    public var pcmFrames: Int64 = 0
    public var adpcmFrames: Int64 = 0
    public var moments: [Double] = []
    public init(name: String, peripheralID: UUID, deviceID: String, token: Data) {
        self.name = name; self.peripheralID = peripheralID; self.deviceID = deviceID; self.token = token
    }
}

private struct DiskCheckpoint: Codable {
    var version = 1
    var info: RecordingInfo
    var assembler: AudioAssembler
    var offset: UInt64
}

/// Confined to the Bluetooth queue. No UI event or timer is needed to commit data.
public final class CaptureJournal {
    private static let magic = Data("SYNLOG1\n".utf8)
    public let directory: URL
    public var wavURL: URL { directory.appendingPathComponent("recording.wav") }
    public private(set) var info: RecordingInfo
    public private(set) var assembler: AudioAssembler
    private let log: FileHandle, wav: FileHandle
    private var offset: UInt64
    private var packetsSinceCheckpoint = 0
    public var receivedSeconds: Double { Double(assembler.receivedFrames) * 0.05 }
    public var timelineSeconds: Double { Double(max(0, assembler.highestLogical + 1)) * 0.05 }

    public init(root: URL, info: RecordingInfo) throws {
        self.info = info; self.assembler = AudioAssembler(now: info.createdAt.timeIntervalSince1970)
        directory = root.appendingPathComponent(info.id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.protect(directory)
        let rawURL = directory.appendingPathComponent("packets.synap")
        let audioURL = directory.appendingPathComponent("recording.wav")
        try Self.magic.write(to: rawURL, options: .withoutOverwriting)
        try Self.wavHeader(audioBytes: 0).write(to: audioURL, options: .withoutOverwriting)
        try Self.protect(rawURL); try Self.protect(audioURL)
        log = try FileHandle(forUpdating: rawURL); wav = try FileHandle(forUpdating: audioURL)
        offset = UInt64(Self.magic.count)
        try checkpoint()
    }

    public init(restoring directory: URL) throws {
        let data = try Data(contentsOf: directory.appendingPathComponent("checkpoint.json"))
        let saved = try JSONDecoder().decode(DiskCheckpoint.self, from: data)
        guard saved.version == 1, UUID(uuidString: saved.info.id) != nil, saved.offset >= 8 else { throw CaptureError.damagedJournal }
        self.directory = directory; info = saved.info; assembler = saved.assembler; offset = saved.offset
        log = try FileHandle(forUpdating: directory.appendingPathComponent("packets.synap"))
        wav = try FileHandle(forUpdating: directory.appendingPathComponent("recording.wav"))
        guard try log.read(upToCount: 8) == Self.magic, try log.seekToEnd() >= offset else { throw CaptureError.damagedJournal }
        if !info.closed {
            try recoverTail()
            try checkpoint()
        }
    }

    deinit { try? log.close(); try? wav.close() }

    public func receive(_ packet: Data, at time: Double = Date().timeIntervalSince1970) throws {
        guard !info.closed else { throw CaptureError.closedJournal }
        guard packet.count > 0, packet.count <= 508 else { throw CaptureError.invalidPacket }
        var record = Data(); record.appendLE(time.bitPattern); record.appendLE(UInt16(packet.count)); record.appendLE(UInt16(0))
        record.append(packet); record.appendLE(Self.crc32(record))
        try log.seek(toOffset: offset); try log.write(contentsOf: record); offset += UInt64(record.count)
        try consume(packet, at: time)
        packetsSinceCheckpoint += 1
        if packetsSinceCheckpoint >= 64 { try checkpoint() }
    }

    private func consume(_ packet: Data, at time: Double) throws {
        var next = assembler
        do {
            let frame = try next.receive(packet, at: time)
            guard UInt64(max(0, next.highestLogical + 1)) * 1600 + 44 < 0xffff0000 else { throw CaptureError.sizeLimit }
            if let frame {
                // Keep RIFF below 4 GiB. Sparse holes represent samples never received.
                let start = UInt64(frame.logical) * 1600 + 44
                guard start + 1600 < 0xffff0000 else { throw CaptureError.sizeLimit }
                try wav.seek(toOffset: start); try wav.write(contentsOf: frame.pcm)
            }
            assembler = next
        } catch CaptureError.invalidPacket { /* Raw evidence remains in the packet journal. */ }
          catch CaptureError.conflictingPacket { /* Never overwrite a conflicting chunk. */ }
    }

    public func setGeneration(_ value: UInt32) throws { info.generation = value; try checkpoint() }
    public func requestStop() throws {
        info.stopRequested = true
        if info.stopRequestedAt == nil { info.stopRequestedAt = Date() }
        try checkpoint()
    }
    public func mark() throws {
        guard !info.closed, info.moments.count < 1000 else { return }
        info.moments.append(timelineSeconds); try checkpoint()
    }

    public func checkpoint() throws {
        guard !info.closed else { return }
        updateCounts()
        let bytes = UInt64(info.timelineFrames) * 1600
        guard bytes < 0xffff0000 - 44 else { throw CaptureError.sizeLimit }
        try wav.truncate(atOffset: 44 + bytes)
        try wav.seek(toOffset: 0); try wav.write(contentsOf: Self.wavHeader(audioBytes: UInt32(bytes)))
        try wav.synchronize(); try log.synchronize()
        try writeCheckpoint(info)
        packetsSinceCheckpoint = 0
    }

    public func close(reason: String) throws {
        guard !info.closed else { return }
        try checkpoint()
        var finished = info; finished.stopReason = reason; finished.closed = true
        let metadata: [String: Any] = [
            "schema": 1, "source": "synap-native-ios", "id": info.id, "name": info.name,
            "createdAt": ISO8601DateFormatter().string(from: info.createdAt), "deviceId": info.deviceID,
            "completeFrames": info.receivedFrames, "missingFrames": info.missingFrames,
            "pcmFrames": info.pcmFrames, "adpcmFrames": info.adpcmFrames,
            "moments": info.moments, "stopReason": reason
        ]
        let json = try JSONSerialization.data(withJSONObject: metadata, options: .sortedKeys)
        guard json.count <= 65536 else { throw CaptureError.sizeLimit }
        var footer = Data("syap".utf8); footer.appendLE(UInt32(json.count)); footer.append(json)
        if json.count % 2 != 0 { footer.append(0) }
        let audioBytes = UInt32(info.timelineFrames * 1600)
        try wav.seek(toOffset: UInt64(audioBytes) + 44); try wav.write(contentsOf: footer)
        try wav.seek(toOffset: 0); try wav.write(contentsOf: Self.wavHeader(audioBytes: audioBytes, footerBytes: UInt32(footer.count)))
        try wav.synchronize(); try log.synchronize()
        try writeCheckpoint(finished)
        info = finished
    }

    private func updateCounts() {
        info.receivedFrames = assembler.receivedFrames
        info.timelineFrames = max(0, assembler.highestLogical + 1)
        info.missingFrames = assembler.missingFrames
        info.pcmFrames = assembler.pcmFrames; info.adpcmFrames = assembler.adpcmFrames
    }

    private func writeCheckpoint(_ value: RecordingInfo) throws {
        let url = directory.appendingPathComponent("checkpoint.json")
        let data = try JSONEncoder().encode(DiskCheckpoint(info: value, assembler: assembler, offset: offset))
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }

    private func recoverTail() throws {
        try log.seek(toOffset: offset)
        while let header = try log.read(upToCount: 12), !header.isEmpty {
            guard header.count == 12 else { try preserveTornTail(header); return }
            let length = Int(header.u16(8)), time = Double(bitPattern: header.u64(0))
            guard (1...508).contains(length), time.isFinite, time >= 0 else { throw CaptureError.damagedJournal }
            let body = try log.read(upToCount: length + 4) ?? Data()
            guard body.count == length + 4 else { try preserveTornTail(header + body); return }
            let packet = Data(body.prefix(length))
            guard Self.crc32(header + packet) == body.u32(length) else { throw CaptureError.damagedJournal }
            try consume(packet, at: time)
            offset += UInt64(12 + body.count)
        }
    }

    private func preserveTornTail(_ bytes: Data) throws {
        let backup = directory.appendingPathComponent("interrupted-tail-\(UUID().uuidString).bin")
        try bytes.write(to: backup, options: .withoutOverwriting); try Self.protect(backup)
        try log.truncate(atOffset: offset)
    }

    public static func readInfo(at directory: URL) throws -> RecordingInfo {
        try JSONDecoder().decode(DiskCheckpoint.self, from: Data(contentsOf: directory.appendingPathComponent("checkpoint.json"))).info
    }

    public static func protect(_ url: URL) throws {
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
        var mutable = url
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try mutable.setResourceValues(values)
    }

    public static func wavHeader(audioBytes: UInt32, footerBytes: UInt32 = 0) -> Data {
        var data = Data("RIFF".utf8); data.appendLE(audioBytes + 36 + footerBytes)
        data.append(Data("WAVEfmt ".utf8)); data.appendLE(UInt32(16)); data.appendLE(UInt16(1)); data.appendLE(UInt16(1))
        data.appendLE(UInt32(16000)); data.appendLE(UInt32(32000)); data.appendLE(UInt16(2)); data.appendLE(UInt16(16))
        data.append(Data("data".utf8)); data.appendLE(audioBytes)
        return data
    }

    public static func crc32(_ bytes: Data) -> UInt32 {
        var crc = UInt32.max
        for byte in bytes {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = (crc >> 1) ^ (crc & 1 != 0 ? 0xedb88320 : 0) }
        }
        return ~crc
    }
}
