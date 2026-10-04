import type { SourceRange } from "../../domain/diagram/ast";

export type DatabaseDeclaration =
  | { kind: "title"; value: string; range: SourceRange }
  | { kind: "description"; value: string; range: SourceRange }
  | { kind: "schema"; id: string; name: string; range: SourceRange }
  | { kind: "table"; id: string; schemaId?: string; name: string; range: SourceRange }
  | { kind: "column"; tableId: string; id?: string; name: string; type: string; nullable: boolean; default?: string; description?: string; range: SourceRange }
  | { kind: "primary-key"; id: string; tableId: string; columns: string[]; range: SourceRange }
  | { kind: "unique"; id: string; tableId: string; columns: string[]; range: SourceRange }
  | { kind: "index"; id: string; tableId: string; columns: string[]; range: SourceRange }
  | { kind: "foreign-key"; id: string; sourceTableId: string; sourceColumns: string[]; targetTableId: string; targetColumns: string[]; range: SourceRange };
export interface DatabaseSyntax { declarations: DatabaseDeclaration[] }
