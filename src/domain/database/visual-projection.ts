import type { DatabaseColumn, DatabaseModel, DatabaseTable } from "./model";
import { estimateTextWidth } from "../../layout/text";
import type { GeometryConnection, GeometryInput } from "../../layout/geometry-input";

export interface DatabaseVisualColumn {
  visualId: string;
  semanticColumnId?: string;
  implicitIdentity?: { tableId: string; exactName: string };
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  uniqueConstraintIds: string[];
  indexIds: string[];
  default?: string;
  description?: string;
  order: number;
  portIds: { west: string; east: string };
}

export interface DatabaseVisualTable {
  visualId: string;
  semanticTableId: string;
  schemaId?: string;
  qualifiedName: string;
  description?: string;
  primaryKeyColumns: string[];
  primaryKeyId?: string;
  uniqueConstraintIds: string[];
  indexMappings: Array<{ id: string; columns: string[] }>;
  columns: DatabaseVisualColumn[];
  requiredWidth: number;
  requiredHeight: number;
}

export interface DatabaseVisualConnection {
  visualId: string;
  semanticForeignKeyId: string;
  sourceTableVisualId: string;
  targetTableVisualId: string;
  sourceColumnIds: string[];
  targetColumnIds: string[];
  sourcePortIds: string[];
  targetPortIds: string[];
  geometry: GeometryConnection;
}

export interface DatabaseVisualProjection {
  tables: DatabaseVisualTable[];
  connections: DatabaseVisualConnection[];
  visualIdByTableId: Record<string, string>;
  visualIdByColumnIdentity: Record<string, string>;
  visualIdByForeignKeyId: Record<string, string>;
  geometry: GeometryInput;
}

const tableVisualId = (id: string) => `database-table:${encodeURIComponent(id)}`;
const foreignKeyVisualId = (id: string) => `database-fk:${encodeURIComponent(id)}`;
const columnKey = (tableId: string, column: DatabaseColumn) => column.id ? `${tableId}#id:${column.id}` : `${tableId}#name:${column.name}`;
const portId = (tableId: string, column: DatabaseColumn, side: "west" | "east") => `database-port:${encodeURIComponent(tableId)}:${encodeURIComponent(column.id ? `id:${column.id}` : `name:${column.name}`)}:${side}`;
const qualifiedTableName = (model: DatabaseModel, table: DatabaseTable) => {
  const schema = model.schemas.find(candidate => candidate.id === table.schemaId)?.name;
  return schema ? `${schema}.${table.name}` : table.name;
};

