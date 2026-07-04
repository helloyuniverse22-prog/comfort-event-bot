-- メンバー配置結果の投稿先チャンネル（Notification 単位のマスター設定）。
-- NULL = 募集と同じチャンネル（notifications.channel_id）へ投稿する。
-- change_alert_channel_id と同じ「用途別チャンネル・NULL フォールバック」パターン。
ALTER TABLE notifications ADD COLUMN grouping_channel_id TEXT;
