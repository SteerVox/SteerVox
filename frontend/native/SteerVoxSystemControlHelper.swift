import AppKit
import CoreGraphics
import Darwin
import Foundation
import IOKit.graphics

private enum HelperError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case let .message(message):
            return message
        }
    }
}

private enum MediaKey: Int32 {
    case playPause = 16
    case nextTrack = 17
    case previousTrack = 18
}

private enum BrightnessStep {
    static let increment: Float = 0.0625
}

private final class SystemControlHelper {
    func run(arguments: [String]) throws {
        guard let command = arguments.first else {
            throw HelperError.message("Missing system control command.")
        }

        switch command {
        case "play_pause":
            try postMediaKey(.playPause)
        case "pause_playback":
            try postMediaKey(.playPause)
        case "next_track":
            try postMediaKey(.nextTrack)
        case "previous_track":
            try postMediaKey(.previousTrack)
        case "brightness_up":
            try adjustBrightness(delta: BrightnessStep.increment)
        case "brightness_down":
            try adjustBrightness(delta: -BrightnessStep.increment)
        case "set_brightness_percent":
            guard arguments.count >= 2, let rawValue = Int(arguments[1]) else {
                throw HelperError.message("Missing brightness percentage.")
            }
            try setBrightness(percent: rawValue)
        default:
            throw HelperError.message("Unsupported system control command: \(command)")
        }
    }

    private func postMediaKey(_ key: MediaKey) throws {
        try postSystemDefinedKey(key.rawValue, isKeyDown: true)
        usleep(10_000)
        try postSystemDefinedKey(key.rawValue, isKeyDown: false)
    }

    private func postSystemDefinedKey(_ keyCode: Int32, isKeyDown: Bool) throws {
        let keyState: Int32 = isKeyDown ? 0xA : 0xB
        let flags = NSEvent.ModifierFlags(rawValue: 0xA00)
        let data1 = Int((keyCode << 16) | (keyState << 8))
        guard let event = NSEvent.otherEvent(
            with: .systemDefined,
            location: .zero,
            modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: 0,
            context: nil,
            subtype: 8,
            data1: data1,
            data2: -1
        )?.cgEvent else {
            throw HelperError.message("Unable to create the macOS media transport event.")
        }

        event.post(tap: .cghidEventTap)
    }

    private func adjustBrightness(delta: Float) throws {
        let service = try locateMainDisplayService()
        defer { IOObjectRelease(service) }

        let current = try readBrightness(from: service)
        let next = max(0.0, min(1.0, current + delta))
        try writeBrightness(next, to: service)
    }

    private func setBrightness(percent: Int) throws {
        let service = try locateMainDisplayService()
        defer { IOObjectRelease(service) }

        let clampedPercent = max(0, min(100, percent))
        let target = Float(clampedPercent) / 100.0
        try writeBrightness(target, to: service)
    }

    private func locateMainDisplayService() throws -> io_service_t {
        let displayId = CGMainDisplayID()
        let vendorId = CGDisplayVendorNumber(displayId)
        let modelId = CGDisplayModelNumber(displayId)
        let serialNumber = CGDisplaySerialNumber(displayId)

        guard let matching = IOServiceMatching("IODisplayConnect") else {
            throw HelperError.message("Unable to inspect the main display.")
        }

        var iterator: io_iterator_t = 0
        let matchingResult = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator)
        guard matchingResult == KERN_SUCCESS else {
            throw HelperError.message("Unable to inspect the main display.")
        }
        defer { IOObjectRelease(iterator) }

        while true {
            let service = IOIteratorNext(iterator)
            if service == 0 {
                break
            }

            let info = IODisplayCreateInfoDictionary(service, IOOptionBits(kIODisplayOnlyPreferredName)).takeRetainedValue() as NSDictionary
            let serviceVendorId = (info[kDisplayVendorID] as? NSNumber)?.uint32Value
            let serviceModelId = (info[kDisplayProductID] as? NSNumber)?.uint32Value
            let serviceSerialNumber = (info[kDisplaySerialNumber] as? NSNumber)?.uint32Value ?? 0

            let serialMatches = serialNumber == 0 || serviceSerialNumber == 0 || serviceSerialNumber == serialNumber
            if serviceVendorId == vendorId && serviceModelId == modelId && serialMatches {
                return service
            }

            IOObjectRelease(service)
        }

        throw HelperError.message("The main display does not expose brightness control.")
    }

    private func readBrightness(from service: io_service_t) throws -> Float {
        var brightness: Float = 0.0
        let result = IODisplayGetFloatParameter(service, 0, kIODisplayBrightnessKey as CFString, &brightness)
        guard result == KERN_SUCCESS else {
            throw HelperError.message("The main display does not expose brightness control.")
        }
        return brightness
    }

    private func writeBrightness(_ brightness: Float, to service: io_service_t) throws {
        let result = IODisplaySetFloatParameter(service, 0, kIODisplayBrightnessKey as CFString, brightness)
        guard result == KERN_SUCCESS else {
            throw HelperError.message("The main display does not expose brightness control.")
        }
    }
}

@main
struct SteerVoxSystemControlHelperMain {
    static func main() {
        do {
            let helper = SystemControlHelper()
            try helper.run(arguments: Array(CommandLine.arguments.dropFirst()))
        } catch {
            let detail = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            FileHandle.standardError.write(Data("\(detail)\n".utf8))
            exit(1)
        }
    }
}
