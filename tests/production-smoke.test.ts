import { describe, expect, it } from "vitest";
import { assertSafeSmokeProviderModes, parseEnvironmentFile } from "../scripts/production-smoke.js";

describe("production smoke configuration", () => {
  it("parses raw environment values without shell expansion", () => {
    const environment = parseEnvironmentFile("DATABASE_URL=postgresql://user:pa$$word@localhost/db\nCREATIVE_PROVIDER=fake\n");
    expect(environment.DATABASE_URL).toBe("postgresql://user:pa$$word@localhost/db");
  });

  it("only permits the fake-provider production smoke configuration", () => {
    expect(() => assertSafeSmokeProviderModes({
      CREATIVE_PROVIDER: "fake",
      VIDEO_PROVIDER: "fake",
      VOICE_PROVIDER: "fake",
      COMPOSITION_PROVIDER: "fake",
      EXTERNAL_MEDIA_DELIVERY_PROVIDER: "disabled"
    })).not.toThrow();
    expect(() => assertSafeSmokeProviderModes({
      CREATIVE_PROVIDER: "openai",
      VIDEO_PROVIDER: "fake",
      VOICE_PROVIDER: "fake",
      COMPOSITION_PROVIDER: "fake",
      EXTERNAL_MEDIA_DELIVERY_PROVIDER: "disabled"
    })).toThrow("CREATIVE_PROVIDER");
  });
});
