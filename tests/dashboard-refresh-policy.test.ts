import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard refresh policy", () => {
  it("does not start a periodic refresh loop and retains the explicit Refresh control", () => {
    const source = readFileSync("apps/web/src/main.tsx", "utf8");
    expect(source).not.toContain("setInterval(");
    expect(source).toContain('onClick={() => void refresh()}');
  });
});