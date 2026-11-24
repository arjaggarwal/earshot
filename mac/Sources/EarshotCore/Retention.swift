import Foundation

/// Deletes old recordings: `audio/` in saved meeting folders, and `run/audio/<id>/` folders for
/// captures whose meeting was never saved. Transcripts, notes and minutes are never touched.
public enum Retention {
    /// Removes and returns:
    /// - `meetings/**/<folder>/audio/` when the folder's `meeting.json` has an `endedAt` more than `keepDays` ago
    ///   (a meeting without `endedAt` keeps its audio);
    /// - `run/audio/<id>/` when neither it nor anything in it was modified in the last `keepDays`.
    /// `keepDays` below 1 is treated as 1, so a running capture is never swept. A folder a capture still needs
    /// (`run/active.json`, or a `run/finishing-*.json` waiting to be finished) keeps its audio, however old.
    @discardableResult
    public static func sweep(home: URL, keepDays: Int, now: Date) -> [URL] {
        let cutoff = now.addingTimeInterval(-Double(max(keepDays, 1)) * 86_400)
        var removed: [URL] = []
        let fm = FileManager.default
        let needed = neededFolders(run: home.appendingPathComponent("run"))
        func isNeeded(_ folder: URL) -> Bool { needed.contains(canonical(folder)) }

        for audio in meetingAudioFolders(in: home.appendingPathComponent("meetings")) {
            guard !isNeeded(audio.deletingLastPathComponent()),
                  let ended = endedAt(of: audio.deletingLastPathComponent()), ended < cutoff else { continue }
            if (try? fm.removeItem(at: audio)) != nil { removed.append(audio) }
        }

        let runAudio = home.appendingPathComponent("run/audio")
        for dir in children(of: runAudio) where isRealDirectory(dir) && !isNeeded(dir) {
            guard let touched = lastModified(dir), touched < cutoff else { continue }
            if (try? fm.removeItem(at: dir)) != nil { removed.append(dir) }
        }
        return removed
    }

    /// The meeting folders of the capture recording now and of those waiting to be finished.
    private static func neededFolders(run: URL) -> Set<String> {
        var files = [ActiveCapture.file(in: run)]
        let names = (try? FileManager.default.contentsOfDirectory(atPath: run.path)) ?? []
        files += names.filter { $0.hasPrefix("finishing-") && $0.hasSuffix(".json") }.map { run.appendingPathComponent($0) }
        return Set(files.compactMap { url in
            guard let data = try? Data(contentsOf: url),
                  let capture = try? JSONDecoder().decode(ActiveCapture.self, from: data) else { return nil }
            return canonical(URL(fileURLWithPath: capture.folder))
        })
    }

    private static func canonical(_ url: URL) -> String {
        url.resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// Every `audio` folder that sits next to a `meeting.json` (meetings/<year>/<month>/<folder>/audio),
    /// without descending into audio folders or following symlinks. URLs stay under `meetings` as given.
    private static func meetingAudioFolders(in dir: URL, depth: Int = 0) -> [URL] {
        guard depth < 6 else { return [] }
        var found: [URL] = []
        for url in children(of: dir) where isRealDirectory(url) {
            if url.lastPathComponent == "audio" {
                if FileManager.default.fileExists(atPath: dir.appendingPathComponent("meeting.json").path) { found.append(url) }
            } else {
                found += meetingAudioFolders(in: url, depth: depth + 1)
            }
        }
        return found
    }

    /// Non-hidden entries, as URLs under `dir` exactly as given (FileManager's URL listing resolves /var to /private/var).
    private static func children(of dir: URL) -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { !$0.hasPrefix(".") }.sorted().map { dir.appendingPathComponent($0) }
    }

    private static func isRealDirectory(_ url: URL) -> Bool {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        return values?.isDirectory == true && values?.isSymbolicLink != true
    }

    private static func endedAt(of folder: URL) -> Date? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("meeting.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = json["endedAt"] as? String else { return nil }
        return parseISO(text)
    }

    static func parseISO(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: text)
    }

    /// The newest modification date of the folder and everything in it (a WAV being appended
    /// changes the file's date, not the folder's).
    private static func lastModified(_ dir: URL) -> Date? {
        let key: Set<URLResourceKey> = [.contentModificationDateKey]
        guard var newest = (try? dir.resourceValues(forKeys: key))?.contentModificationDate else { return nil }
        let walk = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: Array(key))
        while let url = walk?.nextObject() as? URL {
            if let d = (try? url.resourceValues(forKeys: key))?.contentModificationDate, d > newest { newest = d }
        }
        return newest
    }
}
