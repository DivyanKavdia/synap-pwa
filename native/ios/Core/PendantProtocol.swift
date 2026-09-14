import Foundation

public enum CaptureError: LocalizedError {
    case invalidPacket, conflictingPacket, ambiguousSequence, damagedJournal, closedJournal, sizeLimit
    public var errorDescription: String? {
        switch self {
        case .invalidPacket: return "The pendant sent an invalid audio packet."
        case .conflictingPacket: return "Conflicting audio packets were retained for recovery."
        case .ambiguousSequence: return "Audio was interrupted too long to resume this take safely."
        case .damagedJournal: return "This recording needs recovery. Its original files have been kept."
        case .closedJournal: return "This recording is already saved."
        case .sizeLimit: return "This recording reached its file size limit. Start a new take."
        }
    }
}

extension Data {
    func u16(_ offset: Int) -> UInt16 { UInt16(self[offset]) | UInt16(self[offset + 1]) << 8 }
    func u32(_ offset: Int) -> UInt32 { UInt32(u16(offset)) | UInt32(u16(offset + 2)) << 16 }
    func u64(_ offset: Int) -> UInt64 { UInt64(u32(offset)) | UInt64(u32(offset + 4)) << 32 }
    mutating func appendLE<T: FixedWidthInteger>(_ number: T) {
        var value = number.littleEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}

public struct PendantStatus {
    public let state: UInt8, error: UInt8, mtu: UInt16
    public init?(_ bytes: Data) {
        guard bytes.count == 16, bytes[0] == 0x5a, bytes[1] == 2,
              bytes[2] <= 3, bytes.u16(10) == 16000, bytes.u16(12) == 800 else { return nil }
        state = bytes[2]; error = bytes[3]; mtu = bytes.u16(4)
    }
}

public struct RecoveryStatus {
    public let flags: UInt8, acknowledgement: UInt8, capacity: UInt16, generation: UInt32, tokenHash: UInt32
    public var available: Bool { flags & 1 != 0 && capacity > 0 }
    public var armed: Bool { flags & 2 != 0 }
    public var waiting: Bool { flags & 4 != 0 }
    public var finishing: Bool { flags & 8 != 0 }
    public var supportsReplay: Bool { flags & 16 != 0 }
    public init?(_ bytes: Data) {
        guard bytes.count == 16, bytes[0] == 0x52, bytes[1] == 1, bytes.u16(4) <= 600 else { return nil }
        flags = bytes[2]; acknowledgement = bytes[3]; capacity = bytes.u16(4)
        generation = bytes.u32(8); tokenHash = bytes.u32(12)
    }
    public func belongs(to token: Data, generation expected: UInt32? = nil) -> Bool {
        token.count == 8 && armed && tokenHash == Self.hash(token) && (expected == nil || generation == expected)
    }
    public func confirmsStart(token: Data, armedGeneration: UInt32?) -> Bool {
        guard let armedGeneration else { return false }
        return available && belongs(to: token, generation: armedGeneration &+ 1) && !waiting && !finishing
    }
    public static func hash(_ token: Data) -> UInt32 {
        token.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
    }
    public static func command(_ opcode: UInt8, token: Data, sequence: UInt16 = .max) -> Data {
        precondition(token.count == 8 && (1...3).contains(opcode))
        var data = Data([opcode]); data.append(token)
        if opcode != 1 { data.appendLE(sequence) }
        return data
    }
}

public struct AudioFrame {
    public let sequence: UInt16, logical: Int64, pcm: Data, compressed: Bool
}

public struct AudioAssembler: Codable {
    struct Pending: Codable {
        var version: UInt8
        var parts: [Data?]
        var logical: Int64
    }
    public private(set) var lastRaw: UInt16 = .max
    public private(set) var highestLogical: Int64 = -1
    public private(set) var lastCompleteRaw: UInt16?
    public private(set) var lastCompleteLogical: Int64 = -1
    public private(set) var receivedFrames: Int64 = 0
    public private(set) var pcmFrames: Int64 = 0
    public private(set) var adpcmFrames: Int64 = 0
    public private(set) var invalidPackets: Int64 = 0
    public private(set) var lastPacketAt: Double
    private var pending: [UInt16: Pending] = [:]
    private var completed: Set<Int64> = []
    public var missingFrames: Int64 { max(0, highestLogical + 1 - receivedFrames) }
    public init(now: Double = Date().timeIntervalSince1970) { lastPacketAt = now }

