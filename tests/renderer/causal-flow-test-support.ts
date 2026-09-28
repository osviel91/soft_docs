import ELK from "elkjs/lib/elk.bundled.js";
import { causalElkGraph, positionedCausalFlow } from "../../src/renderer/causal/causal-flow-adapter";
import type { CausalViewModel } from "../../src/domain/eventflow/causal-projection";

export async function layout(view: CausalViewModel) {
  return positionedCausalFlow(view, await new ELK().layout(causalElkGraph(view)));
}

export { causalElkGraph };
