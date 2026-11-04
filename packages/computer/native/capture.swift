// mountains-capture: a ScreenCaptureKit stream of each window Mountains works in, and its current frame on
// request. Only those windows are captured (no parent or child windows, never the desktop or audio). While a
// stream runs, macOS shows that the screen is being recorded, so the user can see when Mountains is watching.
// A stream unused for a minute stops; all stop at end of input.
//
// Input, one JSON object per line: {"id":1,"op":"frame","window":123,"file":"/path/out.png","deadline":1760000000000}
// Output, one per line: {"id":1,"ok":true,"width":1280,"height":720,"capturedAt":1760000000000} or {"id":1,"ok":false,"error":"..."}
// capturedAt is when the window was last seen as the image shows it, always after the request arrived.
import AppKit
import CoreImage
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

func failure(_ message: String) -> NSError {
	NSError(domain: "mountains.capture", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
func now() -> Double { Date().timeIntervalSince1970 * 1000 }

/// ScreenCaptureKit calls can stay unanswered (seen on a window that changed while a stream started). Waiting
/// for one blocks every later request, so each gets a limit; a call that misses it is left behind.
final class Once: @unchecked Sendable {
	private let lock = NSLock()
	private var done = false
	func claim() -> Bool { lock.withLock { if done { return false }; done = true; return true } }
}
func within<T>(_ seconds: Double, _ what: String, _ operation: @escaping () async throws -> T) async throws -> T {
	try await withCheckedThrowingContinuation { (k: CheckedContinuation<T, Error>) in
		let once = Once()
		Task { do { let value = try await operation(); if once.claim() { k.resume(returning: value) } } catch { if once.claim() { k.resume(throwing: error) } } }
		Task { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)); if once.claim() { k.resume(throwing: failure("\(what) did not answer in time")) } }
	}
}

@available(macOS 14.2, *)
func configuration(for target: SCWindow, filter: SCContentFilter) -> SCStreamConfiguration {
	let config = SCStreamConfiguration()
	let scale = CGFloat(filter.pointPixelScale)
	config.width = max(2, Int(target.frame.width * scale))
	config.height = max(2, Int(target.frame.height * scale))
	config.includeChildWindows = false
	config.ignoreShadowsSingleWindow = true
	config.showsCursor = false
	config.capturesAudio = false
	return config
}

@available(macOS 14.2, *)
final class Watch: NSObject, SCStreamOutput, SCStreamDelegate {
	let window: CGWindowID
	let size: CGSize
	var stream: SCStream?
	let lock = NSLock()
	var latest: CVPixelBuffer?
	/// When the stream last reported on the window: a new frame, or that nothing changed since the last one.
	var seen = 0.0
	var stopped = false
	var used = Date()

	init(window: CGWindowID, size: CGSize) { self.window = window; self.size = size }

	func start(_ target: SCWindow) async throws {
		let filter = SCContentFilter(desktopIndependentWindow: target)
		let config = configuration(for: target, filter: filter)
		config.minimumFrameInterval = CMTime(value: 1, timescale: 5)
		config.queueDepth = 3
		config.pixelFormat = kCVPixelFormatType_32BGRA
		let stream = SCStream(filter: filter, configuration: config, delegate: self)
		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
		try await stream.startCapture()
		self.stream = stream
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen,
			let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
			let raw = info[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return }
		if status == .complete, let buffer = sample.imageBuffer { lock.withLock { latest = buffer; seen = now() } }
		else if status == .idle { lock.withLock { if latest != nil { seen = now() } } }
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) { lock.withLock { stopped = true } }

	func stop() async { try? await stream?.stopCapture(); stream = nil; lock.withLock { stopped = true } }
}

let ci = CIContext()
var watches: [CGWindowID: AnyObject] = [:]

func save(_ image: CGImage, _ file: String) throws {
	guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: file) as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw failure("cannot create the image file") }
	CGImageDestinationAddImage(destination, image, nil)
	guard CGImageDestinationFinalize(destination) else { throw failure("cannot write the image") }
}

@available(macOS 14.2, *)
func frame(window: CGWindowID, file: String, deadline: Double) async throws -> [String: Any] {
	let asked = now()
	guard asked < deadline else { throw failure("capture expired before it started") }
	let content = try await within(3, "the list of windows") { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
	guard let target = content.windows.first(where: { $0.windowID == window }) else { throw failure("window \(window) is unavailable") }
	// A stream that stopped, or one made for the window's old size, starts over.
	var watch = watches[window] as? Watch
	if let w = watch, w.lock.withLock({ w.stopped }) || w.size != target.frame.size { _ = try? await within(2, "stopping a stream") { await w.stop() }; watches[window] = nil; watch = nil }
	if watch == nil {
		let fresh = Watch(window: window, size: target.frame.size)
		try await within(4, "starting a stream") { try await fresh.start(target) }
		watches[window] = fresh
		watch = fresh
	}
	let w = watch!
	w.used = Date()
	// The image must show the window as it is now: wait for the stream to report after this request came in.
	while now() < min(deadline, asked + 400) {
		if w.lock.withLock({ w.seen > asked }) { break }
		try await Task.sleep(nanoseconds: 25_000_000)
	}
	let (buffer, seen) = w.lock.withLock { (w.latest, w.seen) }
	let image: CGImage
	let capturedAt: Double
	if let buffer, seen > asked {
		let frame = CIImage(cvPixelBuffer: buffer)
		guard let cg = ci.createCGImage(frame, from: frame.extent) else { throw failure("cannot read the frame") }
		image = cg; capturedAt = seen
	} else {
		// A quiet stream: take one fresh image of the same window instead of trusting an older frame.
		let filter = SCContentFilter(desktopIndependentWindow: target)
		image = try await within(4, "a window image") { try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration(for: target, filter: filter)) }
		capturedAt = now()
	}
	guard now() < deadline else { throw failure("capture expired; no image receipt was published") }
	try save(image, file)
	return ["width": image.width, "height": image.height, "capturedAt": capturedAt]
}

func reply(_ object: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
	FileHandle.standardOutput.write(data + Data("\n".utf8))
}

// Streams nobody asked for in a minute stop, and the recording indicator goes with them.
Task { @MainActor in
	while true {
		try? await Task.sleep(nanoseconds: 10_000_000_000)
		guard #available(macOS 14.2, *) else { continue }
		for (id, object) in watches { if let w = object as? Watch, Date().timeIntervalSince(w.used) > 60 { watches[id] = nil; _ = try? await within(2, "stopping a stream") { await w.stop() } } }
	}
}

Task { @MainActor in
	do {
		for try await line in FileHandle.standardInput.bytes.lines {
			guard let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
			let id = command["id"] ?? NSNull()
			do {
				guard #available(macOS 14.2, *) else { throw failure("Exact-window images require macOS 14.2 or later to leave out parent and child windows") }
				guard command["op"] as? String == "frame", let window = command["window"] as? Int, let file = command["file"] as? String else { throw failure("unknown capture command") }
				let deadline = command["deadline"] as? Double ?? now() + 10_000
				var result = try await frame(window: CGWindowID(window), file: file, deadline: deadline)
				result["id"] = id; result["ok"] = true
				reply(result)
			} catch { reply(["id": id, "ok": false, "error": error.localizedDescription]) }
		}
	} catch { /* input closed */ }
	if #available(macOS 14.2, *) { for object in watches.values { if let w = object as? Watch { _ = try? await within(1, "stopping a stream") { await w.stop() } } } }
	exit(0)
}
application.run()
