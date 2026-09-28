import ELK from "elkjs/lib/elk.bundled.js";
import type { CausalElkRequest, CausalElkResponse } from "./causal-flow-adapter";

const elk = new ELK();
self.onmessage = (event: MessageEvent<CausalElkRequest>) => {
  void elk.layout(event.data.graph)
    .then((graph) => self.postMessage({ id: event.data.id, graph } satisfies CausalElkResponse))
    .catch((error: unknown) => self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) } satisfies CausalElkResponse));
};
