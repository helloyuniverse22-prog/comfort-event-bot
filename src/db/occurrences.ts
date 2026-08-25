import type { Occurrence, OccurrenceOrigin, OccurrenceStatus } from './types';
import { newUuid } from './uuid';

const COLS = 'id, uuid, notification_id, occurrence_date, start_time, status, origin, note, created_at';

/**
 * Occurrence を取得 or 生成。UNIQUE(notification_id, occurrence_date, start_time) で upsert。
 * スロットの同一性は (notification_id, occurrence_date, start_time) で判定する。
 * 既存なら（cancelled でも・origin が違っても）その行を返す。
 * origin: 'rule'=RRULE から実体化（ロールフォワード・仮想行の実体化）／'manual'=運用者の追加（臨時回・不定期）。
 */
export async function getOrCreateOccurrence(
  db: D1Database,
  notificationId: number,
  dateStr: string,
  startTime: string,
  origin: OccurrenceOrigin = 'manual',
): Promise<Occurrence> {
  const existing = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE notification_id = ? AND occurrence_date = ? AND start_time = ?`,
    )
    .bind(notificationId, dateStr, startTime)
    .first<Occurrence>();
  if (existing) return existing;

  const uuid = newUuid();
  const res = await db
    .prepare(
      'INSERT INTO occurrences (uuid, notification_id, occurrence_date, start_time, origin) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(uuid, notificationId, dateStr, startTime, origin)
    .run();
  const id = res.meta.last_row_id as number;
  const row = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE id = ?`)
    .bind(id)
    .first<Occurrence>();
  return (
    row ?? {
      id,
      uuid,
      notification_id: notificationId,
      occurrence_date: dateStr,
      start_time: startTime,
      status: 'scheduled',
      origin,
      note: null,
      created_at: '',
    }
  );
}

/** 単一 Occurrence 取得（未登録なら null） */
export async function getOccurrence(db: D1Database, id: number): Promise<Occurrence | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE id = ?`)
    .bind(id)
    .first<Occurrence>();
  return row ?? null;
}

/** UUID で Occurrence を取得（未登録なら null・ADR 0016） */
export async function getOccurrenceByUuid(
  db: D1Database,
  uuid: string,
): Promise<Occurrence | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM occurrences WHERE uuid = ?`)
    .bind(uuid)
    .first<Occurrence>();
  return row ?? null;
}

/** Notification の最新の予定回（occurrence_date 最大・status='scheduled'）。無ければ null */
export async function getLatestScheduledOccurrence(
  db: D1Database,
  notificationId: number,
): Promise<Occurrence | null> {
  const row = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE notification_id = ? AND status = 'scheduled'
        ORDER BY occurrence_date DESC, start_time DESC LIMIT 1`,
    )
    .bind(notificationId)
    .first<Occurrence>();
  return row ?? null;
}

/** 開催回ステータス更新（'scheduled' / 'cancelled'）。対象が無ければ false */
export async function setOccurrenceStatus(
  db: D1Database,
  id: number,
  status: OccurrenceStatus,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE occurrences SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * 今日以降の開催回を全通知ぶん一括取得する（両ステータス・日付昇順）。
 * 毎分 cron の対象決定用: 通知ごとの個別クエリを避け、1 ティック 1 クエリに抑える。
 */
export async function listFutureOccurrencesAll(
  db: D1Database,
  todayStr: string,
): Promise<Occurrence[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE occurrence_date >= ?
        ORDER BY occurrence_date ASC, start_time ASC`,
    )
    .bind(todayStr)
    .all<Occurrence>();
  return results;
}

/**
 * その通知のその日付に中止（cancelled）の回があるか（時刻は無視）。
 * recurring の送信ゲート用の墓石照合。通知の start_time を変更しても
 * 「その日を中止した」意図が生き残るよう、日付だけで判定する。
 */
export async function hasCancelledOccurrenceOnDate(
  db: D1Database,
  notificationId: number,
  dateStr: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM occurrences
        WHERE notification_id = ? AND occurrence_date = ? AND status = 'cancelled' LIMIT 1`,
    )
    .bind(notificationId, dateStr)
    .first<{ x: number }>();
  return !!row;
}

/** 補足メッセージを更新（NULL=なし）。対象が無ければ false */
export async function setOccurrenceNote(
  db: D1Database,
  id: number,
  note: string | null,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE occurrences SET note = ? WHERE id = ?')
    .bind(note, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 開催日を更新（リスケ）。対象が無ければ false */
export async function updateOccurrenceDate(
  db: D1Database,
  id: number,
  dateStr: string,
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE occurrences SET occurrence_date = ? WHERE id = ?')
    .bind(dateStr, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Notification の開催回一覧（新しい順） */
export async function listOccurrencesForNotification(
  db: D1Database,
  notificationId: number,
  limit = 100,
): Promise<Occurrence[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE notification_id = ?
        ORDER BY occurrence_date DESC, start_time DESC LIMIT ?`,
    )
    .bind(notificationId, limit)
    .all<Occurrence>();
  return results;
}

/** Notification の予定回（status='scheduled'）を日付昇順で返す。 */
export async function listScheduledOccurrences(
  db: D1Database,
  notificationId: number,
): Promise<Occurrence[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM occurrences
        WHERE notification_id = ? AND status = 'scheduled'
        ORDER BY occurrence_date ASC, start_time ASC`,
    )
    .bind(notificationId)
    .all<Occurrence>();
  return results;
}

/**
 * ルール（rrule / anchor_date / start_time）変更時の掃除（docs/dev/schedule-recurrence-redesign.md §5.3）。
 * 今日以降の **origin='rule' かつ scheduled かつ「何も起きていない」行**（send_log に sending/sent なし・
 * 回答なし・メンバー配置なし）だけを DELETE する。投稿済み・回答あり・配置ありの rule 行、manual 行、
 * cancelled（墓石）、過去の行は保持。削除後に次ティックのロールフォワードが新ルールで再実体化する。
 * @returns pruned=削除件数 / kept_posted=保持した今日以降の scheduled な rule 行の件数（投稿済み等・UI 案内用）
 */
export async function pruneRuleOccurrences(
  db: D1Database,
  notificationId: number,
  todayStr: string,
): Promise<{ pruned: number; kept_posted: number }> {
  const res = await db
    .prepare(
      `DELETE FROM occurrences
        WHERE notification_id = ? AND origin = 'rule' AND status = 'scheduled' AND occurrence_date >= ?
          AND NOT EXISTS (SELECT 1 FROM send_log s WHERE s.occurrence_id = occurrences.id AND s.status IN ('sending', 'sent'))
          AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.occurrence_id = occurrences.id)
          AND NOT EXISTS (SELECT 1 FROM groupings g WHERE g.occurrence_id = occurrences.id)`,
    )
    .bind(notificationId, todayStr)
    .run();
  const kept = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM occurrences
        WHERE notification_id = ? AND origin = 'rule' AND status = 'scheduled' AND occurrence_date >= ?`,
    )
    .bind(notificationId, todayStr)
    .first<{ c: number }>();
  return { pruned: (res.meta.changes as number) ?? 0, kept_posted: kept?.c ?? 0 };
}
