-- メンバー配置投稿のカスタム Prefix（例: Leader：/ Staff：）。改行区切りで各グループの
-- 先頭メンバーから順に適用し、余ったメンバーは 1: 2: … の連番になる。NULL = 従来の連番のみ。
ALTER TABLE notifications ADD COLUMN member_prefixes TEXT;
