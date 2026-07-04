// 配布利用者の `npm run deploy` 冒頭で実行し、D1 名をインスタンスごとに導出して
// wrangler.jsonc（base）の database_name を書き換える（ADR 0021）。
//
// 目的: 同一 Cloudflare アカウントに同じ fork を複数プロジェクト接続すると、固定の
// database_name が同名 D1 の自動再利用を引き起こし、複数 Bot が 1 つの DB を共有して
// 静かに壊れる。Worker 名（＝プロジェクト名・アカウント内で一意）から D1 名を導出する
// ことで、インスタンスごとに DB が必ず分かれるようにする。
//
// 優先順位:
//   1. DB_NAME（Build variable・明示指定）… 既存利用者が従来の DB を使い続けるための固定名
//   2. WRANGLER_CI_OVERRIDE_NAME（Workers Builds が自動注入する接続先 Worker 名）→ `<Worker名>-db`
//   3. どちらも無ければ何もしない（wrangler.jsonc の既定値のまま。ローカル CLI 実行など）
//
// 書き換えはビルド環境のワークスペース内で行われ、リポジトリには影響しない。

/** 配布用 wrangler.jsonc（base）に書かれている既定の D1 名。ここを書き換え対象として特定する。 */
export const LEGACY_DB_NAME = 'choiemu-event-bot-db';

/**
 * 環境変数から使うべき D1 名を決める。null = 書き換え不要（既定値のまま）。
 * 不正な名前（D1 名に使えない文字）は事故防止のため throw してビルドを止める。
 */
export function resolveDbName(env) {
  const explicit = (env.DB_NAME ?? '').trim();
  const worker = (env.WRANGLER_CI_OVERRIDE_NAME ?? '').trim();
  const name = explicit || (worker ? `${worker}-db` : '');
  if (!name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) {
    throw new Error(
      `[derive-db-name] D1 名 '${name}' が不正です（英数字・ハイフン・アンダースコアのみ・63文字以内）。`,
    );
  }
  return name;
}

/**
 * wrangler.jsonc の base d1_databases の database_name（既定値）を newName に置き換える。
 * env.staging 側は値が異なる（`-staging` 付き）ため一致せず、影響しない。
 * 既定値がちょうど 1 箇所でなければ throw（構成が想定と違うまま静かにデプロイしない）。
 */
export function rewriteDatabaseName(src, newName) {
  const target = `"database_name": "${LEGACY_DB_NAME}"`;
  const count = src.split(target).length - 1;
  if (count !== 1) {
    throw new Error(
      `[derive-db-name] wrangler.jsonc 内の ${target} が ${count} 箇所でした（想定: 1 箇所）。` +
        'wrangler.jsonc の構成を変えた場合は scripts/derive-db-name.mjs を追従させてください。',
    );
  }
  return src.replace(target, `"database_name": "${newName}"`);
}

// --- CLI エントリ（`node scripts/derive-db-name.mjs`）---
// テスト（vitest / workers pool）から import された場合は何も実行しない。
const isCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  (process.argv[1] ?? '').endsWith('derive-db-name.mjs');

if (isCli) {
  const name = resolveDbName(process.env);
  if (name == null) {
    console.log('[derive-db-name] DB_NAME / WRANGLER_CI_OVERRIDE_NAME 未設定のため既定の D1 名を使用します。');
  } else {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const src = readFileSync('wrangler.jsonc', 'utf8');
    writeFileSync('wrangler.jsonc', rewriteDatabaseName(src, name));
    console.log(`[derive-db-name] database_name -> ${name}`);
  }
}
