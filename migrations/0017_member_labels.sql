-- メンバー配置の行頭ラベル上書き（開催回×メンバー単位・ADR 0015 追補2）。
-- 盤面のカードの連番をクリックして「Leader：」等に上書きする。NULL = 自動連番。
-- 通知単位の notifications.member_prefixes（migration 0016）は本方式への置き換えに伴い
-- 休眠残置（assignment_enabled と同じ扱い・機能としては未使用）。
ALTER TABLE group_members ADD COLUMN label TEXT;
