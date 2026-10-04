export interface DatabaseSchema { id: string; name: string }
export interface DatabaseColumn {
  id?: string; name: string; type: string; nullable: boolean;
  default?: string; description?: string;
}
export interface DatabaseKey { id: string; columns: string[]; name?: string }
export interface DatabaseIndex { id: string; columns: string[]; name?: string }
export interface DatabaseTable {
  id: string; schemaId?: string; name: string; description?: string;
  columns: DatabaseColumn[]; primaryKey?: DatabaseKey;
  uniqueConstraints: DatabaseKey[]; indexes: DatabaseIndex[];
}
export interface DatabaseForeignKey {
  id: string; sourceTableId: string; sourceColumns: string[];
  targetTableId: string; targetColumns: string[]; name?: string;
}
export interface DatabaseModel {
  title?: string; description?: string; schemas: DatabaseSchema[];
  tables: DatabaseTable[]; foreignKeys: DatabaseForeignKey[];
}
