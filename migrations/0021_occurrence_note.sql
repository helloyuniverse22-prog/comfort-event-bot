-- 開催回の補足メッセージ（臨時回のコラボ説明など）。
-- NULL/空 = 補足なし（従来どおり）。募集メッセージの本文と日時行の間に差し込む。
ALTER TABLE occurrences ADD COLUMN note TEXT;
