import { describe, expect, it } from "vitest";
import { ARTIFACT_GUIDANCE } from "../../src/language/artifact-guidance";
import { parseConceptual } from "../../src/language/conceptual/analyze";
import { parseDatabase } from "../../src/language/database/analyze";

describe("agent artifact examples", () => {
  it("parses every canonical Conceptual example through production analysis", () => {
    const section = ARTIFACT_GUIDANCE.split("## Conceptual Diagram")[1].split("## Database Diagram")[0];
    const sources = [...section.matchAll(/```text\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(sources).toHaveLength(3);
    for (const source of sources) {
      const result = parseConceptual(source);
      expect(result.ast).not.toBeNull();
      expect(result.model).not.toBeNull();
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    }
    for (const source of ['concept customer "Customer"', 'concept customer "Account Holder"']) {
      expect(parseConceptual(source).diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    }
    expect(ARTIFACT_GUIDANCE).toContain('concept customer "Account Holder"');
  });

  it("parses every canonical Database example through production analysis", () => {
    const section = ARTIFACT_GUIDANCE.split("## Database Diagram")[1].split("## Current product capabilities")[0];
    const sources = [...section.matchAll(/```text\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(sources).toHaveLength(5);
    for (const source of sources) {
      const result = parseDatabase(source);
      expect(result.ast).not.toBeNull();
      expect(result.model).not.toBeNull();
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    }
    expect(ARTIFACT_GUIDANCE).toContain("identity remains exact-name based");
  });
});
