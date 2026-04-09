import AVFoundation
import Foundation
import Speech

final class SpeechSession {
    let sessionId: String
    let recognizer: SFSpeechRecognizer
    let request: SFSpeechAudioBufferRecognitionRequest
    var task: SFSpeechRecognitionTask?

    init(sessionId: String, recognizer: SFSpeechRecognizer, request: SFSpeechAudioBufferRecognitionRequest) {
        self.sessionId = sessionId
        self.recognizer = recognizer
        self.request = request
    }
}

@MainActor
final class SpeechHelper {
    private var session: SpeechSession?

    func handle(line: String) {
        guard let data = line.data(using: .utf8) else {
            emit([
                "event": "error",
                "error": "Invalid command encoding."
            ])
            return
        }

        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let payload = object as? [String: Any],
            let command = payload["command"] as? String
        else {
            emit([
                "event": "error",
                "error": "Invalid command payload."
            ])
            return
        }

        switch command {
        case "start":
            startSession(
                sessionId: payload["sessionId"] as? String,
                mode: payload["mode"] as? String
            )
        case "appendChunk":
            appendChunk(
                sessionId: payload["sessionId"] as? String,
                base64: payload["pcmS16leBase64"] as? String,
                sampleRate: payload["sampleRate"] as? Double
            )
        case "stop":
            stopSession(sessionId: payload["sessionId"] as? String)
        case "cancel":
            cancelSession(sessionId: payload["sessionId"] as? String)
        default:
            emit([
                "event": "error",
                "error": "Unsupported command: \(command)"
            ])
        }
    }

    private func startSession(sessionId: String?, mode: String?) {
        guard let sessionId, !sessionId.isEmpty else {
            emit([
                "event": "error",
                "error": "Missing session id."
            ])
            return
        }

        cancelCurrentSession()
        authorizeIfNeeded { [weak self] authorized in
            guard let self else { return }
            guard authorized else {
                self.emit([
                    "event": "error",
                    "sessionId": sessionId,
                    "error": "Speech recognition permission was denied."
                ])
                return
            }

            guard let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable else {
                self.emit([
                    "event": "error",
                    "sessionId": sessionId,
                    "error": "Speech recognition is unavailable on this Mac."
                ])
                return
            }

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if #available(macOS 13.0, *) {
                request.addsPunctuation = false
            }

            let session = SpeechSession(sessionId: sessionId, recognizer: recognizer, request: request)
            session.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }

                    if let error {
                        self.emit([
                            "event": "error",
                            "sessionId": sessionId,
                            "error": error.localizedDescription
                        ])
                        if self.session?.sessionId == sessionId {
                            self.cancelCurrentSession()
                        }
                        return
                    }

                    guard let result else {
                        return
                    }

                    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        self.emit([
                            "event": result.isFinal ? "final" : "partial",
                            "sessionId": sessionId,
                            "text": text
                        ])
                    }

                    if result.isFinal, self.session?.sessionId == sessionId {
                        self.session = nil
                    }
                }
            }

            self.session = session
            self.emit([
                "event": "started",
                "sessionId": sessionId,
                "mode": mode ?? "dictation"
            ])
        }
    }

    private func appendChunk(sessionId: String?, base64: String?, sampleRate: Double?) {
        guard
            let activeSession = session,
            let sessionId,
            activeSession.sessionId == sessionId
        else {
            return
        }

        guard
            let base64,
            let pcmData = Data(base64Encoded: base64),
            !pcmData.isEmpty
        else {
            return
        }

        guard let buffer = makeAudioBuffer(from: pcmData, sampleRate: sampleRate ?? 16_000) else {
            emit([
                "event": "error",
                "sessionId": sessionId,
                "error": "Unable to decode live audio chunk."
            ])
            return
        }

        activeSession.request.append(buffer)
    }

    private func stopSession(sessionId: String?) {
        guard
            let activeSession = session,
            let sessionId,
            activeSession.sessionId == sessionId
        else {
            return
        }

        activeSession.request.endAudio()
        emit([
            "event": "stopped",
            "sessionId": sessionId
        ])
    }

    private func cancelSession(sessionId: String?) {
        guard
            let activeSession = session,
            let sessionId,
            activeSession.sessionId == sessionId
        else {
            return
        }

        cancelCurrentSession()
        emit([
            "event": "stopped",
            "sessionId": sessionId
        ])
    }

    private func cancelCurrentSession() {
        session?.task?.cancel()
        session = nil
    }

    private func authorizeIfNeeded(completion: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            emitPermission(status: "authorized", detail: nil)
            completion(true)
        case .denied:
            emitPermission(status: "denied", detail: "Speech recognition permission was denied.")
            completion(false)
        case .restricted:
            emitPermission(status: "restricted", detail: "Speech recognition is restricted on this Mac.")
            completion(false)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { status in
                Task { @MainActor in
                    switch status {
                    case .authorized:
                        self.emitPermission(status: "authorized", detail: nil)
                        completion(true)
                    case .denied:
                        self.emitPermission(status: "denied", detail: "Speech recognition permission was denied.")
                        completion(false)
                    case .restricted:
                        self.emitPermission(status: "restricted", detail: "Speech recognition is restricted on this Mac.")
                        completion(false)
                    case .notDetermined:
                        self.emitPermission(status: "not_determined", detail: "Speech recognition permission is still pending.")
                        completion(false)
                    @unknown default:
                        self.emitPermission(status: "unavailable", detail: "Speech recognition authorization returned an unknown state.")
                        completion(false)
                    }
                }
            }
        @unknown default:
            emitPermission(status: "unavailable", detail: "Speech recognition authorization is unavailable.")
            completion(false)
        }
    }

    private func emitPermission(status: String, detail: String?) {
        var payload: [String: Any] = [
            "event": "permission",
            "status": status
        ]
        if let detail {
            payload["detail"] = detail
        }
        emit(payload)
    }

    private func makeAudioBuffer(from pcmData: Data, sampleRate: Double) -> AVAudioPCMBuffer? {
        let sampleCount = pcmData.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else {
            return nil
        }

        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        ) else {
            return nil
        }

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount)) else {
            return nil
        }

        buffer.frameLength = AVAudioFrameCount(sampleCount)
        guard let channelData = buffer.floatChannelData?[0] else {
            return nil
        }

        pcmData.withUnsafeBytes { rawBuffer in
            let samples = rawBuffer.bindMemory(to: Int16.self)
            for index in 0..<sampleCount {
                let sample = samples[index]
                let normalized = sample == Int16.min
                    ? -1.0
                    : Float(sample) / Float(Int16.max)
                channelData[index] = normalized
            }
        }

        return buffer
    }

    private func emit(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload) else {
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

@main
struct SteerVoxSpeechHelperMain {
    static func main() {
        let helper = SpeechHelper()

        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                Task { @MainActor in
                    helper.handle(line: line)
                }
            }
            exit(0)
        }

        RunLoop.main.run()
    }
}
