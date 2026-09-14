import XCTest
@testable import SynapCaptureCore

final class CaptureTests: XCTestCase {
    func packets(_ sequence: UInt16, value: Int16 = 100, version: UInt8 = 2, payload: Data? = nil) -> [Data] {
        var pcm = Data(); for _ in 0..<800 { pcm.appendLE(value) }
        let bytes = payload ?? pcm, count = (bytes.count + 399) / 400
        return (0..<count).map { index in
            let part = bytes.subdata(in: index * 400..<min(bytes.count, (index + 1) * 400))
            var header = Data([0xa5, version]); header.appendLE(sequence)
            header.append(contentsOf: [UInt8(index), UInt8(count)]); header.appendLE(UInt16(part.count)); header.append(part)
            return header
        }
    }

    func testPCMIsExactAndLateReplayFillsOnlyMissingFrames() throws {
        var assembler = AudioAssembler(now: 0), frames: [Int64: Data] = [:]
        for seq in [UInt16(0), 2, 1, 2] {
            for packet in packets(seq, value: Int16(seq) - 1) {
                if let frame = try assembler.receive(packet, at: 0.1) { frames[frame.logical] = frame.pcm }
            }
        }
        XCTAssertEqual(assembler.receivedFrames, 3); XCTAssertEqual(assembler.missingFrames, 0)
        XCTAssertEqual(assembler.lastCompleteRaw, 2)
        for seq in 0..<3 {
            let data = try XCTUnwrap(frames[Int64(seq)])
            for sample in 0..<800 { XCTAssertEqual(Int16(bitPattern: data.u16(sample * 2)), Int16(seq - 1)) }
        }
    }

    func testCounterWrapDoesNotOverwriteTheBeginning() throws {
        var assembler = AudioAssembler(now: 0)
        // Each forward jump is below a half-cycle; only four frames need decoding.
        for seq in [UInt16(0), 30000, 60000, 65535, 0] {
            for packet in packets(seq) { _ = try assembler.receive(packet, at: 1) }
        }
        XCTAssertEqual(assembler.highestLogical, 65536); XCTAssertEqual(assembler.receivedFrames, 5)
        XCTAssertEqual(assembler.lastCompleteRaw, 0)
        XCTAssertThrowsError(try assembler.receive(packets(1)[0], at: 1700))
    }

