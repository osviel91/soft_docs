import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./app-harness";
import type { DiagramFile, Project } from "../src/domain/workspace/types";
import { readZip } from "../src/workspace/transfer/zip";
import { exportProjectToZip } from "../src/workspace/transfer/project-archive";

// Capture what the shell hands to the browser rather than performing a download.
const transfer = vi.hoisted(() => ({
  downloads: [] as Array<{ filename: string; bytes: Uint8Array }>,
  pngSources: [] as string[],
  pdfSources: [] as string[],
}));

vi.mock("../src/workspace/transfer/download", () => ({
  downloadBytes: (bytes: Uint8Array, filename: string) => {
    transfer.downloads.push({ filename, bytes });
  },
}));

vi.mock("../src/features/export/diagram-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/features/export/diagram-export")>();
  return {
    ...actual,
    svgToPng: vi.fn(async (svg: string) => { transfer.pngSources.push(svg); return new TextEncoder().encode("png"); }),
    svgToPdf: vi.fn(async (svg: string) => { transfer.pdfSources.push(svg); return new TextEncoder().encode("pdf"); }),
  };
});

/**
 * Export, driven through the real shell.
 *
 * The bytes are asserted rather than the mechanism: a diagram export must be a
 * real SVG document, and a documentation-site export must be a ZIP that contains
 * the site's pages. That is what "export works" means to a user, and it is what a
 * regression would break.
 */
