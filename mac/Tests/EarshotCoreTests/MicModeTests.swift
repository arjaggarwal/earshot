import CoreAudio
import Testing
@testable import EarshotCore

/// With AirPods, voice processing failed to start (-10875) or ran with no audio, and it drops
/// AirPods into call quality. Echo cancellation only matters when the call plays through speakers.
@Suite struct MicModeTests {
    @Test func headphonesUseThePlainMic() {
        #expect(MicMode.choose(outputTransport: kAudioDeviceTransportTypeBluetooth, outputSource: nil) == .plain)
        #expect(MicMode.choose(outputTransport: kAudioDeviceTransportTypeBluetoothLE, outputSource: nil) == .plain)
        #expect(MicMode.choose(outputTransport: kAudioDeviceTransportTypeUSB, outputSource: nil) == .plain)
        #expect(MicMode.choose(outputTransport: kAudioDeviceTransportTypeBuiltIn, outputSource: MicMode.headphonesSource) == .plain)
    }

    @Test func speakersAndUnknownOutputsCancelEcho() {
        #expect(MicMode.choose(outputTransport: kAudioDeviceTransportTypeBuiltIn, outputSource: MicMode.speakersSource) == .voiceProcessing)
        #expect(MicMode.choose(outputTransport: kAudioDeviceTransportTypeBuiltIn, outputSource: nil) == .voiceProcessing)
        #expect(MicMode.choose(outputTransport: kAudioDeviceTransportTypeHDMI, outputSource: nil) == .voiceProcessing)
        #expect(MicMode.choose(outputTransport: nil, outputSource: nil) == .voiceProcessing)
    }
}
