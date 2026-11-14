import Testing
@testable import CocoCore

@Suite struct CharacterLookTests {
    @Test func curious() {
        let look = CharacterLook.look(mood: .curious, speaking: false, blinking: false)
        #expect(look == CharacterLook(leftEye: .open, rightEye: .open, mouth: .smile, star: .bright, antenna: .up, extras: [], blush: 0.6))
    }

    @Test func focused() {
        let look = CharacterLook.look(mood: .focused, speaking: false, blinking: false)
        #expect(look == CharacterLook(leftEye: .halfLid, rightEye: .halfLid, mouth: .soft, star: .dim, antenna: .up, extras: [], blush: 0.6))
    }

    @Test func worried() {
        let look = CharacterLook.look(mood: .worried, speaking: false, blinking: false)
        #expect(look == CharacterLook(leftEye: .wide, rightEye: .wide, mouth: .wavy, star: .amber, antenna: .up, extras: [.sweat], blush: 0.25))
    }

    @Test func bored() {
        let look = CharacterLook.look(mood: .bored, speaking: false, blinking: false)
        #expect(look == CharacterLook(leftEye: .halfLid, rightEye: .halfLid, mouth: .flat, star: .dim, antenna: .droop, extras: [], blush: 0.6))
    }

    @Test func sleepy() {
        let look = CharacterLook.look(mood: .sleepy, speaking: false, blinking: false)
        #expect(look == CharacterLook(leftEye: .closed, rightEye: .closed, mouth: .o, star: .dim, antenna: .up, extras: [.zzz], blush: 0.6))
    }

    @Test func speakingWinksWithBigSmileForCalmMoods() {
        let speaking = CharacterLook(leftEye: .open, rightEye: .wink, mouth: .bigSmile, star: .bright, antenna: .up, extras: [], blush: 0.6)
        for mood in [Mood.curious, .focused, .bored] {
            #expect(CharacterLook.look(mood: mood, speaking: true, blinking: false) == speaking)
        }
    }

    @Test func speakingDoesNotOverrideWorriedOrSleepy() {
        for mood in [Mood.worried, .sleepy] {
            #expect(CharacterLook.look(mood: mood, speaking: true, blinking: false)
                    == CharacterLook.look(mood: mood, speaking: false, blinking: false))
        }
    }

    @Test func blinkingClosesOpenWideAndHalfLidEyes() {
        for mood in [Mood.curious, .focused, .worried, .bored] {
            let look = CharacterLook.look(mood: mood, speaking: false, blinking: true)
            #expect(look.leftEye == .closed)
            #expect(look.rightEye == .closed)
            let awake = CharacterLook.look(mood: mood, speaking: false, blinking: false)
            #expect(look.mouth == awake.mouth)
            #expect(look.star == awake.star)
        }
    }

    @Test func blinkingKeepsTheWink() {
        let look = CharacterLook.look(mood: .curious, speaking: true, blinking: true)
        #expect(look.leftEye == .closed)
        #expect(look.rightEye == .wink)
    }

    @Test func blinkingLeavesSleepyUnchanged() {
        #expect(CharacterLook.look(mood: .sleepy, speaking: false, blinking: true)
                == CharacterLook.look(mood: .sleepy, speaking: false, blinking: false))
    }

    @Test func speakingFaceOnlyForCalmMoods() {
        #expect(CharacterLook.showsSpeakingFace(mood: .curious, speaking: true))
        #expect(CharacterLook.showsSpeakingFace(mood: .bored, speaking: true))
        #expect(!CharacterLook.showsSpeakingFace(mood: .worried, speaking: true))
        #expect(!CharacterLook.showsSpeakingFace(mood: .sleepy, speaking: true))
        #expect(!CharacterLook.showsSpeakingFace(mood: .curious, speaking: false))
    }
}

@Suite struct BlinkScheduleTests {
    @Test func normalMoodsBlinkEveryThreeToSixSeconds() {
        for mood in [Mood.curious, .focused, .worried] {
            var schedule = BlinkSchedule(seed: 42)
            for _ in 0..<200 {
                let interval = schedule.nextInterval(mood: mood)
                #expect(interval >= 3 && interval <= 6)
            }
        }
    }

    @Test func boredBlinksSlowlyEveryOnePointEightToThreeSeconds() {
        var schedule = BlinkSchedule(seed: 7)
        for _ in 0..<200 {
            let interval = schedule.nextInterval(mood: .bored)
            #expect(interval >= 1.8 && interval <= 3)
        }
    }

    @Test func sleepyNeverBlinks() {
        var schedule = BlinkSchedule(seed: 1)
        for _ in 0..<200 { #expect(schedule.nextInterval(mood: .sleepy) == .infinity) }
    }

    @Test func sameSeedGivesSameSequence() {
        var a = BlinkSchedule(seed: 99), b = BlinkSchedule(seed: 99), c = BlinkSchedule(seed: 100)
        let first = (0..<200).map { _ in a.nextInterval(mood: .curious) }
        let second = (0..<200).map { _ in b.nextInterval(mood: .curious) }
        let other = (0..<200).map { _ in c.nextInterval(mood: .curious) }
        #expect(first == second)
        #expect(first != other)
    }

    @Test func intervalsVary() {
        var schedule = BlinkSchedule(seed: 5)
        let draws = Set((0..<50).map { _ in schedule.nextInterval(mood: .curious) })
        #expect(draws.count > 40)
    }

    @Test func blinkLastsTwelveHundredthsOfASecond() {
        #expect(BlinkSchedule.blinkDuration == 0.12)
    }
}
