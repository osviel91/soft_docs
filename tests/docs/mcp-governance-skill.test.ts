import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "../..");
const corePath = path.join(root, "docs/skills/mcp-governance.md");
const skillPath = path.join(root, "skills/softdocs-mcp-governance/SKILL.md");

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Software Docs MCP governance skill file integrity", () => {
  it("resolves the canonical protocol relative to the portable skill, independent of cwd", async () => {
    const skill = await readFile(skillPath, "utf8");
    const relativeLink = skill.match(
      /\]\((\.\.\/\.\.\/docs\/skills\/mcp-governance\.md)\)/,
    )?.[1];

    expect(relativeLink).toBeDefined();
    expect(path.resolve(path.dirname(skillPath), relativeLink!)).toBe(corePath);
    expect(await readFile(corePath, "utf8")).toContain(
      "# Software Docs MCP Governance",
    );
    expect(skill).toMatch(
      /^---\nname: softdocs-mcp-governance\ndescription: .+\n---/,
    );
  });

  it.each([
    [
      ".agents/skills/softdocs-mcp-governance/SKILL.md",
      "../../../skills/softdocs-mcp-governance/SKILL.md",
    ],
    [
      ".claude/skills/softdocs-mcp-governance/SKILL.md",
      "../../../skills/softdocs-mcp-governance/SKILL.md",
    ],
  ])(
    "resolves the %s adapter to the canonical loader",
    async (adapterPath, relativeLink) => {
      const adapter = await read(adapterPath);
      expect(adapter).toContain(`](${relativeLink})`);
      expect(
        path.resolve(path.dirname(path.join(root, adapterPath)), relativeLink),
      ).toBe(skillPath);
      expect(adapter).not.toContain(
        "Technical permission, workflow eligibility",
      );
    },
  );

  it("keeps AGENTS concise and points at the protocol and canonical skill", async () => {
    const agents = await read("AGENTS.md");
    expect(agents).toContain("skills/softdocs-mcp-governance/SKILL.md");
    expect(agents).toContain("docs/skills/mcp-governance.md");
    expect(agents).toContain("docs/documentation-model.md");
  });

  it("keeps the fallback fail-closed when the normative core cannot be found", async () => {
    const skill = await readFile(skillPath, "utf8");
    expect(skill).toContain(
      "locate the target repository root by finding its `AGENTS.md`",
    );
    expect(skill).toContain("Do not reconstruct missing rules from memory.");
    expect(skill).toContain(
      "Until the protocol is available, limit work to safe read-only discovery",
    );
    expect(skill).toContain("ask/report the blocker before any write");
    expect(skill).not.toContain("assume the protocol was loaded");
  });

  it("keeps the normative manual in one file rather than copying it into loaders", async () => {
    const loaderPaths = [
      "skills/softdocs-mcp-governance/SKILL.md",
      ".agents/skills/softdocs-mcp-governance/SKILL.md",
      ".claude/skills/softdocs-mcp-governance/SKILL.md",
      "AGENTS.md",
    ];
    const uniqueRule =
      "Technical permission, workflow eligibility, and explicit user authorization";
    const copies = await Promise.all(loaderPaths.map(read));

    expect(
      copies.filter((content) => content.includes(uniqueRule)),
    ).toHaveLength(0);
    expect(await readFile(corePath, "utf8")).toContain(uniqueRule);
  });
});

describe("normative governance contract", () => {
  const cases = [
    [
      "1 read-only architecture query",
      /Read relevant SHARED resources before making architectural claims/,
    ],
    [
      "2 Event Flow analysis",
      /Topology \(`publishes`, `consumes`, producers, consumers\) is not causal linkage/,
    ],
    ["3 OPEN proposal navigation", /pass it to the proposal detail operation/],
    [
      "4 PROMOTED with recorded open",
      /A persisted `open` status may coexist with effective\/lifecycle `PROMOTED`/,
    ],
    ["5 SUPERSEDED successor", /follow the explicit successor\/lineage ID/],
    [
      "6 pending promotion",
      /`COMMITTED_COMPLETION_PENDING` means commitment with completion work pending/,
    ],
    ["7 inconsistent data", /report unresolved conflicts explicitly/],
    ["8 private MY WORK", /MY WORK is an owner's private tentative view/],
    [
      "9 code change without documentation authority",
      /A code-change request authorizes code changes only/,
    ],
    [
      "10 promoted documentation without production evidence",
      /SHARED is authoritative project knowledge, not proof that runtime matches it/,
    ],
    [
      "11 text-only MCP",
      /Interpret the returned text when that is all the client supplies/,
    ],
    [
      "12 unauthorized operation",
      /If explicit authorization, required permissions, a supported tool, or current-state evidence is missing, stop before writing/,
    ],
  ] as const;

  it.each(cases)(
    "documents acceptance boundary: %s",
    async (_name, requirement) => {
      const core = await readFile(corePath, "utf8");
      expect(core).toMatch(requirement);
    },
  );

  it("defers documentation semantics to the canonical model", async () => {
    const core = await readFile(corePath, "utf8");
    expect(core).toContain(
      "`docs/documentation-model.md` is authoritative for representation and documentation semantics.",
    );
  });
});

describe("MCP response interpretation fixtures", () => {
  it("keeps synthetic response examples aligned with the protocol without claiming model behavior", async () => {
    const core = await readFile(corePath, "utf8");
    const fixtures = JSON.parse(
      await read("tests/docs/fixtures/mcp-governance-responses.json"),
    ) as Array<{
      case: string;
      textOnly: boolean;
      expected: string;
    }>;

    expect(fixtures.map((item) => item.case)).toEqual([
      "proposal-open",
      "promoted-recorded-open",
      "superseded-with-successor",
      "promotion-pending",
      "inconsistent-diagnostics",
      "text-only-error",
      "shared-not-production",
    ]);
    for (const fixture of fixtures) {
      expect(core, fixture.case).toContain(fixture.expected);
    }
    expect(fixtures.some((item) => item.textOnly)).toBe(true);
    // These are contract/fixture checks only; no language model is executed.
  });
});
