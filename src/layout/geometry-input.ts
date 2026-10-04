export type PortSide = "NORTH" | "EAST" | "SOUTH" | "WEST";

export interface GeometryPort {
  id: string;
  side: PortSide;
  /** Local coordinates within the owning item; optional for engine placement. */
  x?: number;
  y?: number;
}

export interface GeometryItem {
  id: string;
  requiredWidth: number;
  requiredHeight: number;
  ports?: GeometryPort[];
}

export interface GeometryEndpoint {
  itemId: string;
  portId?: string;
}

export interface GeometryConnection {
  id: string;
  source: GeometryEndpoint;
  target: GeometryEndpoint;
  label?: { text: string; requiredWidth: number; requiredHeight: number };
}

/** Semantic-free, renderer-independent input shared by artifact projections. */
export interface GeometryInput {
  items: GeometryItem[];
  connections: GeometryConnection[];
}

export interface PositionedGeometry {
  width: number;
  height: number;
  items: Array<GeometryItem & { x: number; y: number }>;
  ports: Array<GeometryPort & { ownerItemId: string; x: number; y: number }>;
  connections: Array<{
    id: string;
    points: Array<{ x: number; y: number }>;
    label?: { text: string; x: number; y: number; width: number; height: number };
  }>;
}
