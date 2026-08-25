-- 配信の流れの工程スイッチ（案A・2026-08-23・ADR 0026）
--
-- 各工程を「自動では行わない」にできるフラグ。数値（recruit_days_before 等）は OFF でも保持し、
-- ON に戻したとき元の日数に復帰する（quota_enabled + quota_interval_days と同じ「フラグ＋数値」方式）。
--   recruit_enabled           = 0: 募集/告知を自動投稿しない（開催回タブの「📣 今すぐ募集」／ /notify で手動投稿）。
--                                  ノルマ督促は募集投稿日に送るため、0 のときは送られない。
--   remind_unanswered_enabled = 0: 未回答者へのリマインド DM を送らない
--   remind_undecided_enabled  = 0: 未定者へのリマインド DM を送らない
-- 回答締切は既存の response_deadline_hours IS NULL（＝締切なし）をそのまま使う。既存行はすべて 1（挙動不変）。
ALTER TABLE notifications ADD COLUMN recruit_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN remind_unanswered_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN remind_undecided_enabled INTEGER NOT NULL DEFAULT 1;
