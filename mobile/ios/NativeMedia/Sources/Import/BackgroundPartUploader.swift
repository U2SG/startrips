import Foundation

/// The composition retains one uploader and forwards the AppDelegate background-session
/// completion handler to finishBackgroundEvents. Files outlive app suspension/termination.
@MainActor public final class BackgroundPartUploader: NSObject, PartUploading, URLSessionTaskDelegate {
    public let identifier: String
    public var finishBackgroundEvents: (() -> Void)?
    private let receiptDirectory: URL
    private var pending: [String: CheckedContinuation<String, Error>] = [:]
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        config.httpShouldSetCookies = false
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()
    private struct Receipt: Codable { let etag: String }
    public init(identifier: String, receiptDirectory: URL) throws {
        self.identifier = identifier; self.receiptDirectory = receiptDirectory
        try FileManager.default.createDirectory(at: receiptDirectory, withIntermediateDirectories: true,
                                               attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        super.init()
        _ = session
    }
    public func upload(_ signed: SignedUploadPart, file: URL, key: String) async throws -> String {
        guard signed.url.scheme == "https", validKey(key), pending[key] == nil else { throw MediaFailure.invalidUpload }
        let receipt = receiptDirectory.appendingPathComponent(key + ".json")
        if FileManager.default.fileExists(atPath: receipt.path) {
            return try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: receipt)).etag
        }
        let tasks = await session.allTasks
        try Task.checkCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                pending[key] = continuation
                // A completion may have arrived while allTasks was suspended.
                if let data = try? Data(contentsOf: receipt), let result = try? JSONDecoder().decode(Receipt.self, from: data) {
                    pending.removeValue(forKey: key)?.resume(returning: result.etag); return
                }
                if let task = tasks.first(where: { $0.taskDescription == key && $0.state != .completed }) {
                    task.resume(); return
                }
                var request = URLRequest(url: signed.url)
                request.httpMethod = "PUT"; request.allHTTPHeaderFields = signed.headers
                let task = session.uploadTask(with: request, fromFile: file)
                task.taskDescription = key; task.resume()
            }
        }, onCancel: { [weak self] in
            Task { @MainActor in await self?.cancel(prefix: key) }
        })
    }
    public func cancel(prefix: String) async {
        for task in await session.allTasks where task.taskDescription?.hasPrefix(prefix) == true { task.cancel() }
        for key in Array(pending.keys) where key.hasPrefix(prefix) {
            pending.removeValue(forKey: key)?.resume(throwing: CancellationError())
        }
    }
    nonisolated public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let key = task.taskDescription
        let response = task.response as? HTTPURLResponse
        Task { @MainActor in
            guard let key, self.validKey(key) else { return }
            do {
                if let error { throw error }
                guard let response else { throw MediaFailure.unavailable }
                guard (200..<300).contains(response.statusCode) else { throw MediaFailure.http(response.statusCode) }
                guard let etag = response.value(forHTTPHeaderField: "ETag")?.trimmingCharacters(in: .whitespacesAndNewlines), !etag.isEmpty else { throw MediaFailure.missingETag }
                try JSONEncoder().encode(Receipt(etag: etag)).write(to: self.receiptDirectory.appendingPathComponent(key + ".json"), options: .atomic)
                self.pending.removeValue(forKey: key)?.resume(returning: etag)
            } catch { self.pending.removeValue(forKey: key)?.resume(throwing: error) }
        }
    }
    nonisolated public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in
            let completion = self.finishBackgroundEvents; self.finishBackgroundEvents = nil; completion?()
        }
    }
    private func validKey(_ key: String) -> Bool {
        !key.isEmpty && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }
}
