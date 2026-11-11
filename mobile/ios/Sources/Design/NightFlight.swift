import SwiftUI
import UIKit

/// "Night Flight" design tokens: the globe is the stage and native chrome only
/// surfaces when it is needed. Every native surface reads from here.
enum NightFlight {
    // MARK: Colour
    static let background = Color(hex: 0x07090F)
    static let backgroundUIColor = UIColor(red: 7 / 255, green: 9 / 255, blue: 15 / 255, alpha: 1)
    static let ink = Color(hex: 0xF2F4F8)
    static let muted = Color(hex: 0xA9B0BF)
    /// The single warm accent: selection, the current position and route highlight only.
    static let accent = Color(hex: 0xE8B65C)
    static let stroke = Color.white.opacity(0.08)
    /// Increase Contrast swaps the hairline for a visible edge.
    static let strokeHighContrast = Color.white.opacity(0.42)

    // MARK: Shape (three radii only)
    static let radiusLarge: CGFloat = 20
    static let radiusSmall: CGFloat = 14
    // Pill shapes use Capsule().

    // MARK: Spacing (4pt grid)
    static func grid(_ units: CGFloat) -> CGFloat { units * 4 }
    static let hitTarget: CGFloat = 44

    // MARK: Motion (two springs; Reduce Motion falls back to a short fade)
    static let snappy = Animation.spring(response: 0.32, dampingFraction: 0.86)
    static let gentle = Animation.spring(response: 0.5, dampingFraction: 0.9)
    static func motion(_ animation: Animation, reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.18) : animation
    }

    // MARK: Type (system text styles follow Dynamic Type and Bold Text)
    static func serif(_ style: Font.TextStyle) -> Font { .system(style, design: .serif) }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

/// Native shell colours. Kept as the historical name used across the app.
enum AtlasPalette {
    static let background = NightFlight.background
    static let ink = NightFlight.ink
    static let muted = NightFlight.muted
    static let accent = NightFlight.accent
    static let line = NightFlight.stroke
}

/// ultraThin material with an 8% white hairline. With Increase Contrast or
/// Reduce Transparency the surface becomes opaque and the edge visible.
struct NightFlightSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        let solid = contrast == .increased || reduceTransparency
        content
            .background {
                if solid { shape.fill(NightFlight.background) }
                else { shape.fill(.ultraThinMaterial) }
            }
            .overlay(shape.strokeBorder(contrast == .increased ? NightFlight.strokeHighContrast : NightFlight.stroke,
                                        lineWidth: contrast == .increased ? 1.5 : 1))
    }
}

extension View {
    func nightFlightSurface<S: InsettableShape>(_ shape: S) -> some View {
        modifier(NightFlightSurface(shape: shape))
    }
    func nightFlightSurface(radius: CGFloat = NightFlight.radiusLarge) -> some View {
        modifier(NightFlightSurface(shape: RoundedRectangle(cornerRadius: radius, style: .continuous)))
    }
}

/// Secondary text that becomes primary ink under Increase Contrast.
struct NightFlightMuted: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        content.foregroundStyle(contrast == .increased ? NightFlight.ink : NightFlight.muted)
    }
}

extension View {
    func nightFlightMuted() -> some View { modifier(NightFlightMuted()) }
}

/// Primary pill action: ink fill (gold is reserved for selection, not actions).
struct NightFlightPillButtonStyle: ButtonStyle {
    var prominent = true
    @Environment(\.colorSchemeContrast) private var contrast
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .padding(.horizontal, NightFlight.grid(5))
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(prominent ? NightFlight.background : NightFlight.ink)
            .background(Capsule().fill(prominent ? NightFlight.ink : Color.clear))
            .overlay(Capsule().strokeBorder(prominent ? Color.clear
                : (contrast == .increased ? NightFlight.strokeHighContrast : NightFlight.stroke.opacity(2.5)), lineWidth: 1))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}
