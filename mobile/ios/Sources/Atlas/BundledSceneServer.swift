import Foundation
import Network

// A loopback-only, read-only origin lets production ES modules and MapLibre's
// bundled worker run with normal browser semantics. No owner API or cookies are
// exposed here. Maps use the server's existing public mapstyle proxy only.
final class BundledSceneServer {
    private let root: URL
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "app.startrips.scene")
    private let mapOrigin: URL?

    init(root: URL, mapOrigin: URL?) { self.root = root; self.mapOrigin = mapOrigin }

    func start(completion: @escaping (Result<URL, Error>) -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        var completed = false
        listener.stateUpdateHandler = { state in
            guard !completed else { return }
            if case .ready = state, let port = listener.port {
                completed = true
                completion(.success(URL(string: "http://127.0.0.1:\(port.rawValue)/index.html")!))
            } else if case .failed(let error) = state { completed = true; completion(.failure(error)) }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 35) { connection.cancel() }
            self.receive(connection, accumulated: Data())
        }
        listener.start(queue: queue)
    }

    func stop() { listener?.cancel(); listener = nil }
    deinit { stop() }

    private func receive(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, error in
            guard let self else { connection.cancel(); return }
            let request = accumulated + (data ?? Data())
            guard request.count <= 16384, error == nil else { connection.cancel(); return }
            if let text = String(data: request, encoding: .utf8), text.contains("\r\n\r\n") {
                self.respond(connection, request: text)
            } else if !done { self.receive(connection, accumulated: request) }
            else { connection.cancel() }
        }
    }

    static func resourcePath(_ target: String) -> String? {
        guard target.hasPrefix("/"), !target.hasPrefix("//"),
              let decoded = target.split(separator: "?", maxSplits: 1).first?.removingPercentEncoding,
              !decoded.contains("\\"), !decoded.contains("\0"),
              !decoded.split(separator: "/").contains("..") else { return nil }
        return decoded == "/" ? "index.html" : String(decoded.dropFirst())
    }

    private func respond(_ connection: NWConnection, request: String) {
        let parts = request.components(separatedBy: "\r\n").first?.split(separator: " ") ?? []
        guard parts.count == 3, parts[0] == "GET", let relative = Self.resourcePath(String(parts[1])) else {
            send(connection, status: 400, data: Data(), mime: "text/plain"); return
        }
        if (relative == "api/mapstyle" || relative.hasPrefix("api/mapstyle/sprite/")), let mapOrigin {
            let target = String(parts[1])
            guard let url = URL(string: target, relativeTo: mapOrigin)?.absoluteURL,
                  url.host == mapOrigin.host, url.scheme == "https" else {
                send(connection, status: 400, data: Data(), mime: "text/plain"); return
            }
            let config = URLSessionConfiguration.ephemeral
            config.httpShouldSetCookies = false
            let session = URLSession(configuration: config, delegate: MapNoRedirect(), delegateQueue: nil)
            var mapRequest = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 25)
            mapRequest.httpShouldHandleCookies = false
            session.dataTask(with: mapRequest) { data, response, _ in
                defer { session.finishTasksAndInvalidate() }
                let http = response as? HTTPURLResponse
                self.send(connection, status: http?.statusCode ?? 503, data: data ?? Data(),
                          mime: http?.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream")
            }.resume()
            return
        }
        let file = root.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.resolvingSymlinksInPath().path + "/"),
              let data = try? Data(contentsOf: file) else {
            send(connection, status: 404, data: Data(), mime: "text/plain"); return
        }
        let types = ["html": "text/html; charset=utf-8", "js": "text/javascript", "mjs": "text/javascript",
                     "css": "text/css", "json": "application/json", "geojson": "application/geo+json",
                     "jpg": "image/jpeg", "png": "image/png", "svg": "image/svg+xml",
                     "ttf": "font/ttf", "woff2": "font/woff2", "wasm": "application/wasm"]
        send(connection, status: 200, data: data, mime: types[file.pathExtension] ?? "application/octet-stream")
    }

    private func send(_ connection: NWConnection, status: Int, data: Data, mime: String) {
        let safeMime = mime.components(separatedBy: .newlines).joined()
        let headers = "HTTP/1.1 \(status) Response\r\nContent-Length: \(data.count)\r\nContent-Type: \(safeMime)\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' blob:; font-src 'self'; frame-src 'none'; object-src 'none'\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(headers.utf8) + data, completion: .contentProcessed { _ in connection.cancel() })
    }
}

private final class MapNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
