-- group_members に表示順 members_index カラムを追加（公開PR #1 / wingoflogic-pixel 由来）。
--
-- ★重要（2026-07-04 冪等化のため本ファイルを「再構築」方式へ修正）:
--   公開 public/main の 0011_grouping.sql は PR#1(commit 9ea09db)で group_members に
--   members_index を直接追加した状態で配布された。そのため public から fresh deploy した
--   環境は 0011 適用時点で既に members_index を持つ。一方 origin の 0011 は持たない。
--   無条件 `ALTER TABLE ... ADD COLUMN members_index` だと前者で「duplicate column name」で
--   失敗し、以降の 0015〜0020 が一切適用されずスキーマが 0013 で凍結される（新 Worker コードは
--   新スキーマ前提のため広範に壊れる）。
--   SQLite は ADD COLUMN IF NOT EXISTS を持たないため、members_index を参照しない列だけを
--   コピーするテーブル再構築で「列が無い環境＝追加／列がある環境＝衝突なし」を両立させる。
--   本ファイルを実行するのは 0014 未適用の環境（新規 fork ＋ members_index 入り 0011 の fork）だけ。
--   旧 0014 を適用済みの環境（本番/検証など）は再実行されない。

DROP TABLE IF EXISTS group_members_new;

CREATE TABLE group_members_new (
  group_id      INTEGER NOT NULL,
  members_index INTEGER NOT NULL DEFAULT 0,
  user_id       TEXT    NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- members_index は SELECT に含めない（origin 0011 環境には存在せず、参照するとパースエラー）。
-- 既存行は DEFAULT 0 で入り、直後の UPDATE で rowid 順に採番する。
INSERT INTO group_members_new (group_id, user_id)
  SELECT group_id, user_id FROM group_members;

DROP TABLE group_members;
ALTER TABLE group_members_new RENAME TO group_members;
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

-- 既存行に rowid 順で連番採番（グループ内 0,1,2...）。新規環境では空なので no-op。
UPDATE group_members
   SET members_index = (
     SELECT COUNT(*) FROM group_members AS gm2
      WHERE gm2.group_id = group_members.group_id
        AND gm2.rowid    < group_members.rowid
   );
