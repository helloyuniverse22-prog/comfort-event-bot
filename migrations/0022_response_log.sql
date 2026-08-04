-- 回答の変更履歴（追記型）。responses は (occurrence_id, user_id) の最新状態のみ持つため、
-- △→◯ のような遷移が消えていた。upsertResponse のたびに 1 行 INSERT し、管理UIの
-- 「回答履歴」はこちらを表示する（responses は集計・リマインド用の現在値として従来どおり）。
CREATE TABLE IF NOT EXISTS response_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  occurrence_id        INTEGER NOT NULL,
  user_id              TEXT    NOT NULL,
  user_name            TEXT,
  status               TEXT    NOT NULL,              -- 参加 / 不参加 / 未定
  post_deadline_change INTEGER NOT NULL DEFAULT 0,    -- この変更が締切後だったか（行ごと・sticky ではない）
  changed_at           TEXT    NOT NULL               -- ISO(UTC)。表示は JST 変換
);
CREATE INDEX IF NOT EXISTS idx_response_log_occ ON response_log(occurrence_id);

-- 既存の最新回答を初期行として取り込む（履歴の起点。過去の遷移は復元不能）
INSERT INTO response_log (occurrence_id, user_id, user_name, status, post_deadline_change, changed_at)
  SELECT occurrence_id, user_id, user_name, status, post_deadline_change, updated_at FROM responses;