    public mutating func receive(_ data: Data, at time: Double) throws -> AudioFrame? {
        guard time - lastPacketAt < 32768 * 0.05 else { throw CaptureError.ambiguousSequence }
        guard data.count >= 9, data.count <= 508, data[0] == 0xa5,
              data[1] == 2 || data[1] == 3, (1...20).contains(Int(data[5])),
              data[4] < data[5], Int(data.u16(6)) == data.count - 8 else {
            invalidPackets += 1; throw CaptureError.invalidPacket
        }
        let raw = data.u16(2), forward = Int(raw &- lastRaw)
        let logical: Int64
        if forward < 32768 {
            logical = highestLogical + Int64(forward)
            if forward > 0 { lastRaw = raw; highestLogical = logical }
        } else { logical = highestLogical - Int64(lastRaw &- raw) }
        lastPacketAt = time
        guard logical >= 0, logical >= highestLogical - 1023, !completed.contains(logical) else { return nil }
        pending = pending.filter { $0.value.logical >= highestLogical - 63 }
        var frame = pending[raw] ?? Pending(version: data[1], parts: Array(repeating: nil, count: Int(data[5])), logical: logical)
        guard frame.version == data[1], frame.parts.count == Int(data[5]) else {
            invalidPackets += 1; throw CaptureError.conflictingPacket
        }
        let chunk = Int(data[4]), payload = Data(data.dropFirst(8))
        if let existing = frame.parts[chunk] {
            guard existing == payload else { invalidPackets += 1; throw CaptureError.conflictingPacket }
            return nil
        }
        frame.parts[chunk] = payload; pending[raw] = frame
        guard frame.parts.allSatisfy({ $0 != nil }) else { return nil }
        var bytes = Data(); for part in frame.parts { bytes.append(part!) }
        pending.removeValue(forKey: raw)
        guard bytes.count == (frame.version == 2 ? 1600 : 404) else {
            invalidPackets += 1; throw CaptureError.invalidPacket
        }
        let pcm = frame.version == 2 ? bytes : try Self.decodeADPCM(bytes)
        completed.insert(logical); completed = completed.filter { $0 >= highestLogical - 1023 }
        receivedFrames += 1
        if frame.version == 2 { pcmFrames += 1 } else { adpcmFrames += 1 }
        if logical > lastCompleteLogical { lastCompleteRaw = raw; lastCompleteLogical = logical }
        return AudioFrame(sequence: raw, logical: logical, pcm: pcm, compressed: frame.version == 3)
    }

    public static func decodeADPCM(_ bytes: Data) throws -> Data {
        guard bytes.count == 404, bytes[3] == 1, bytes[2] <= 88 else { throw CaptureError.invalidPacket }
        let steps = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767]
        let changes = [-1,-1,-1,-1,2,4,6,8]
        var predictor = Int(Int16(bitPattern: bytes.u16(0))), index = Int(bytes[2]), output = Data()
        output.appendLE(Int16(predictor))
        for sample in 1..<800 {
            let packed = Int(bytes[4 + (sample - 1) / 2])
            let code = (sample - 1) % 2 == 0 ? packed & 15 : packed >> 4
            let step = steps[index]
            var delta = step >> 3
            if code & 1 != 0 { delta += step >> 2 }
            if code & 2 != 0 { delta += step >> 1 }
            if code & 4 != 0 { delta += step }
            predictor = max(-32768, min(32767, predictor + (code & 8 != 0 ? -delta : delta)))
            index = max(0, min(88, index + changes[code & 7]))
            output.appendLE(Int16(predictor))
        }
        return output
    }
}