describe("App — export", () => {
  const SOURCE = [
    "title Checkout",
    "participant Cart",
    "participant Payment",
    "",
    "Cart ->> Payment: Authorize",
  ].join("\n");
  const EVENT_FLOW = [
    "title Order Processing",
    "event OrderCreated",
    "producer OrderService",
    "consumer BillingService",
    "OrderService publishes OrderCreated",
    "BillingService consumes OrderCreated",
  ].join("\n");
  const CONCEPTUAL = [
    'title "Commerce"',
    'concept customer "Customer"',
    'concept order "Order"',
    'relation places customer -> order "places orders"',
  ].join("\n");

  afterEach(() => {
    transfer.downloads.length = 0;
    transfer.pngSources.length = 0;
    transfer.pdfSources.length = 0;
  });

  async function projectWithDiagram(): Promise<void> {
    fireEvent.click(screen.getByTestId("local-create-toggle"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Payments" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Payments");
    });

    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: SOURCE },
    });

    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-note"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: "# Architecture\n\nProse." },
    });
  }

  async function runCommand(label: string): Promise<void> {
    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: label },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });
  }

  async function importConceptualProject(): Promise<void> {
    const project: Project = { id: "commerce", name: "Commerce", datasetIds: ["domain"], noteIds: [] };
    const diagram: DiagramFile = { id: "domain", name: "domain.concept", projectId: project.id, source: CONCEPTUAL };
    const input = screen.getByTestId("import-file-input") as HTMLInputElement;
    const bytes = exportProjectToZip(project, [diagram], []);
    const file = new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], "commerce.zip", { type: "application/zip" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => fireEvent.change(input));
    await waitFor(() => expect(screen.getByTestId("conceptual-preview-svg")).toBeInTheDocument());
  }

  it("exports the current Event Flow as a rendered SVG document", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("local-create-toggle"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Payments" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Payments");
    });
    await runCommand("New Event Flow");
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: EVENT_FLOW },
    });

    fireEvent.click(screen.getByTestId("resource-export-action"));
    expect(screen.getByTestId("export-preview")).toHaveAttribute(
      "src",
      expect.stringContaining("Order%20Processing"),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-confirm"));
    });

    await waitFor(() => expect(transfer.downloads).toHaveLength(1));
    const text = new TextDecoder().decode(transfer.downloads[0].bytes);
    expect(text.startsWith("<svg")).toBe(true);
    expect(text).toContain("Order Processing");
    expect(text).toContain("OrderCreated");
  });

  it("exports a Conceptual diagram as its rendered SVG", async () => {
    render(<App />);
    await importConceptualProject();
    await waitFor(() => expect(screen.getByTestId("resource-export-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("resource-export-action"));
    expect(screen.getByTestId("export-dialog")).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByTestId("export-confirm")));
    await waitFor(() => expect(transfer.downloads).toHaveLength(1));
    const svg = new TextDecoder().decode(transfer.downloads[0].bytes);
    expect(svg).toContain('aria-label="Conceptual model"');
    expect(svg).toContain('data-node-id="customer"');
    expect(svg).toContain('data-node-id="order"');
    expect(svg).toContain('data-edge-id="places"');
    expect(svg).toContain("places orders");
  });

  it.each(["png", "pdf"] as const)("exports Conceptual %s from its rendered SVG", async (format) => {
    render(<App />);
    await importConceptualProject();
    await waitFor(() => expect(screen.getByTestId("resource-export-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("resource-export-action"));
    fireEvent.click(screen.getByTestId(`export-format-${format}`));
    await act(async () => fireEvent.click(screen.getByTestId("export-confirm")));
    await waitFor(() => expect(transfer.downloads).toHaveLength(1));

    const svg = (format === "png" ? transfer.pngSources : transfer.pdfSources)[0];
    expect(svg).toContain('data-node-id="customer"');
    expect(svg).toContain('data-edge-id="places"');
    expect(svg).toContain("places orders");
  });

  it("applies the selected export options to Conceptual output", async () => {
    render(<App />);
    await importConceptualProject();
    await waitFor(() => expect(screen.getByTestId("resource-export-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("resource-export-action"));
    fireEvent.click(screen.getByTestId("export-theme-dark"));
    fireEvent.change(screen.getByTestId("export-background"), { target: { value: "custom" } });
    fireEvent.change(screen.getByTestId("export-background-custom"), { target: { value: "#123456" } });
    fireEvent.change(screen.getByTestId("export-padding"), { target: { value: "12" } });
    fireEvent.click(screen.getByTestId("export-include-title"));
    await act(async () => fireEvent.click(screen.getByTestId("export-confirm")));
    await waitFor(() => expect(transfer.downloads).toHaveLength(1));

    const svg = new TextDecoder().decode(transfer.downloads[0].bytes);
    expect(svg).toContain('--text:#e7ebf3');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain("translate(12, 12)");
    expect(svg).not.toContain(">Commerce</text>");
  });

  it("includes a rendered Conceptual SVG in the documentation site", async () => {
    render(<App />);
    await importConceptualProject();
    await runCommand("Export Documentation Site");
    await waitFor(() => expect(transfer.downloads).toHaveLength(1));

    const entries = readZip(transfer.downloads[0].bytes);
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    const svgEntry = entries.value.find((entry) => entry.path.startsWith("diagrams/") && entry.path.endsWith(".svg"));
    expect(svgEntry).toBeDefined();
    const svg = new TextDecoder().decode(svgEntry!.data);
    expect(svg).toContain('data-node-id="customer"');
    expect(svg).toContain('data-node-id="order"');
    expect(svg).toContain('data-edge-id="places"');
    expect(svg).toContain("places orders");
  });

  it("keeps site pages distinct when Sequence and Conceptual titles collide", async () => {
    render(<App />);
    const project: Project = { id: "commerce", name: "Commerce", datasetIds: ["sequence", "concept"], noteIds: [] };
    const diagrams: DiagramFile[] = [
      { id: "sequence", name: "commerce.seq", projectId: project.id, source: 'title Commerce\nparticipant Customer\nparticipant Order\nCustomer -> Order: places orders' },
      { id: "concept", name: "commerce.concept", projectId: project.id, source: CONCEPTUAL },
    ];
    const input = screen.getByTestId("import-file-input") as HTMLInputElement;
    const bytes = exportProjectToZip(project, diagrams, []);
    const file = new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], "commerce.zip", { type: "application/zip" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => fireEvent.change(input));
    await runCommand("Export Documentation Site");
    await waitFor(() => expect(transfer.downloads).toHaveLength(1));

    const entries = readZip(transfer.downloads[0].bytes);
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    const paths = entries.value.map((entry) => entry.path);
    const diagramPages = paths.filter((path) => path.startsWith("diagrams/") && path.endsWith(".html"));
    expect(diagramPages).toHaveLength(2);
    expect(new Set(diagramPages).size).toBe(2);
    expect(paths).toContain("events.html");
    const index = new TextDecoder().decode(entries.value.find((entry) => entry.path === "index.html")!.data);
    for (const path of diagramPages) expect(index).toContain(path);
  });

  it("exports the current diagram as an SVG document", async () => {
    render(<App />);
    await projectWithDiagram();
    // Back to the diagram so the export targets it, not the note.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("tab")[0]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("resource-export-action"));
    expect(screen.getByTestId("export-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("export-cancel"));

    await runCommand("Export Diagram");
    await waitFor(() => {
      expect(screen.getByTestId("export-dialog")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-confirm"));
    });

    await waitFor(() => {
      expect(transfer.downloads).toHaveLength(1);
    });
    const [download] = transfer.downloads;
    expect(download.filename).toMatch(/\.svg$/);
    const text = new TextDecoder().decode(download.bytes);
    expect(text.startsWith("<svg")).toBe(true);
    expect(text).toContain("Authorize");
    expect(screen.queryByTestId("export-dialog")).toBeNull();
  });

  it("writes the project's documentation as a ZIP of HTML", async () => {
    render(<App />);
    await projectWithDiagram();

    await runCommand("Export Documentation Site");

    await waitFor(() => {
      expect(transfer.downloads).toHaveLength(1);
    });
    const [download] = transfer.downloads;
    expect(download.filename).toBe("Payments-docs.zip");

    const entries = readZip(download.bytes);
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    const paths = entries.value.map((entry) => entry.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("styles/site.css");
    // The project's diagram and document each get a page, and the diagram is
    // also written as a standalone SVG.
    expect(paths.some((path) => path.startsWith("diagrams/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("docs/"))).toBe(true);

    const indexHtml = new TextDecoder().decode(
      entries.value.find((entry) => entry.path === "index.html")!.data,
    );
    expect(indexHtml).toContain("<html");
    expect(indexHtml).toContain("Payments");
  });

  it("exports the project chosen from its ⋯ menu", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("local-create-toggle"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "First" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("First");
    });
    fireEvent.click(screen.getByTestId("local-create-toggle"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Second" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getAllByTestId("explorer-project")).toHaveLength(2);
    });

    fireEvent.click(
      within(screen.getAllByTestId("explorer-project")[0]).getByTestId(
        "project-menu-button",
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-download-project"));
    });

    await waitFor(() => {
      expect(transfer.downloads).toHaveLength(1);
    });
    expect(transfer.downloads[0].filename).toBe("First.zip");
  });

  it("reports a site export attempted with no project selected", async () => {
    render(<App />);
    await runCommand("Export Documentation Site");
    expect(transfer.downloads).toHaveLength(0);
    expect(screen.getByTestId("transfer-error")).toHaveTextContent(
      "Open a project",
    );
  });
});
