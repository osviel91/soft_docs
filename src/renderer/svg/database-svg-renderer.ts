import type { DatabaseVisualProjection } from "../../domain/database/visual-projection";
import type { PositionedGeometry } from "../../layout/geometry-input";
import type { SemanticChange } from "../../domain/diff/resource-diff";

const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);

export function renderDatabaseSvg(projection: DatabaseVisualProjection, geometry: PositionedGeometry, changes: SemanticChange[] = [], selectedId: string | null = null): string {
  const changed = new Map<string, string>();
  for (const change of changes) {
    const visualId = change.entity === "table" ? projection.visualIdByTableId[change.identity]
      : change.entity === "foreign-key" ? projection.visualIdByForeignKeyId[change.identity]
        : change.entity === "column" ? projection.visualIdByColumnIdentity[change.identity]
          : ["primary-key", "unique", "index", "schema"].includes(change.entity)
            ? projection.tables.find(table => table.primaryKeyId === change.identity || table.uniqueConstraintIds.includes(change.identity) || table.indexMappings.some(index => index.id === change.identity) || change.entity === "schema" && table.schemaId === change.identity)?.visualId
            : undefined;
    if (visualId) changed.set(visualId, change.kind);
  }
  const tables = new Map(projection.tables.map(table => [table.visualId, table]));
  const connections = new Map(projection.connections.map(connection => [connection.visualId, connection]));
  const relatedTables = new Set(projection.connections.filter(connection => connection.sourceTableVisualId === projection.visualIdByTableId[selectedId ?? ""] || connection.targetTableVisualId === projection.visualIdByTableId[selectedId ?? ""]).flatMap(connection => [connection.sourceTableVisualId, connection.targetTableVisualId]));
  const edges = geometry.connections.map(route => {
    const fk = connections.get(route.id);
    if (!fk || route.points.length < 2) return "";
    const d = route.points.map((point, i) => `${i ? "L" : "M"}${point.x},${point.y}`).join(" ");
    const mapping = fk.sourceColumnIds.map((id, i) => `${projection.tables.flatMap(t => t.columns).find(c => c.visualId === id)?.name ?? "?"} → ${projection.tables.flatMap(t => t.columns).find(c => c.visualId === fk.targetColumnIds[i])?.name ?? "?"}`).join(", ");
    const title = `${fk.semanticForeignKeyId}: ${mapping}`;
    const state = changed.get(fk.visualId);
    const related = selectedId !== null && (fk.sourceTableVisualId === projection.visualIdByTableId[selectedId] || fk.targetTableVisualId === projection.visualIdByTableId[selectedId]);
    return `<g class="database__fk${selectedId ? related ? " is-related" : " is-unrelated" : ""}${state ? ` review-change review-change--${state}` : ""}" data-edge-id="${xml(fk.semanticForeignKeyId)}" tabindex="0" role="img" aria-label="Foreign key ${xml(title)}"><path d="${d}" marker-end="url(#database-arrow)"/><title>${xml(title)}</title></g>`;
  }).join("");
  const nodes = geometry.items.map(bounds => {
    const table = tables.get(bounds.id);
    if (!table) return "";
    const state = changed.get(table.visualId);
    const selected = selectedId === table.semanticTableId;
    const rows = table.columns.map((column, index) => {
      const y = bounds.y + 42 + index * 28;
      const uniqueDetails = column.uniqueConstraintIds.map(id => {
        const members = table.columns.filter(row => row.uniqueConstraintIds.includes(id));
        return members.length > 1 ? `member of composite unique constraint ${id} (${members.map(row => row.name).join(", ")})` : `unique constraint ${id}`;
      });
      const marks = [column.isPrimaryKey ? "PK" : "", column.isForeignKey ? "FK" : "", ...column.uniqueConstraintIds.filter(id => table.columns.filter(row => row.uniqueConstraintIds.includes(id)).length === 1).map(() => "UQ")].filter(Boolean).join(" ");
      const indexDetails = column.indexIds.map(id => `member of index ${id}`);
      const details = [`${column.name}: ${column.type}`, column.nullable ? "nullable" : "not nullable", marks, ...uniqueDetails, ...indexDetails, column.default === undefined ? "" : `default ${column.default}`, column.description ?? ""].filter(Boolean).join("; ");
      const columnChange = changed.get(column.visualId);
      return `<g class="database__column${columnChange ? ` review-change review-change--${columnChange}` : ""}" data-column-id="${xml(column.semanticColumnId ?? `${table.semanticTableId}:${column.name}`)}" tabindex="0" role="group" aria-label="${xml(details)}"><line x1="${bounds.x}" y1="${y + 28}" x2="${bounds.x + bounds.requiredWidth}" y2="${y + 28}"/><text class="database__name" x="${bounds.x + 10}" y="${y + 18}">${xml(column.name)}</text><text class="database__type" x="${bounds.x + bounds.requiredWidth - 10}" y="${y + 18}" text-anchor="end">${xml(column.type)}${marks ? ` · ${xml(marks)}` : ""}${column.nullable ? " · NULL" : " · NOT NULL"}</text><title>${xml(details)}</title></g>`;
    }).join("");
    const label = table.qualifiedName;
    const indexDetails = table.indexMappings.map(index => `index ${index.id}: ${index.columns.join(", ")}`);
    const tableDetails = [label, table.description ?? "", table.primaryKeyColumns.length ? `primary key (${table.primaryKeyColumns.join(", ")})` : "", ...table.columns.map(column => `${column.name} ${column.type}${column.nullable ? " nullable" : " not nullable"}`), ...indexDetails].filter(Boolean).join(". ");
    return `<g class="database__table${selected ? " is-selected" : ""}${selectedId && !selected && !relatedTables.has(table.visualId) ? " is-unrelated" : ""}${state ? ` review-change review-change--${state}` : ""}" data-node-id="${xml(table.semanticTableId)}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="Table ${xml(tableDetails)}"><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.requiredWidth}" height="${bounds.requiredHeight}" rx="5"/><text class="database__header" x="${bounds.x + 10}" y="${bounds.y + 27}">${xml(label)}</text>${rows}<title>${xml(tableDetails)}</title></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geometry.width} ${geometry.height}" role="group" aria-label="Database Diagram"><style>.database__table{color:var(--text,#202634);cursor:pointer}.database__table rect{fill:var(--bg-panel,#fff);stroke:var(--border-strong,#303a50);stroke-width:1.5}.database__table.is-selected rect{stroke:var(--accent,#6ca9ff);stroke-width:3}.database__table:focus rect,.database__column:focus line{stroke:var(--accent,#6ca9ff);stroke-width:3}.database__header,.database__name{fill:var(--text,#202634);font:600 14px system-ui,sans-serif}.database__type{fill:var(--text-muted,#5b6478);font:12px system-ui,sans-serif}.database__column line{stroke:var(--border,#d5d9e2);stroke-width:1}.database__fk path{fill:none;stroke:var(--text-muted,#687287);stroke-width:2;marker-end:url(#database-arrow);vector-effect:non-scaling-stroke}.database__fk{color:var(--text-muted,#687287)}.is-unrelated{opacity:.24}.database__fk.is-related path{stroke:var(--accent,#6ca9ff);stroke-width:3}.review-change--added{filter:drop-shadow(0 0 4px #2b9b62)}.review-change--removed{opacity:.55}.review-change--modified{filter:drop-shadow(0 0 4px #d49b27)}</style><defs><marker id="database-arrow" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0 0L9 4L0 8z" fill="currentColor"/></marker></defs>${nodes}${edges}</svg>`;
}
