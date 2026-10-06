import { describe, expect, it } from "vitest";
import { ARTIFACT_GUIDANCE } from "../../src/language/artifact-guidance";
import { parseConceptual } from "../../src/language/conceptual/analyze";
import { parseDatabase } from "../../src/language/database/analyze";
import { analyzeResource } from "../../src/domain/project/resource-analysis";

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
      expect(analyzeResource({ id: "canonical-concept", projectId: "p", path: "canonical.concept", type: "conceptual", title: "Canonical" }, source).diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
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
      expect(analyzeResource({ id: "canonical-database", projectId: "p", path: "canonical.dbschema", type: "database", title: "Canonical" }, source).diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    }
    expect(ARTIFACT_GUIDANCE).toContain("identity remains exact-name based");
    expect(ARTIFACT_GUIDANCE).toContain("line comments use `#`");
    expect(ARTIFACT_GUIDANCE).toContain("`//` is not source syntax");
    expect(ARTIFACT_GUIDANCE).toContain("Every Database column must explicitly end in `nullable` or `not-null`");
  });
});
