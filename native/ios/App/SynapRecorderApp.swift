import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        RecorderController.shared.launch()
        return true
    }
    static func checkpoint(_ application: UIApplication) {
        // Finish the pending disk checkpoint only; Bluetooth has its own background mode.
        var task = UIBackgroundTaskIdentifier.invalid
        let finish = {
            if task != .invalid { application.endBackgroundTask(task); task = .invalid }
        }
        task = application.beginBackgroundTask(withName: "Save received audio", expirationHandler: finish)
        RecorderController.shared.backgrounded { DispatchQueue.main.async(execute: finish) }
    }
}

@main struct SynapRecorderApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            RecorderScreen(controller: .shared).tint(Color(red: 0.22, green: 0.77, blue: 0.51))
                .onChange(of: phase) { value in
                    if value == .active { RecorderController.shared.foregrounded() }
                    else if value == .background { AppDelegate.checkpoint(.shared) }
                }
        }
    }
}
