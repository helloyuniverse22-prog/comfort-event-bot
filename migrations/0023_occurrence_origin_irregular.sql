-- 繰り返し柔軟化 Phase 2（docs/dev/schedule-recurrence-redesign.md §5.2-5.3・ADR 0025）
--
-- 1) 開催回の由来 origin:
--    'rule'   = RRULE から実体化した回（日次ロールフォワード・開催回タブ/ /notify の仮想行実体化）
--    'manual' = 運用者が追加した回（臨時回・不定期の開催回）
--    ルール（rrule/anchor_date/start_time）変更時に自動削除されるのは「origin='rule' かつ未投稿・回答なし・配置なし」
--    の行だけ。既存行は manual（＝削除されない側）に倒す。
ALTER TABLE occurrences ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('rule', 'manual'));

-- 2) 旧「単発（oneoff・日程調整）」を不定期（type='recurring', rrule=NULL）へ吸収。
--    確定済み（decided_occurrence_id≠NULL）は確定回だけ scheduled（他候補は確定時に cancelled 済み）、
--    未確定は全候補が scheduled のまま残る（運用者が開催回タブで整理）。one_off_date / decided_occurrence_id の
--    列は休眠（コードからは参照しない・既存マイグレーションは編集しない方針のため残置）。
UPDATE notifications SET type = 'recurring', rrule = NULL WHERE type = 'oneoff';
