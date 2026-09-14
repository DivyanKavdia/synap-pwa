import SwiftUI
import AVFoundation

struct RecorderScreen: View {
    @ObservedObject var controller: RecorderController
    @State private var choosingPendant = false
    private var state: RecorderViewState { controller.view }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 20) {
                        HStack {
                            Label(state.connected ? "Pendant connected" : "Pendant disconnected", systemImage: "circle.fill")
                                .font(.caption).foregroundStyle(state.connected ? Color.green : .secondary)
                            Spacer()
                            if let battery = state.battery { Label("\(battery)%", systemImage: "battery.100").font(.caption) }
                        }
                        TimelineView(.periodic(from: .now, by: 0.5)) { timeline in
                            let stalled = state.active && timeline.date.timeIntervalSince(state.lastAudio ?? .distantPast) > 2
                            VStack(alignment: .leading, spacing: 5) {
                                Text(clock(state.received)).font(.system(size: 52, weight: .medium, design: .rounded)).monospacedDigit()
                                Text(stalled ? "Waiting for audio" : "Audio received").foregroundStyle(stalled ? Color.orange : .secondary)
                            }
                        }
                        if state.active {
                            Text(state.transport).font(.caption.weight(.medium))
                            if state.missing > 0 {
                                Text("\(String(format: "%.2f", Double(state.missing) * 0.05)) seconds of audio not received")
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        }
                        Text(state.message).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("captureStatus")
                        HStack {
                            if state.phase == "save-failed" || state.phase == "recovery-failed" {
                                Button("Retry recovery", action: controller.retrySave).buttonStyle(.borderedProminent)
                            } else if state.active {
                                Button(action: controller.stopRecording) { Label("Stop & save", systemImage: "stop.fill").frame(maxWidth: .infinity) }
                                    .buttonStyle(.borderedProminent).tint(.red).disabled(state.phase == "saving" || state.phase == "stopping")
                                TimelineView(.periodic(from: .now, by: 0.5)) { timeline in
                                    Button(action: controller.mark) { Image(systemName: "star").padding(5) }
                                        .buttonStyle(.bordered).accessibilityLabel("Mark moment")
                                        .disabled(state.phase != "recording" || timeline.date.timeIntervalSince(state.lastAudio ?? .distantPast) > 2)
                                }
                            } else if state.phase == "idle" {
                                Button(action: controller.startRecording) { Label("Start recording", systemImage: "mic.fill").frame(maxWidth: .infinity) }
                                    .buttonStyle(.borderedProminent)
                            } else {
                                Button { controller.scan(); choosingPendant = true } label: { Label("Connect pendant", systemImage: "antenna.radiowaves.left.and.right").frame(maxWidth: .infinity) }
                                    .buttonStyle(.borderedProminent)
                            }
                        }
                    }.padding(.vertical, 10)
                } footer: {
                    Text("Audio is saved by this iPhone app while you use other apps. Keep Bluetooth on and the pendant nearby. Force quitting stops capture.")
                }
                Section("Recordings") {
                    if state.recordings.isEmpty {
                        Text("Your saved recordings will appear here.").foregroundStyle(.secondary).padding(.vertical, 8)
                    }
                    ForEach(state.recordings) { recording in
                        NavigationLink {
                            RecordingScreen(recording: recording, controller: controller)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(recording.name).font(.headline)
                                HStack {
                                    Text(clock(Double(recording.timelineFrames) * 0.05))
                                    if recording.missingFrames > 0 { Text("Has audio gaps").foregroundStyle(.orange) }
                                }.font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 4)
                        }
                    }
                }
                Section {
                    Link(destination: URL(string: "https://divyankavdia.github.io/synap-pwa/")!) { Label("Open synap memories", systemImage: "arrow.up.right.square") }
                    if state.connected, !state.active { Button("Disconnect pendant", action: controller.disconnect) }
                } footer: {
                    Text("Share a saved WAV to Files, then use Import audio in synap to create transcripts and memories. Use one recorder at a time; disconnect Bluefy before connecting here.")
                }
            }
            .navigationTitle("synap")
            .sheet(isPresented: $choosingPendant) {
                NavigationStack {
                    List {
                        Section {
                            ForEach(state.devices.sorted { $0.rssi > $1.rssi }) { pendant in
                                Button { controller.connect(pendant.id); choosingPendant = false } label: {
                                    VStack(alignment: .leading) { Text(pendant.name); Text("Tap to connect").font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                            if state.devices.isEmpty { Label("Looking for your pendant…", systemImage: "antenna.radiowaves.left.and.right") }
                        } footer: { Text("Wake the pendant and disconnect it from Bluefy. Allow Bluetooth access when iPhone asks.") }
                    }.navigationTitle("Your pendant").toolbar { Button("Done") { choosingPendant = false } }
                }.presentationDetents([.medium, .large])
            }
        }
    }
}

private struct RecordingScreen: View {
    let recording: RecordingInfo
    @ObservedObject var controller: RecorderController
    @State private var player: AVAudioPlayer?
    @State private var playing = false, confirmDelete = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            Section {
                Text(recording.name).font(.title2.weight(.semibold))
                Text(recording.createdAt.formatted(date: .abbreviated, time: .shortened)).foregroundStyle(.secondary)
                LabeledContent("Audio received", value: clock(Double(recording.receivedFrames) * 0.05))
                LabeledContent("Timeline", value: clock(Double(recording.timelineFrames) * 0.05))
                if recording.missingFrames > 0 { Text("Some audio was not received. Those positions remain silent in the original recording.").foregroundStyle(.orange) }
                if let error { Text(error).foregroundStyle(.red) }
                Button(playing ? "Pause" : "Play recording") {
                    do {
                        if playing { player?.pause(); playing = false }
                        else {
                            if player == nil { player = try AVAudioPlayer(contentsOf: controller.audioURL(for: recording)) }
                            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
                            try AVAudioSession.sharedInstance().setActive(true)
                            playing = player?.play() == true
                        }
                    } catch { self.error = error.localizedDescription }
                }.disabled(recording.receivedFrames == 0 || controller.view.active)
                ShareLink(item: controller.audioURL(for: recording)) { Label("Share original WAV", systemImage: "square.and.arrow.up") }.disabled(recording.receivedFrames == 0)
            }
            if !recording.moments.isEmpty {
                Section("Marked moments") {
                    ForEach(Array(recording.moments.enumerated()), id: \.offset) { _, moment in Text(clock(moment)) }
                }
            }
            Section {
                Button("Delete recording", role: .destructive) { confirmDelete = true }
            } footer: { Text("The original PCM and received Bluetooth packets stay on this iPhone until you delete the recording.") }
        }
        .navigationTitle("Recording").navigationBarTitleDisplayMode(.inline)
        .onDisappear { player?.stop(); playing = false; try? AVAudioSession.sharedInstance().setActive(false) }
        .confirmationDialog("Delete this recording and its original audio from this iPhone?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete recording", role: .destructive) { controller.delete(recording); dismiss() }
        }
    }
}

private func clock(_ seconds: Double) -> String {
    let value = max(0, Int(seconds))
    return value >= 3600 ? String(format: "%d:%02d:%02d", value / 3600, value / 60 % 60, value % 60) : String(format: "%02d:%02d", value / 60, value % 60)
}
