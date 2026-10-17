import { describe, expect, it } from "vitest";
import { normalizeOverlayTypography, planOverlay, SAFE_HORIZONTAL_MARGIN_RATIO } from "../apps/render-worker/src/overlay.js";

describe("worker overlay layout", () => {
  it("normalizes unsupported smart punctuation without changing ordinary words", () => {
    expect(normalizeOverlayTypography("Your pet’s\u00A0Christmas — keepsake")).toBe("Your pet's Christmas - keepsake");
    expect(normalizeOverlayTypography("“Milo”’s ornament")).toBe('"Milo"\'s ornament');
  });

  it("keeps a long headline inside the 10 percent horizontal safe area using at most two balanced lines", () => {
    const layout = planOverlay("Your pet's name belongs on the tree", 1080, 1920, "HEADLINE");
    expect(layout.safeLeft).toBe(108);
    expect(layout.safeRight).toBe(972);
    expect(layout.maxWidth).toBeLessThanOrEqual(864);
    expect(layout.lines).toHaveLength(2);
    expect(layout.fontSize).toBeGreaterThanOrEqual(42);
    expect(layout.y).toBeGreaterThan(0);
  });

  it("keeps concise CTA text in the lower safe area with room for its background box", () => {
    const layout = planOverlay("Create yours today", 1080, 1920, "CTA");
    expect(layout.maxWidth).toBeLessThan(1080 - 2 * Math.round(1080 * SAFE_HORIZONTAL_MARGIN_RATIO));
    expect(layout.y).toBeLessThan(1920);
    expect(layout.lines.length).toBeLessThanOrEqual(2);
    // FFmpeg places the background box's 24px padding inside the 108px safe margin.
    expect(layout.safeLeft + 24).toBe(132);
  });

  it("rejects a single unbreakable phrase that would require unreadably small text", () => {
    expect(() => planOverlay("W".repeat(100), 1080, 1920, "HEADLINE")).toThrow("too long");
  });

  it("does not allow control newlines to create unvalidated extra lines", () => {
    const layout = planOverlay("A safe\nheadline\tfor Milo", 1080, 1920, "HEADLINE");
    expect(layout.lines.length).toBeLessThanOrEqual(2);
    expect(layout.text).not.toMatch(/[\r\n\t]/);
  });
});