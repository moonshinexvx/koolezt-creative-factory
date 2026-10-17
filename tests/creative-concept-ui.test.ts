import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("background Creative Concept UI",()=>{
  it("shows active and safe terminal states while withholding duplicate generation",async()=>{
    const source=await readFile(new URL("../apps/web/src/main.tsx",import.meta.url),"utf8");
    expect(source).toContain('selected.state === "CONCEPT_GENERATING"');
    expect(source).toContain("Generating Creative Concept");
    expect(source).toContain("Waiting for provider");
    expect(source).toContain("Refresh Status");
    expect(source).toContain("Submission outcome is unknown; automatic retry is disabled.");
    expect(source).toContain("The known provider result is no longer retrievable; automatic resubmission is disabled.");
    expect(source).toContain("Start New Explicit Creative Concept Attempt");
    expect(source).toContain("conceptGenerationStatus.validationFindings");
    expect(source).toContain('className="validation-findings"');
  });
});

  it("shows explicit Product visual-authority review and feasibility reasons",async()=>{
    const source=await readFile(new URL("../apps/web/src/main.tsx",import.meta.url),"utf8");
    expect(source).toContain("Personalized-Product Visual Authority");
    expect(source).toContain("Immutable Product structure");
    expect(source).toContain("Authorized personalization fields");
    expect(source).toContain("I confirm these visual permissions");
    expect(source).toContain("Execution feasibility:");
  });
