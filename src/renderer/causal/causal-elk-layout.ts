import type { ElkNode } from "elkjs/lib/elk-api";
import type { CausalElkRequest, CausalElkResponse } from "./causal-flow-adapter";

export interface CausalLayoutWorker {
  postMessage(message: CausalElkRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<CausalElkResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
export type CausalWorkerFactory = () => CausalLayoutWorker;

export function browserCausalWorker(): CausalLayoutWorker {
  return new Worker(new URL("./causal-elk.worker.ts", import.meta.url), { type: "module" }) as unknown as CausalLayoutWorker;
}

export function createCausalElkLayout(factory: CausalWorkerFactory = browserCausalWorker) {
  let sequence = 0;
  let worker: CausalLayoutWorker | null = null;
  let pending: { id: number; resolve: (graph: ElkNode) => void; reject: (error: Error) => void } | null = null;
  const layout = (graph: ElkNode): Promise<ElkNode> => {
    pending?.reject(new Error("Causal layout superseded by a newer request."));
    worker?.terminate();
    const id = ++sequence;
    return new Promise<ElkNode>((resolve, reject) => {
      try {
        worker = factory();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      pending = { id, resolve, reject };
      worker!.onmessage = (event) => {
        if (!pending || event.data.id !== pending.id) return;
        const current = pending;
        pending = null;
        worker?.terminate();
        worker = null;
        if (event.data.error || !event.data.graph) current.reject(new Error(event.data.error ?? "Causal ELK worker returned no layout."));
        else current.resolve(event.data.graph);
      };
      worker!.onerror = () => {
        if (!pending || pending.id !== id) return;
        const current = pending;
        pending = null;
        worker?.terminate();
        worker = null;
        current.reject(new Error("Causal ELK worker failed. Reload the document and try again."));
      };
      worker!.postMessage({ id, graph });
    });
  };
  const dispose = () => {
    pending?.reject(new Error("Causal layout cancelled because the preview was unmounted."));
    pending = null;
    worker?.terminate();
    worker = null;
  };
  return { layout, dispose };
}
