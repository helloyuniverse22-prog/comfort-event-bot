-- ギルドごとの表示名（サーバー内ニック）を保持する（ADR 0022）。
-- members.display_name はグローバルフォールバック（DM 由来などギルド不明の書き込み先）として残す。
-- 複数ギルドで同一ユーザーを扱うとき、最後に同期したギルドの nick が members.display_name を
-- 上書きして全ギルドの表示が入れ替わる問題への対応。
CREATE TABLE member_guild_profiles (
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  display_name TEXT,
  PRIMARY KEY (guild_id, user_id)
);

-- バックフィル: 現在の members.display_name を所属ギルドすべてへ撒く。
-- 過去の名前がどのギルド由来かは失われているため。次回のロール同期／ボタン回答で
-- 各ギルドの正しいニックに更新される。
INSERT INTO member_guild_profiles (guild_id, user_id, display_name)
SELECT DISTINCT s.guild_id, sm.user_id, m.display_name
  FROM segment_members sm
  JOIN segments s ON s.id = sm.segment_id
  JOIN members m ON m.user_id = sm.user_id
 WHERE m.display_name IS NOT NULL AND s.guild_id != '';