    func testADPCMMatchesExistingFirmwareAndBrowserGoldenVector() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "audio-vectors", withExtension: "json", subdirectory: "Fixtures"))
        let vector = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
        let encoded = try XCTUnwrap(Data(base64Encoded: vector["adpcm"]!)), expected = Data(base64Encoded: vector["decoded"]!)!
        XCTAssertEqual(try AudioAssembler.decodeADPCM(encoded), expected)
        var assembler = AudioAssembler(now: 0), frame: AudioFrame?
        for packet in packets(0, version: 3, payload: encoded) { frame = try assembler.receive(packet, at: 0.1) }
        XCTAssertEqual(frame?.pcm, expected); XCTAssertEqual(assembler.adpcmFrames, 1)
    }

    func testPartialConflictingAndMalformedPacketsCannotBecomeAudio() throws {
        var assembler = AudioAssembler(now: 0)
        let first = packets(0)[0]
        XCTAssertNil(try assembler.receive(first, at: 0.1))
        XCTAssertNil(try assembler.receive(first, at: 0.2))
        XCTAssertThrowsError(try assembler.receive(packets(0, value: 200)[0], at: 0.3))
        XCTAssertThrowsError(try assembler.receive(Data([0xa5, 2]), at: 0.4))
        XCTAssertEqual(assembler.receivedFrames, 0)
    }

    func testJournalReopensPendingChunksAndReplaysUncheckpointedTail() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var journal: CaptureJournal? = try CaptureJournal(root: root, info: RecordingInfo(name: "Test", peripheralID: UUID(), deviceID: "SYNAP-123456ABCDEF", token: Data(repeating: 7, count: 8)))
        let directory = journal!.directory, now = Date().timeIntervalSince1970
        let first = packets(0, value: -32768)
        try journal!.receive(first[0], at: now); try journal!.checkpoint()
        for packet in first.dropFirst() { try journal!.receive(packet, at: now + 0.1) }
        journal = nil
        let restored = try CaptureJournal(restoring: directory)
        XCTAssertEqual(restored.assembler.receivedFrames, 1)
        for packet in packets(2, value: 32767) { try restored.receive(packet, at: now + 0.2) }
        try restored.close(reason: "test")
        let wav = try Data(contentsOf: restored.wavURL)
        XCTAssertEqual(wav.u32(4), UInt32(wav.count - 8)); XCTAssertEqual(wav.u32(40), 4800)
        XCTAssertEqual(Int16(bitPattern: wav.u16(44)), -32768)
        XCTAssertEqual(wav.subdata(in: 1644..<3244), Data(repeating: 0, count: 1600))
        XCTAssertEqual(Int16(bitPattern: wav.u16(3244)), 32767)
        XCTAssertEqual(restored.info.missingFrames, 1)
        XCTAssertEqual(Data(wav[4844..<4848]), Data("syap".utf8))
        XCTAssertThrowsError(try restored.receive(packets(3)[0]))
    }

    func testTornJournalTailIsKeptSeparatelyAndNeverInterpretedAsAudio() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var journal: CaptureJournal? = try CaptureJournal(root: root, info: RecordingInfo(name: "Tail", peripheralID: UUID(), deviceID: "SYNAP-123456ABCDEF", token: Data(repeating: 9, count: 8)))
        let directory = journal!.directory; journal = nil
        let log = try FileHandle(forWritingTo: directory.appendingPathComponent("packets.synap"))
        try log.seekToEnd(); try log.write(contentsOf: Data([1, 2, 3])); try log.close()
        let restored = try CaptureJournal(restoring: directory)
        XCTAssertEqual(restored.assembler.receivedFrames, 0)
        let tail = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first { $0.lastPathComponent.hasPrefix("interrupted-tail-") })
        XCTAssertEqual(try Data(contentsOf: tail), Data([1, 2, 3]))
    }

    func testRecoveryIsBoundToTokenAndGeneration() {
        let token = Data(repeating: 7, count: 8)
        var bytes = Data([0x52, 1, 0x17, 255]); bytes.appendLE(UInt16(600)); bytes.appendLE(UInt16(5))
        bytes.appendLE(UInt32(12)); bytes.appendLE(RecoveryStatus.hash(token))
        let status = RecoveryStatus(bytes)!
        XCTAssertTrue(status.belongs(to: token, generation: 12)); XCTAssertTrue(status.waiting)
        XCTAssertFalse(status.belongs(to: token, generation: 13))
        XCTAssertFalse(status.belongs(to: Data(repeating: 8, count: 8), generation: 12))
        XCTAssertEqual(RecoveryStatus.command(3, token: token, sequence: 65535), Data([3] + Array(repeating: 7, count: 8) + [255, 255]))
    }

    func testEarlyAudioCannotUseTheIdleArmAsItsStartAcknowledgement() {
        let token = Data(repeating: 7, count: 8)
        func status(_ generation: UInt32, flags: UInt8 = 0x13) -> RecoveryStatus {
            var bytes = Data([0x52, 1, flags, 0]); bytes.appendLE(UInt16(600)); bytes.appendLE(UInt16(0))
            bytes.appendLE(generation); bytes.appendLE(RecoveryStatus.hash(token)); return RecoveryStatus(bytes)!
        }
        XCTAssertFalse(status(12).confirmsStart(token: token, armedGeneration: 12))
        XCTAssertTrue(status(13).confirmsStart(token: token, armedGeneration: 12))
        XCTAssertFalse(status(13).confirmsStart(token: token, armedGeneration: nil))
        XCTAssertFalse(status(13, flags: 0x17).confirmsStart(token: token, armedGeneration: 12))
        XCTAssertFalse(status(13, flags: 0x1b).confirmsStart(token: token, armedGeneration: 12))
        XCTAssertFalse(status(13).confirmsStart(token: Data(repeating: 8, count: 8), armedGeneration: 12))
        XCTAssertTrue(status(0).confirmsStart(token: token, armedGeneration: .max))
    }

    func testStopIntentSurvivesRelaunch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var journal: CaptureJournal? = try CaptureJournal(root: root, info: RecordingInfo(name: "Stop", peripheralID: UUID(), deviceID: "SYNAP-123456ABCDEF", token: Data(repeating: 1, count: 8)))
        let directory = journal!.directory
        try journal!.setGeneration(123); try journal!.requestStop()
        let deadlineOrigin = journal!.info.stopRequestedAt; journal = nil
        let restored = try CaptureJournal(restoring: directory)
        XCTAssertTrue(restored.info.stopRequested)
        XCTAssertEqual(restored.info.stopRequestedAt, deadlineOrigin)
        XCTAssertEqual(restored.info.generation, 123)
    }

    func testChecksumCorruptionRetainsTheOriginalJournal() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var journal: CaptureJournal? = try CaptureJournal(root: root, info: RecordingInfo(name: "CRC", peripheralID: UUID(), deviceID: "SYNAP-123456ABCDEF", token: Data(repeating: 1, count: 8)))
        let directory = journal!.directory
        try journal!.receive(packets(0)[0]); journal = nil
        let url = directory.appendingPathComponent("packets.synap")
        var raw = try Data(contentsOf: url); raw[raw.count - 1] ^= 0xff; try raw.write(to: url)
        XCTAssertThrowsError(try CaptureJournal(restoring: directory))
        XCTAssertEqual(try Data(contentsOf: url), raw)
    }

    func testRecoveryNeverTakesOverAnotherSessionOrRestartsAStoppedTake() {
        let token = Data(repeating: 7, count: 8)
        func control(_ state: UInt8) -> PendantStatus {
            var data = Data([0x5a, 2, state, 0]); data.appendLE(UInt16(247)); data.appendLE(UInt16(244))
            data.append(contentsOf: [7, 8]); data.appendLE(UInt16(16000)); data.appendLE(UInt16(800)); data.appendLE(UInt16(236))
            return PendantStatus(data)!
        }
        func recovery(_ flags: UInt8, generation: UInt32 = 12) -> RecoveryStatus {
            var data = Data([0x52, 1, flags, 5]); data.appendLE(UInt16(600)); data.appendLE(UInt16(0))
            data.appendLE(generation); data.appendLE(RecoveryStatus.hash(token)); return RecoveryStatus(data)!
        }
        func action(_ flags: UInt8, state: UInt8 = 2, generation: UInt32? = 12, owner: Data? = nil) -> RecoveryAction {
            RecoveryAction.decide(status: control(state), recovery: recovery(flags), token: owner ?? token, generation: generation)
        }
        XCTAssertEqual(action(0x17), .resume)
        XCTAssertEqual(action(0x13), .replay)
        XCTAssertEqual(action(0x1b), .drain)
        XCTAssertEqual(action(0x1f), .resume) // Finishing + disconnected must first release WAITING.
        XCTAssertEqual(action(0x03), .unsupported)
        XCTAssertEqual(action(0x13, state: 1), .finish)
        XCTAssertEqual(action(0x13, generation: nil), .finish)
        XCTAssertEqual(action(0x13, generation: 13), .finish)
        XCTAssertEqual(action(0x13, owner: Data(repeating: 9, count: 8)), .finish)
    }
}