/** Project tables as sized compound items with one pair of row ports per column. */
export function projectDatabase(model: DatabaseModel): DatabaseVisualProjection {
  const tables = model.tables.map(table => {
    const pk = new Set(table.primaryKey?.columns ?? []);
    const uniqueByColumn = new Map<string, string[]>();
    for (const constraint of table.uniqueConstraints) for (const column of constraint.columns) uniqueByColumn.set(column, [...(uniqueByColumn.get(column) ?? []), constraint.id]);
    const indexByColumn = new Map<string, string[]>();
    for (const index of table.indexes) for (const column of index.columns) indexByColumn.set(column, [...(indexByColumn.get(column) ?? []), index.id]);
    const incoming = model.foreignKeys.filter(fk => fk.targetTableId === table.id);
    const outgoing = model.foreignKeys.filter(fk => fk.sourceTableId === table.id);
    const foreignColumns = new Set([...incoming.flatMap(fk => fk.targetColumns), ...outgoing.flatMap(fk => fk.sourceColumns)]);
    const columns = table.columns.map((column, order): DatabaseVisualColumn => ({
      visualId: `database-column:${encodeURIComponent(columnKey(table.id, column))}`,
      ...(column.id === undefined ? { implicitIdentity: { tableId: table.id, exactName: column.name } } : { semanticColumnId: column.id }),
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      isPrimaryKey: pk.has(column.name),
      isForeignKey: foreignColumns.has(column.name),
      uniqueConstraintIds: uniqueByColumn.get(column.name) ?? [],
      indexIds: indexByColumn.get(column.name) ?? [],
      ...(column.default === undefined ? {} : { default: column.default }),
      ...(column.description === undefined ? {} : { description: column.description }),
      order,
      portIds: { west: portId(table.id, column, "west"), east: portId(table.id, column, "east") },
    }));
    const headerWidth = estimateTextWidth(qualifiedTableName(model, table), 14) + 32;
    const columnWidth = Math.max(0, ...columns.map(column => {
      const marks = [pk.has(column.name) ? "PK" : "", foreignColumns.has(column.name) ? "FK" : "", uniqueByColumn.has(column.name) ? "UQ" : ""].filter(Boolean).join(" ");
      const attributes = `${column.type}${marks ? ` · ${marks}` : ""} · ${column.nullable ? "NULL" : "NOT NULL"}`;
      return estimateTextWidth(column.name, 12) + estimateTextWidth(attributes, 12) + 40;
    }));
    const requiredWidth = Math.max(180, Math.ceil(headerWidth), Math.ceil(columnWidth));
    const rowHeight = 28;
    return {
      visualId: tableVisualId(table.id),
      semanticTableId: table.id,
      ...(table.schemaId === undefined ? {} : { schemaId: table.schemaId }),
      qualifiedName: qualifiedTableName(model, table),
      ...(table.description === undefined ? {} : { description: table.description }),
      primaryKeyColumns: table.primaryKey?.columns ?? [],
      ...(table.primaryKey ? { primaryKeyId: table.primaryKey.id } : {}),
      uniqueConstraintIds: table.uniqueConstraints.map(constraint => constraint.id),
      indexMappings: table.indexes.map(index => ({ id: index.id, columns: [...index.columns] })),
      columns,
      requiredWidth,
      requiredHeight: 42 + columns.length * rowHeight,
    };
  });
  const tablesById = new Map(tables.map(table => [table.semanticTableId, table]));
  const connections: DatabaseVisualConnection[] = model.foreignKeys.map(fk => {
    const source = tablesById.get(fk.sourceTableId), target = tablesById.get(fk.targetTableId);
    const sourceColumnIds = fk.sourceColumns.map(name => source?.columns.find(column => column.name === name)?.visualId ?? "");
    const targetColumnIds = fk.targetColumns.map(name => target?.columns.find(column => column.name === name)?.visualId ?? "");
    const sourcePortIds = fk.sourceColumns.map(name => source?.columns.find(column => column.name === name)?.portIds.east ?? "");
    const targetPortIds = fk.targetColumns.map(name => target?.columns.find(column => column.name === name)?.portIds.west ?? "");
    const visualId = foreignKeyVisualId(fk.id);
    const geometry: GeometryConnection = {
      id: visualId,
      source: { itemId: tableVisualId(fk.sourceTableId), ...(sourcePortIds[0] ? { portId: sourcePortIds[0] } : {}) },
      target: { itemId: tableVisualId(fk.targetTableId), ...(targetPortIds[0] ? { portId: targetPortIds[0] } : {}) },
    };
    return { visualId, semanticForeignKeyId: fk.id, sourceTableVisualId: geometry.source.itemId, targetTableVisualId: geometry.target.itemId, sourceColumnIds, targetColumnIds, sourcePortIds, targetPortIds, geometry };
  });
  return {
    tables,
    connections,
    visualIdByTableId: Object.fromEntries(tables.map(table => [table.semanticTableId, table.visualId])),
    visualIdByColumnIdentity: Object.fromEntries(tables.flatMap(table => table.columns.map(column => [column.semanticColumnId ? `${table.semanticTableId}#id:${column.semanticColumnId}` : `${table.semanticTableId}#name:${column.implicitIdentity!.exactName}`, column.visualId]))),
    visualIdByForeignKeyId: Object.fromEntries(connections.map(connection => [connection.semanticForeignKeyId, connection.visualId])),
    geometry: {
      items: tables.map(table => ({
        id: table.visualId,
        requiredWidth: table.requiredWidth,
        requiredHeight: table.requiredHeight,
        ports: table.columns.flatMap(column => [
          { id: column.portIds.west, side: "WEST" as const, x: 0, y: 42 + column.order * 28 + 14 },
          { id: column.portIds.east, side: "EAST" as const, x: table.requiredWidth, y: 42 + column.order * 28 + 14 },
        ]),
      })),
      connections: connections.map(connection => connection.geometry),
    },
  };
}
