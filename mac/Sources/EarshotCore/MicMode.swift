import CoreAudio

/// How the mic is recorded. Echo cancellation (voice processing) keeps the call coming out of the speakers
/// from becoming your lines; with headphones there is no echo, and on AirPods voice processing failed to
/// start (-10875), ran silent, and dropped them into call quality. So it's used only when the
/// call may play through speakers, and a failed start falls back to the plain mic.
public enum MicMode: Equatable, Sendable {
    case voiceProcessing
    case plain

    /// Built-in output data sources (`kAudioDevicePropertyDataSource`): 'hdpn' headphones, 'ispk' speakers.
    public static let headphonesSource: UInt32 = 0x6864_706E
    public static let speakersSource: UInt32 = 0x6973_706B

    public static func choose(outputTransport: UInt32?, outputSource: UInt32?) -> MicMode {
        switch outputTransport {
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE, kAudioDeviceTransportTypeUSB:
            return .plain
        case kAudioDeviceTransportTypeBuiltIn where outputSource == headphonesSource:
            return .plain
        default:
            return .voiceProcessing
        }
    }
}
