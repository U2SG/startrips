import Foundation
import UIKit
import StartripsMedia

@MainActor final class ReadOnlyTransfer: PartUploading {
    func upload(_ signed: SignedUploadPart, file: URL, key: String) async throws -> String { throw MediaFailure.readOnly }
    func cancel(prefix: String) async {}
}

@MainActor final class TransferRegistry {
    static let shared = TransferRegistry()
    private let prefix = "app.startrips.upload."
    private var transfers: [String: BackgroundPartUploader] = [:]

    private static func root() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true).appendingPathComponent("NativeMedia", isDirectory: true)
    }

    static func directory(for scope: String) throws -> URL {
        NativeMediaFeatureModel.scopeDirectory(root: try root(), scopeID: scope)
    }

    func uploader(at directory: URL) throws -> BackgroundPartUploader {
        let identifier = prefix + directory.lastPathComponent
        if let existing = transfers[identifier] { return existing }
        let uploader = try BackgroundPartUploader(identifier: identifier, receiptDirectory: directory.appendingPathComponent("receipts"))
        transfers[identifier] = uploader
        return uploader
    }

    func restore(_ identifier: String, completion: @escaping () -> Void) {
        guard identifier.hasPrefix(prefix) else { completion(); return }
        let digest = String(identifier.dropFirst(prefix.count))
        guard digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let root = try? Self.root() else { completion(); return }
        let directory = root.appendingPathComponent(digest, isDirectory: true)
        guard FileManager.default.fileExists(atPath: directory.path),
              let uploader = try? uploader(at: directory) else { completion(); return }
        uploader.finishBackgroundEvents = completion
    }
}

@MainActor final class TransferAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        TransferRegistry.shared.restore(identifier, completion: completionHandler)
    }
}
