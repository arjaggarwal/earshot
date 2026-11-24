import Foundation

/// Prints a warning to stderr the first time only (for conditions that would otherwise repeat on every
/// audio buffer).
public final class LogOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    public init() {}

    public func callAsFunction(_ message: @autoclosure () -> String) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { FileHandle.standardError.write(Data("earshot: \(message())\n".utf8)) }
    }
}
