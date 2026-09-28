import { describe, expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { createCausalElkLayout, type CausalLayoutWorker } from "../../src/renderer/causal/causal-elk-layout";

class FakeWorker implements CausalLayoutWorker {
  onmessage: CausalLayoutWorker["onmessage"] = null;
  onerror: CausalLayoutWorker["onerror"] = null;
  messages: Array<{ id: number; graph: ElkNode }> = [];
  terminated = false;
  postMessage(message: { id: number; graph: ElkNode }) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  resolve(graph: ElkNode) { this.onmessage?.({ data: { id: this.messages.at(-1)!.id, graph } } as MessageEvent); }
  fail() { this.onerror?.(new ErrorEvent("error")); }
}

const graph: ElkNode = { id: "result", children: [] };

describe("causal ELK worker boundary", () => {
  it("supersedes stale requests and ignores stale results", async () => {
    const workers: FakeWorker[] = [];
    const client = createCausalElkLayout(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
    const first = client.layout({ id: "first" });
    const second = client.layout({ id: "second" });
    await expect(first).rejects.toThrow("superseded");
    workers[0]!.onmessage?.({ data: { id: workers[0]!.messages[0]!.id, graph } } as MessageEvent);
    workers[1]!.resolve(graph);
    await expect(second).resolves.toEqual(graph);
  });

  it("rejects worker failures with an actionable error", async () => {
    const worker = new FakeWorker();
    const promise = createCausalElkLayout(() => worker).layout({ id: "request" });
    worker.fail();
    await expect(promise).rejects.toThrow("Causal ELK worker failed");
  });

  it("rejects pending work when disposed during layout", async () => {
    const worker = new FakeWorker();
    const client = createCausalElkLayout(() => worker);
    const promise = client.layout({ id: "request" });
    client.dispose();
    await expect(promise).rejects.toThrow("preview was unmounted");
    expect(worker.terminated).toBe(true);
  });

  it("supports consecutive requests after completion", async () => {
    const worker = new FakeWorker();
    const client = createCausalElkLayout(() => worker);
    const first = client.layout({ id: "first" });
    worker.resolve(graph);
    await expect(first).resolves.toEqual(graph);
    const secondWorker = new FakeWorker();
    const secondClient = createCausalElkLayout(() => secondWorker);
    const second = secondClient.layout({ id: "second" });
    secondWorker.resolve(graph);
    await expect(second).resolves.toEqual(graph);
  });
});
