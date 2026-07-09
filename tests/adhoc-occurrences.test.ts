import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getOccurrence,
  getOrCreateOccurrence,
  setOccurrenceNote,
  setOccurrenceStatus,
  listFutureOccurrencesAll,
} from '../src/db/occurrences';
import { claimSend, finishSend, hasSentKind, reclaimFailedSend, reclaimSentSend } from '../src/db/sendLog';
import { inSendWindow, rollforwardWindow } from '../src/cron/dailyCheck';
import type { Notification } from '../src/db/types';

const db = () => env.DB;

// Phase 2（臨時回＋cron マルチ開催回化）の部品テスト。
// occurrences / send_log に FK は無いため notification_id は任意の値で挿入できる。

describe('listFutureOccurrencesAll（未来開催回の一括取得）', () => {
  it('今日以降だけを両ステータスで返し、過去は含まない', async () => {
    const nid = 8101;
    await getOrCreateOccurrence(db(), nid, '2026/07/01', '22:00'); // 過去
    const future = await getOrCreateOccurrence(db(), nid, '2026/07/20', '22:00');
    const adhoc = await getOrCreateOccurrence(db(), nid, '2026/07/16', '21:00');
    await setOccurrenceStatus(db(), adhoc.id, 'cancelled'); // 墓石も返す
    const rows = (await listFutureOccurrencesAll(db(), '2026/07/10')).filter(
      (o) => o.notification_id === nid,
    );
    expect(rows.map((o) => o.occurrence_date)).toEqual(['2026/07/16', '2026/07/20']);
    expect(rows.map((o) => o.status)).toEqual(['cancelled', 'scheduled']);
    expect(rows.some((o) => o.id === future.id)).toBe(true);
  });
});

describe('setOccurrenceNote（臨時回の補足メッセージ）', () => {
  it('保存した note が取得時に返り、未設定は null', async () => {
    const nid = 8105;
    const occ = await getOrCreateOccurrence(db(), nid, '2026/07/17', '21:00');
    expect(occ.note).toBeNull();
    expect(await setOccurrenceNote(db(), occ.id, 'コラボ回です！')).toBe(true);
    expect((await getOccurrence(db(), occ.id))?.note).toBe('コラボ回です！');
    // 存在しない id は false
    expect(await setOccurrenceNote(db(), 999999, 'x')).toBe(false);
  });
});

describe('hasSentKind（開催回につき 1 回のチャンネル送信デデュープ）', () => {
  it('claim 中（sending）・送信済み（sent）は true、failed は false', async () => {
    const key = { notification_id: 8201, occurrence_id: 501, kind: 'recruit' as const, send_date: '2026/07/10' };
    expect(await hasSentKind(db(), 8201, 501, 'recruit')).toBe(false);
    await claimSend(db(), key);
    expect(await hasSentKind(db(), 8201, 501, 'recruit')).toBe(true); // sending
    await finishSend(db(), key, true);
    expect(await hasSentKind(db(), 8201, 501, 'recruit')).toBe(true); // sent
    // failed は数えない（翌日以降の自然リトライを許す）
    const key2 = { notification_id: 8202, occurrence_id: 502, kind: 'recruit' as const, send_date: '2026/07/10' };
    await claimSend(db(), key2);
    await finishSend(db(), key2, false, 'boom');
    expect(await hasSentKind(db(), 8202, 502, 'recruit')).toBe(false);
  });

  it('failed の claim は reclaimFailedSend で取り直せる（当日中の手動リトライ）', async () => {
    const key = { notification_id: 8205, occurrence_id: 505, kind: 'recruit' as const, send_date: '2026/07/09' };
    await claimSend(db(), key);
    await finishSend(db(), key, false, 'manual send failed');
    // failed 行が UNIQUE 鍵を塞ぐので新規 claim は不可
    expect(await claimSend(db(), key)).toBe(false);
    // 失敗分は明示的に取り直せる（sending に戻る＝送信中扱い）
    expect(await reclaimFailedSend(db(), key)).toBe(true);
    expect(await hasSentKind(db(), 8205, 505, 'recruit')).toBe(true); // sending
    // sending / sent は取り直せない（二重送信防止は維持）
    expect(await reclaimFailedSend(db(), key)).toBe(false);
    await finishSend(db(), key, true);
    expect(await reclaimFailedSend(db(), key)).toBe(false);
  });

  it('sent の claim は reclaimSentSend（force 再送）でのみ取り直せる', async () => {
    const key = { notification_id: 8206, occurrence_id: 506, kind: 'recruit' as const, send_date: '2026/07/10' };
    await claimSend(db(), key);
    // sending（送信中）は force でも取り直せない＝並行実行の二重送信ガード
    expect(await reclaimSentSend(db(), key)).toBe(false);
    await finishSend(db(), key, true);
    // sent は failed 用では取り直せず、force 用でのみ取り直せる
    expect(await reclaimFailedSend(db(), key)).toBe(false);
    expect(await reclaimSentSend(db(), key)).toBe(true);
    expect(await hasSentKind(db(), 8206, 506, 'recruit')).toBe(true); // sending に戻る
  });

  it('send_date が違っても照合する（旧キー＝実行日運用との互換）', async () => {
    const legacy = { notification_id: 8203, occurrence_id: 503, kind: 'recruit' as const, send_date: '2026/07/03' };
    await claimSend(db(), legacy);
    await finishSend(db(), legacy, true);
    // 開催日は 2026/07/10 でも、旧キー（送信実行日）で記録済みなら送信済みと判定する
    expect(await hasSentKind(db(), 8203, 503, 'recruit')).toBe(true);
  });

  it('DM 系（user_id 付き）の行には反応しない（チャンネル送信のみ対象）', async () => {
    const dm = { notification_id: 8204, occurrence_id: 504, user_id: 'u1', kind: 'remind_unanswered' as const, send_date: '2026/07/10' };
    await claimSend(db(), dm);
    await finishSend(db(), dm, true);
    expect(await hasSentKind(db(), 8204, 504, 'remind_unanswered')).toBe(false);
  });
});

