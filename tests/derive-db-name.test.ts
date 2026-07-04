import { describe, it, expect } from 'vitest';
import { resolveDbName, rewriteDatabaseName } from '../scripts/derive-db-name.mjs';

describe('resolveDbName（D1 名の導出・ADR 0021）', () => {
  it('何も無ければ null（既定値のまま・ローカル CLI 実行など）', () => {
    expect(resolveDbName({})).toBe(null);
    expect(resolveDbName({ DB_NAME: '', WRANGLER_CI_OVERRIDE_NAME: '  ' })).toBe(null);
  });
  it('Workers Builds では Worker 名から `<Worker名>-db` を導出', () => {
    expect(resolveDbName({ WRANGLER_CI_OVERRIDE_NAME: 'sgn-discord-event-bot' })).toBe(
      'sgn-discord-event-bot-db',
    );
  });
  it('DB_NAME（明示指定）が Worker 名導出より優先される（既存利用者の固定名）', () => {
    expect(
      resolveDbName({ DB_NAME: 'sgn-event-bot-db', WRANGLER_CI_OVERRIDE_NAME: 'sgn-discord-event-bot' }),
    ).toBe('sgn-event-bot-db');
  });
  it('D1 名に使えない文字は throw（静かに壊れない）', () => {
    expect(() => resolveDbName({ DB_NAME: "bad name'--" })).toThrow(/不正/);
  });
});

describe('rewriteDatabaseName（wrangler.jsonc の書き換え）', () => {
  const jsonc = [
    '{',
    '  // database_name はコメントにも登場する',
    '  "d1_databases": [{ "binding": "DB", "database_name": "choiemu-event-bot-db" }],',
    '  "env": { "staging": { "d1_databases": [{ "database_name": "choiemu-event-bot-db-staging" }] } }',
    '}',
  ].join('\n');

  it('base のみ書き換え、staging（-staging 付き）は温存する', () => {
    const out = rewriteDatabaseName(jsonc, 'my-bot-db');
    expect(out).toContain('"database_name": "my-bot-db"');
    expect(out).toContain('"database_name": "choiemu-event-bot-db-staging"');
    expect(out).not.toContain('"database_name": "choiemu-event-bot-db"');
  });
  it('既定値が見つからない構成では throw（構成変更の検知）', () => {
    expect(() => rewriteDatabaseName('{ "d1_databases": [] }', 'x')).toThrow(/1 箇所/);
  });
  it('同じ値への書き換え（DB_NAME=既定値）も成立する', () => {
    expect(rewriteDatabaseName(jsonc, 'choiemu-event-bot-db')).toBe(jsonc);
  });
});
