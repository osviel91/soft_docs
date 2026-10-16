---
name: softdocs-mcp-governance
description: Use when an agent reads or changes Software Docs Manager through MCP, including architecture queries, Event Flow analysis, MY WORK, proposals, reviews, promotion, or questions about SHARED and production state.
---

# Software Docs MCP Governance skill

Activate this skill before using Software Docs Manager MCP or making claims about its project knowledge.

1. Read the normative protocol at [`../../docs/skills/mcp-governance.md`](../../docs/skills/mcp-governance.md). Resolve this relative link from this `SKILL.md`'s directory, not from the shell's current working directory. OpenCode supplies the skill base directory; Claude Code supports `${CLAUDE_SKILL_DIR}` for skill-relative files. Other clients must resolve the link relative to the loaded skill location.
2. If that path is unavailable in an installed copy, locate the target repository root by finding its `AGENTS.md`, then read `docs/skills/mcp-governance.md`. Do not reconstruct missing rules from memory. Until the protocol is available, limit work to safe read-only discovery and ask/report the blocker before any write.
3. Discover the connected MCP server's instructions, tools, resources, and templates using the client-supported discovery surface. Use only tools/references actually exposed; a missing capability is a limitation, not a reason to guess or substitute a write.

This file is an activation loader, not a second copy of the governance manual. `docs/documentation-model.md` remains authoritative for documentation semantics.
