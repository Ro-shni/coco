public enum AverageHash {
    /// Hamming distance above which a window is considered visually changed.
    public static let changeThreshold = 3

    /// `gray` must be 64 grayscale pixels (an 8×8 thumbnail).
    public static func hash(gray: [UInt8]) -> UInt64 {
        precondition(gray.count == 64, "AverageHash needs 8x8 = 64 pixels")
        let average = gray.reduce(0) { $0 + Int($1) } / 64
        return gray.enumerated().reduce(UInt64(0)) { acc, item in
            Int(item.element) > average ? acc | (UInt64(1) << UInt64(item.offset)) : acc
        }
    }

    public static func distance(_ a: UInt64, _ b: UInt64) -> Int { (a ^ b).nonzeroBitCount }
}
