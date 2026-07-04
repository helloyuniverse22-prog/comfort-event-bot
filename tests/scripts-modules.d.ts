// scripts/ は tsconfig の対象外（Node 実行専用の .mjs）のため、テストから import する
// エクスポートだけここで型宣言する。実装を変えたらこの宣言も追従させること。
declare module '*derive-db-name.mjs' {
  export const LEGACY_DB_NAME: string;
  export function resolveDbName(env: Record<string, string | undefined>): string | null;
  export function rewriteDatabaseName(src: string, newName: string): string;
}
