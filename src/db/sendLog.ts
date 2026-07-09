import type { SendLogKind, SendLogListItem } from './types';

/**
 * send_log: cron 駆動送信の記録（ADR 0013）。冪等台帳・ペースカーソル・可視化を兼ねる。
 * 毎分 cron のペース配信は「claim → 送信 → finish」で進める。UNIQUE(notification_id,
 * occurrence_id, user_id, kind, send_date) により毎分実行でも二重送信を防ぐ。
 * occurrence_id 既定 0＝開催回に紐づかない（ノルマ等）/ user_id 既定 ''＝チャンネル投稿。
 */
export interface SendKey {
  notification_id: number;
  occurrence_id?: number;
  user_id?: string;
  kind: SendLogKind;
  send_date: string;
}

/**
 * 送信を claim する。INSERT OR IGNORE で status='sending' 行を立て、新規に立てられたら true
 * （＝この送信は自分が担当する）。既に行があれば false（他ティックが claim 済み／送信済み）。
 * 予算を消費する前に呼び、true のときだけ実際に送信する。
 */
export async function claimSend(db: D1Database, k: SendKey): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO send_log
         (notification_id, occurrence_id, user_id, kind, send_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'sending', ?)`,
    )
    .bind(
      k.notification_id,
      k.occurrence_id ?? 0,
      k.user_id ?? '',
      k.kind,
      k.send_date,
      new Date().toISOString(),
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** claim 済み送信の結果を確定する（sent / failed）。 */
export async function finishSend(
  db: D1Database,
  k: SendKey,
  ok: boolean,
  error: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE send_log SET status = ?, error = ?
         WHERE notification_id = ? AND occurrence_id = ? AND user_id = ? AND kind = ? AND send_date = ?`,
    )
    .bind(
      ok ? 'sent' : 'failed',
      ok ? null : error,
      k.notification_id,
      k.occurrence_id ?? 0,
      k.user_id ?? '',
      k.kind,
      k.send_date,
    )
    .run();
}

/**
 * failed で終わった claim を sending に戻して再取得する（手動再送用）。
 * 同日 UNIQUE 鍵に failed 行が残ると claimSend が弾いて当日中の再送ができないため、
 * 管理画面の「今すぐ募集」はこれで失敗分を明示的に取り直す（sending/sent は対象外＝二重送信防止は維持）。
 */
export async function reclaimFailedSend(db: D1Database, k: SendKey): Promise<boolean> {
  return reclaimSend(db, k, 'failed');
}

/**
 * sent で終わった claim を sending に戻して再取得する（手動の強制再送用）。
 * Discord 上で投稿を削除した後の再送は Bot 側から削除を検知できないため、
 * 管理画面の確認ダイアログ了承（force）に限って使う。sending は対象外＝並行実行ガードは維持。
 */
export async function reclaimSentSend(db: D1Database, k: SendKey): Promise<boolean> {
  return reclaimSend(db, k, 'sent');
}

async function reclaimSend(
  db: D1Database,
  k: SendKey,
  status: 'failed' | 'sent',
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE send_log SET status = 'sending', error = NULL
         WHERE notification_id = ? AND occurrence_id = ? AND user_id = ? AND kind = ? AND send_date = ?
           AND status = ?`,
    )
    .bind(k.notification_id, k.occurrence_id ?? 0, k.user_id ?? '', k.kind, k.send_date, status)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * クラッシュ等で status='sending' のまま残った claim を回収する（ADR 0013）。
 * 指定時刻より前の 'sending' 行を削除し、次ティックで再送できるようにする（毎ティック先頭で呼ぶ）。
 */
export async function clearStaleClaims(db: D1Database, olderThanIso: string): Promise<void> {
  await db
    .prepare("DELETE FROM send_log WHERE status = 'sending' AND created_at < ?")
    .bind(olderThanIso)
    .run();
}

/**
 * その開催回にこの種別のチャンネル送信が済んでいるか（send_date は無視・failed は数えない）。
 * 「開催回につき 1 回」の送信（募集など）の跨日デデュープに使う。send_date を無視するため、
 * 旧キー（send_date=実行日）で記録済みの行にもヒットし、キー運用の変更を跨いでも二重送信しない。
 */
export async function hasSentKind(
  db: D1Database,
  notificationId: number,
  occurrenceId: number,
  kind: SendLogKind,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM send_log
        WHERE notification_id = ? AND occurrence_id = ? AND user_id = '' AND kind = ?
          AND status IN ('sending', 'sent') LIMIT 1`,
    )
    .bind(notificationId, occurrenceId, kind)
    .first();
  return row != null;
}

/** 指定キーが既に存在するか（claim 済み／送信済み）。テスト・推定用の読み取りヘルパ。 */
export async function isSendLogged(db: D1Database, k: SendKey): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM send_log
        WHERE notification_id = ? AND occurrence_id = ? AND user_id = ? AND kind = ? AND send_date = ?`,
    )
    .bind(k.notification_id, k.occurrence_id ?? 0, k.user_id ?? '', k.kind, k.send_date)
    .first();
  return row != null;
}

/**
 * 管理 UI: リマインド送信履歴を取得（新しい順）。notifications / occurrences を JOIN。
 * guildId 指定時は notifications.guild_id でサーバー単位に絞る（未指定は全サーバー横断）。
 */
export async function listSendLog(
  db: D1Database,
  opts: { limit?: number; notificationId?: number; guildId?: string } = {},
): Promise<SendLogListItem[]> {
  const limit = opts.limit ?? 300;
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.notificationId) {
    conds.push('s.notification_id = ?');
    params.push(opts.notificationId);
  }
  if (opts.guildId) {
    conds.push('n.guild_id = ?');
    params.push(opts.guildId);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(limit);
  const { results } = await db
    .prepare(
      `SELECT s.id, s.notification_id, s.occurrence_id, s.user_id, s.kind, s.send_date,
              s.status, s.error, s.created_at,
              n.name AS notification_name,
              COALESCE(gp.display_name, m.display_name, m.user_name) AS user_name,
              (SELECT o.occurrence_date FROM occurrences o WHERE o.id = s.occurrence_id AND s.occurrence_id != 0) AS occurrence_date
         FROM send_log s
         JOIN notifications n ON n.id = s.notification_id
         LEFT JOIN members m ON m.user_id = s.user_id
         LEFT JOIN member_guild_profiles gp ON gp.user_id = s.user_id AND gp.guild_id = n.guild_id
         ${where}
        ORDER BY s.created_at DESC
        LIMIT ?`,
    )
    .bind(...params)
    .all<SendLogListItem>();
  return results;
}