describe('inSendWindow（送信窓の事前判定）', () => {
  const base: Partial<Notification> = {
    type: 'recurring',
    recruit_days_before: 7,
    remind_start_days: 3,
    remind_undecided_days: 1,
    requires_response: 1,
    response_deadline_hours: null,
  };
  const n = (over: Partial<Notification> = {}) => ({ ...base, ...over }) as Notification;

  it('募集窓は 0..recruit_days_before の範囲判定（臨時回にも募集を出す）', () => {
    expect(inSendWindow(n(), 7)).toBe(true);
    expect(inSendWindow(n(), 4)).toBe(true); // 旧実装（===7）では false だった
    expect(inSendWindow(n(), 0)).toBe(true);
    expect(inSendWindow(n(), 8)).toBe(false);
    expect(inSendWindow(n(), -1)).toBe(false); // 過去
  });

  it('announce-only（回答不要）は募集窓のみ', () => {
    // isAnnounceOnly は requires_response=0 を見る
    const ao = n({ requires_response: 0, remind_start_days: 30 });
    expect(inSendWindow(ao, 5)).toBe(true); // 募集窓
    expect(inSendWindow(ao, 20)).toBe(false); // リマインド窓は無効
  });

  it('リマインド窓が募集窓より広い設定も拾う', () => {
    expect(inSendWindow(n({ remind_start_days: 10 }), 9)).toBe(true);
  });
});

describe('rollforwardWindow（日次ロールフォワードのチャンク進行）', () => {
  const today = '2026/07/08';

  it('未設定・別日・admin クリア（空文字）は先頭から 1 チャンク', () => {
    expect(rollforwardWindow(undefined, today, 20, 8)).toEqual({ start: 0, end: 8, next: `${today}:8` });
    expect(rollforwardWindow('2026/07/07', today, 20, 8)).toEqual({ start: 0, end: 8, next: `${today}:8` });
    expect(rollforwardWindow('', today, 20, 8)).toEqual({ start: 0, end: 8, next: `${today}:8` });
  });

  it('進行中マーカーから続きを処理し、末尾に達したら完了形を書く', () => {
    expect(rollforwardWindow(`${today}:8`, today, 20, 8)).toEqual({ start: 8, end: 16, next: `${today}:16` });
    expect(rollforwardWindow(`${today}:16`, today, 20, 8)).toEqual({ start: 16, end: 20, next: today });
  });

  it('完了マーカー（当日・offset 無し）は null＝以降のティックは rrule ゼロ', () => {
    expect(rollforwardWindow(today, today, 20, 8)).toBeNull();
  });

  it('件数がチャンク以下なら 1 ティックで完了形になる', () => {
    expect(rollforwardWindow(undefined, today, 4, 8)).toEqual({ start: 0, end: 4, next: today });
    expect(rollforwardWindow('2026/07/07', today, 0, 8)).toEqual({ start: 0, end: 0, next: today });
  });

  it('壊れた offset・通知削除で範囲外になった offset も安全側に倒す', () => {
    expect(rollforwardWindow(`${today}:garbage`, today, 20, 8)).toEqual({ start: 0, end: 8, next: `${today}:8` });
    expect(rollforwardWindow(`${today}:-3`, today, 20, 8)).toEqual({ start: 0, end: 8, next: `${today}:8` });
    // 進行中に通知が削除されて offset > total → 空処理で完了形に収束
    expect(rollforwardWindow(`${today}:16`, today, 10, 8)).toEqual({ start: 10, end: 10, next: today });
  });
});
