-- Assignment / Grouping を Notification の標準機能化（ADR 0017）。
-- 0015 で導入したフラグを UI から撤廃し、全 Notification で両機能を利用可能にする。
-- スキーマ（列）は維持し、既存行のみ backfill する（マイグレーション不可逆性を尊重）。
-- 冪等: 何度走っても同じ結果になる。

UPDATE notifications SET assignment_enabled = 1, grouping_enabled = 1
  WHERE assignment_enabled = 0 OR grouping_enabled = 0;
