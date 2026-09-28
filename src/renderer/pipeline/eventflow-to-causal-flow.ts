import type { EventFlow } from "../../domain/eventflow/ast";
import { projectEventFlowToCausalView } from "../../domain/eventflow/causal-projection";
import { causalElkGraph, positionedCausalFlow } from "../causal/causal-flow-adapter";
import { createCausalElkLayout } from "../causal/causal-elk-layout";
import { renderCausalFlowSvg } from "../causal/causal-flow-svg";

export async function renderEventFlowCausalDocument(flow: EventFlow | null, options: { background?: string; includeTitle?: boolean; padding?: number } = {}) {
  const view = projectEventFlowToCausalView(flow ?? { statements: [] });
  const client = createCausalElkLayout();
  try {
    const graph = positionedCausalFlow(view, await client.layout(causalElkGraph(view)));
    return { ...renderCausalFlowSvg(graph, view, options), graph, view };
  } finally {
    client.dispose();
  }
}
