import { existsSync } from "node:fs";

export const SAFE_HORIZONTAL_MARGIN_RATIO = 0.10;
export const TOP_SAFE_Y_RATIO = 0.14;
export const CTA_SAFE_Y_RATIO = 0.78;
export const DEFAULT_RENDER_FONT_PATH = process.platform === "win32"
  ? `${process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows"}\\Fonts\\arialbd.ttf`
  : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

type TextPlacement = "HEADLINE" | "CTA";
export type OverlayLayout = Readonly<{
  text: string;
  lines: readonly string[];
  fontSize: number;
  maxWidth: number;
  safeLeft: number;
  safeRight: number;
  y: number;
  placement: TextPlacement;
}>;

/** Keeps supported typography readable on the deterministic bundled worker font. */
export function normalizeOverlayTypography(input: string): string {
  return input
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function glyphWidth(character: string): number {
  if (character === " ") return 0.30;
  if (/[ilI1'.,:;!|]/.test(character)) return 0.34;
  if (/[MW@#%&]/.test(character)) return 0.92;
  if (/[A-Z0-9]/.test(character)) return 0.70;
  // Conservative fallback for non-ASCII names; we preserve the character instead of replacing it.
  return character.codePointAt(0)! > 0x7f ? 0.78 : 0.62;
}

export function estimateTextWidth(text: string, fontSize: number): number {
  return Math.ceil([...text].reduce((sum, character) => sum + glyphWidth(character), 0) * fontSize + 12);
}

function balancedLines(words: readonly string[], fontSize: number, maxWidth: number): readonly string[] | undefined {
  const single = words.join(" ");
  if (estimateTextWidth(single, fontSize) <= maxWidth) return [single];
  if (words.length < 2) return undefined;
  let best: readonly string[] | undefined;
  let bestBalance = Number.POSITIVE_INFINITY;
  for (let split = 1; split < words.length; split += 1) {
    const left = words.slice(0, split).join(" ");
    const right = words.slice(split).join(" ");
    const leftWidth = estimateTextWidth(left, fontSize);
    const rightWidth = estimateTextWidth(right, fontSize);
    if (leftWidth > maxWidth || rightWidth > maxWidth) continue;
    const balance = Math.abs(leftWidth - rightWidth);
    if (balance < bestBalance) { best = [left, right]; bestBalance = balance; }
  }
  return best;
}

export function planOverlay(text: string, width: number, height: number, placement: TextPlacement): OverlayLayout {
  const normalized = normalizeOverlayTypography(text);
  if (!normalized) throw new Error("Overlay text is empty after safe typography normalization.");
  const safeLeft = Math.round(width * SAFE_HORIZONTAL_MARGIN_RATIO);
  // Reserve the CTA box border inside the same safe area, rather than letting its padding cross the edge.
  const maxWidth = width - safeLeft * 2 - (placement === "CTA" ? 48 : 0);
  const words = normalized.split(" ");
  const startSize = placement === "HEADLINE" ? Math.round(width * 0.067) : Math.round(width * 0.056);
  const minimumSize = placement === "HEADLINE" ? Math.round(width * 0.039) : Math.round(width * 0.033);
  for (let fontSize = startSize; fontSize >= minimumSize; fontSize -= 2) {
    const lines = balancedLines(words, fontSize, maxWidth);
    if (lines) return { text: normalized, lines, fontSize, maxWidth, safeLeft, safeRight: width - safeLeft, y: Math.round(height * (placement === "HEADLINE" ? TOP_SAFE_Y_RATIO : CTA_SAFE_Y_RATIO)), placement };
  }
  throw new Error(`Overlay text is too long for the ${placement.toLowerCase()} safe area; use a shorter phrase.`);
}

export function assertRenderFont(fontPath: string): void {
  if (!fontPath || !existsSync(fontPath)) throw new Error("Configured render font is unavailable; reinstall the worker package or set a valid private font path.");
}