import { describe, expect, it } from "vitest";
import { layoutGeometry, GeometryLayoutError } from "../../src/layout/elk-geometry-adapter";
import type { GeometryInput } from "../../src/layout/geometry-input";
import { projectConceptual } from "../../src/domain/conceptual/visual-projection";
import { projectDatabase } from "../../src/domain/database/visual-projection";
import type { DatabaseModel } from "../../src/domain/database/model";
import { fitTransform } from "../../src/features/preview/viewport";

const points = (input: GeometryInput) => layoutGeometry(input);

describe("headless geometry layout", () => {
  it("deterministically lays out cycles, disconnected items, self loops and parallel connections", async () => {
    const input: GeometryInput = {
      items: ["a", "b", "c", "d"].map(id => ({ id, requiredWidth: 150, requiredHeight: 64 })),
      connections: [
        { id: "ab", source: { itemId: "a" }, target: { itemId: "b" } },
        { id: "ab-2", source: { itemId: "a" }, target: { itemId: "b" } },
        { id: "bc", source: { itemId: "b" }, target: { itemId: "c" } },
        { id: "ca", source: { itemId: "c" }, target: { itemId: "a" } },
        { id: "dd", source: { itemId: "d" }, target: { itemId: "d" } },
      ],
    };
    const [first, second] = await Promise.all([points(input), points(input)]);
    expect(first).toEqual(second);
    expect(first.connections.map(edge => edge.id)).toEqual(input.connections.map(edge => edge.id));
    expect(first.connections.every(edge => edge.points.length >= 2)).toBe(true);
    expect(first.items.map(item => item.id)).toEqual(["a", "b", "c", "d"]);
    for (let i = 0; i < first.items.length; i++) for (let j = i + 1; j < first.items.length; j++) {
      const a = first.items[i]!, b = first.items[j]!;
      expect(a.x + a.requiredWidth <= b.x || b.x + b.requiredWidth <= a.x || a.y + a.requiredHeight <= b.y || b.y + b.requiredHeight <= a.y).toBe(true);
    }
  });

  it("lays out projected row ports at their owning database column rows", async () => {
    const model: DatabaseModel = { schemas: [], tables: [
      { id: "parent", name: "parent", columns: [{ id: "parent-id", name: "id", type: "uuid", nullable: false }], primaryKey: { id: "parent-pk", columns: ["id"] }, uniqueConstraints: [], indexes: [] },
      { id: "child", name: "child", columns: [{ id: "child-id", name: "id", type: "uuid", nullable: false }, { id: "parent-id", name: "parent_id", type: "uuid", nullable: false }], primaryKey: { id: "child-pk", columns: ["id"] }, uniqueConstraints: [], indexes: [] },
    ], foreignKeys: [{ id: "fk", sourceTableId: "child", sourceColumns: ["parent_id"], targetTableId: "parent", targetColumns: ["id"] }] };
    const projection = projectDatabase(model), geometry = await layoutGeometry(projection.geometry);
    const source = geometry.ports.find(port => port.id === projection.connections[0]?.sourcePortIds[0]);
    const target = geometry.ports.find(port => port.id === projection.connections[0]?.targetPortIds[0]);
    const sourceTable = geometry.items.find(item => item.id === source?.ownerItemId);
    expect(source?.ownerItemId).toBe(projection.connections[0]?.sourceTableVisualId);
    expect(target?.ownerItemId).toBe(projection.connections[0]?.targetTableVisualId);
    expect(source?.y).toBeGreaterThan(sourceTable!.y);
    expect(source?.y).toBeLessThan(sourceTable!.y + sourceTable!.requiredHeight);
    expect(geometry.connections[0]?.points.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps database cycles, parallel FKs, composite evidence, and large table dimensions", async () => {
    const columns = Array.from({ length: 45 }, (_, i) => ({ id: `wide-${i}`, name: `column_${i}`, type: i === 44 ? "varchar(512)" : "uuid", nullable: i > 0 }));
    const model: DatabaseModel = {
      schemas: [],
      tables: [
        { id: "wide", name: "wide", columns, primaryKey: { id: "wide-pk", columns: ["column_0"] }, uniqueConstraints: [], indexes: [] },
        { id: "other", name: "other", columns: [{ id: "other-id", name: "id", type: "uuid", nullable: false }, { id: "ref-a", name: "ref_a", type: "uuid", nullable: true }, { id: "ref-b", name: "ref_b", type: "uuid", nullable: true }], primaryKey: { id: "other-pk", columns: ["id"] }, uniqueConstraints: [{ id: "other-uq", columns: ["ref_a", "ref_b"] }], indexes: [] },
        { id: "tree", name: "tree", columns: [{ id: "tree-id", name: "id", type: "uuid", nullable: false }, { id: "tree-parent", name: "parent_id", type: "uuid", nullable: true }], primaryKey: { id: "tree-pk", columns: ["id"] }, uniqueConstraints: [], indexes: [] },
        { id: "disconnected", name: "disconnected", columns: [{ id: "disconnected-id", name: "id", type: "uuid", nullable: false }], primaryKey: { id: "disconnected-pk", columns: ["id"] }, uniqueConstraints: [], indexes: [] },
      ],
      foreignKeys: [
        { id: "fk-a", sourceTableId: "other", sourceColumns: ["ref_a", "ref_b"], targetTableId: "wide", targetColumns: ["column_0", "column_1"] },
        { id: "fk-b", sourceTableId: "other", sourceColumns: ["ref_a"], targetTableId: "wide", targetColumns: ["column_0"] },
        { id: "fk-cycle", sourceTableId: "wide", sourceColumns: ["column_0"], targetTableId: "other", targetColumns: ["id"] },
        { id: "fk-self", sourceTableId: "tree", sourceColumns: ["parent_id"], targetTableId: "tree", targetColumns: ["id"] },
      ],
    };
    const projection = projectDatabase(model), geometry = await layoutGeometry(projection.geometry);
    expect(geometry.connections.map(edge => edge.id)).toEqual(projection.connections.map(edge => edge.visualId));
    expect(projection.connections[0]?.sourceColumnIds).toHaveLength(2);
    expect(projection.connections[0]?.sourcePortIds).toHaveLength(2);
    expect(projection.connections[0]?.visualId).not.toBe(projection.connections[1]?.visualId);
    expect(geometry.connections.map(edge => edge.id)).toContain(projection.connections[3]?.visualId);
    const largeTable = projection.tables.find(table => table.semanticTableId === "wide")!;
    expect(largeTable.requiredHeight).toBe(42 + 45 * 28);
    expect(largeTable.requiredWidth).toBeGreaterThan(180);
    const placed = geometry.items.find(item => item.id === largeTable.visualId)!;
    expect(placed.requiredHeight).toBe(largeTable.requiredHeight);
    const columnPort = projection.tables[0]!.columns[44]!.portIds.east;
    const positionedPort = geometry.ports.find(port => port.id === columnPort)!;
    expect(positionedPort.ownerItemId).toBe(largeTable.visualId);
    expect(positionedPort.y).toBeGreaterThan(placed.y + 42 + 43 * 28);
    expect(positionedPort.y).toBeLessThan(placed.y + placed.requiredHeight);
    for (let i = 0; i < geometry.items.length; i++) for (let j = i + 1; j < geometry.items.length; j++) {
      const a = geometry.items[i]!, b = geometry.items[j]!;
      expect(a.x + a.requiredWidth <= b.x || b.x + b.requiredWidth <= a.x || a.y + a.requiredHeight <= b.y || b.y + b.requiredHeight <= a.y).toBe(true);
    }
  });

  it("reports invalid geometry explicitly and accepts empty geometry", async () => {
    await expect(layoutGeometry({ items: [], connections: [] })).resolves.toEqual({ width: 0, height: 0, items: [], ports: [], connections: [] });
    await expect(layoutGeometry({ items: [{ id: "a", requiredWidth: -1, requiredHeight: 2 }], connections: [] })).rejects.toBeInstanceOf(GeometryLayoutError);
    await expect(layoutGeometry({ items: [{ id: "a", requiredWidth: 1, requiredHeight: 1 }], connections: [{ id: "bad", source: { itemId: "missing" }, target: { itemId: "a" } }] })).rejects.toThrow(/unknown item/);
    await expect(layoutGeometry({ items: [{ id: "a", requiredWidth: 10, requiredHeight: 10 }], connections: [{ id: "bad-label", source: { itemId: "a" }, target: { itemId: "a" }, label: { text: "bad", requiredWidth: 0, requiredHeight: 1 } }] })).rejects.toBeInstanceOf(GeometryLayoutError);
  });

  it("lays out 50-node conceptual and 40-table database medium fixtures", async () => {
    const conceptual = projectConceptual({ concepts: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, name: `Concept ${i}` })), relationships: Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, sourceConceptId: `c${i % 50}`, targetConceptId: `c${(i * 7 + 3) % 50}`, label: `relation ${i}`, direction: i % 2 ? "directed" as const : "undirected" as const })) });
    const tables = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `table_${i}`, columns: [{ id: `id${i}`, name: "id", type: "uuid", nullable: false }, { id: `ref${i}`, name: "ref_id", type: "uuid", nullable: true }], primaryKey: { id: `pk${i}`, columns: ["id"] }, uniqueConstraints: [], indexes: [] }));
    const database = projectDatabase({ schemas: [], tables, foreignKeys: Array.from({ length: 60 }, (_, i) => ({ id: `fk${i}`, sourceTableId: `t${i % 40}`, sourceColumns: ["ref_id"], targetTableId: `t${(i + 1) % 40}`, targetColumns: ["id"] })) });
    const start = performance.now();
    const [conceptGeometry, databaseGeometry] = await Promise.all([layoutGeometry(conceptual.geometry), layoutGeometry(database.geometry)]);
    await expect(layoutGeometry(database.geometry, "default")).resolves.toEqual(databaseGeometry);
    expect(performance.now() - start).toBeLessThan(15000);
    expect(conceptGeometry.items).toHaveLength(50);
    expect(conceptGeometry.connections).toHaveLength(100);
    expect(databaseGeometry.items).toHaveLength(40);
    expect(databaseGeometry.connections).toHaveLength(60);
  });

  it("keeps a dense, long-labeled conceptual model readable at fit", async () => {
    const concepts = Array.from({ length: 15 }, (_, i) => ({ id: `concept-${i}`, name: `Domain concept ${i}` }));
    const endpoints = [[1,0],[2,0],[0,3],[0,4],[5,0],[5,4],[4,6],[7,6],[7,0],[6,8],[0,1],[10,12],[12,13],[12,14],[14,11]];
    const relationships = endpoints.map(([source, target], i) => ({
      id: `relationship-${i}`,
      sourceConceptId: concepts[source!]!.id,
      targetConceptId: concepts[target!]!.id,
      label: `evidence-backed relationship description ${i} with operational constraints`,
      direction: i % 3 === 0 ? "directed" as const : "undirected" as const,
    }));
    const projection = projectConceptual({ concepts, relationships });
    const [geometry, repeatedGeometry] = await Promise.all([
      layoutGeometry(projection.geometry, "conceptual"),
      layoutGeometry(projection.geometry, "conceptual"),
    ]);
    const fit = fitTransform({ width: geometry.width, height: geometry.height }, { width: 800, height: 600 });

    expect(projection.items).toHaveLength(15);
    expect(projection.connections).toHaveLength(15);
    expect(relationships.some(relationship => relationship.direction === "directed")).toBe(true);
    expect(relationships.some(relationship => relationship.direction === "undirected")).toBe(true);
    expect(geometry).toEqual(repeatedGeometry);
    expect(fit.scale).toBeGreaterThan(0.35);
    expect(geometry.connections.every(connection => connection.label && connection.label.text.split("\n").join(" ").startsWith("evidence-backed relationship description"))).toBe(true);
    expect(geometry.connections.every(connection => connection.points.length >= 2)).toBe(true);
    for (const connection of geometry.connections) {
      const label = connection.label!;
      for (const item of geometry.items) {
        const overlaps = label.x < item.x + item.requiredWidth && label.x + label.width > item.x && label.y < item.y + item.requiredHeight && label.y + label.height > item.y;
        expect(overlaps, `${connection.id} label overlaps ${item.id}`).toBe(false);
      }
    }
  });
});
