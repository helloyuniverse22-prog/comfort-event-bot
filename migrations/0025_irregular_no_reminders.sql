-- 不定期スケジュールはリマインド・回答締切を持たない（flow-settings-spec §3・2026-08-24 裁定）。
-- 不定期の配信設定は「募集/告知を自動で投稿するか手動か（recruit_enabled）」だけ。②③④は定期専用。
-- admin が保存時に同じ正規化を行うため、以後この不変条件（rrule IS NULL → リマインド 0・締切 NULL）が保たれる。
-- cron はこの不変条件により種別分岐を持たない（締切がある＝定期＝募集自動、が常に成り立つ）。
UPDATE notifications
   SET remind_unanswered_enabled = 0,
       remind_undecided_enabled  = 0,
       response_deadline_hours   = NULL
 WHERE rrule IS NULL;
