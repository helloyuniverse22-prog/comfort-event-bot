-- グループごとの連番開始番号（ADR 0015 追補2の拡張）。
-- 自動連番（ラベル上書きの無いメンバー）はこの値からカウントアップする。
ALTER TABLE groups ADD COLUMN start_no INTEGER NOT NULL DEFAULT 1;
