import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "dist-mcp-service/server.mjs");
const protocolPath = path.join(root, "docs/skills/mcp-governance.md");
const dockerfilePath = path.join(root, "Dockerfile.mcp");
const [bundle, protocol, dockerfile] = await Promise.all([
  readFile(bundlePath, "utf8"),
  readFile(protocolPath, "utf8"),
  readFile(dockerfilePath, "utf8"),
]);

for (const marker of ["softdocs://governance/protocol", "read_governance_protocol"]) {
  if (!bundle.includes(marker)) {
    throw new Error(`The remote MCP bundle is missing ${marker}.`);
  }
}

const bundledProtocolPath = fileURLToPath(
  new URL("../docs/skills/mcp-governance.md", pathToFileURL(bundlePath)),
);
if (bundledProtocolPath !== protocolPath || protocol.length === 0) {
  throw new Error("The deployed protocol path does not resolve to the canonical source.");
}

if (!/^COPY --from=build --chown=node:node \/app\/docs\/skills \.\/docs\/skills$/m.test(dockerfile)) {
  throw new Error("Dockerfile.mcp does not include docs/skills in the runtime image.");
}

process.stdout.write(
  `MCP deployment artifact contains the protocol discovery code and copies the canonical protocol (${protocol.length} characters).\n`,
);
