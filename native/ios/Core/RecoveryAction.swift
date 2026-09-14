import Foundation

/// An existing take can only receive audio from its own armed firmware generation.
/// A mismatch ends the local take; it must never cause START or a token takeover.
public enum RecoveryAction: Equatable {
    case finish, resume, replay, drain, unsupported

    public static func decide(status: PendantStatus, recovery: RecoveryStatus, token: Data, generation: UInt32?) -> Self {
        guard let generation, status.state == 2, status.error == 0,
              recovery.belongs(to: token, generation: generation) else { return .finish }
        if recovery.waiting { return .resume }
        if recovery.finishing { return .drain }
        return recovery.supportsReplay ? .replay : .unsupported
    }
}
