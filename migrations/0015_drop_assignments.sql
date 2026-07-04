-- 番号割り当て機能の撤去（ADR 0018 廃止）。
-- グループ分け改め「メンバー配置」（グループ数1＋order_no）で番号用途を代替するため、
-- assignments テーブルを削除する。notifications.assignment_enabled 列は SQLite の
-- 列削除コスト回避のため休眠残置（機能としては未使用）。
DROP TABLE IF EXISTS assignments;
