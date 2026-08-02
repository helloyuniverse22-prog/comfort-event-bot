import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { addMember } from '../src/db/members';
import { createSegment, addSegmentMember } from '../src/db/segments';
import { upsertResponse } from '../src/db/responses';
import { getAttendanceReport } from '../src/db/reports';

const db = () => env.DB;

async function insertNotification(segmentId: number, requiresResponse = 1): Promise<number> {
  const res = await db()
    .prepare(
      `INSERT INTO notifications (guild_id, segment_id, name, channel_id, type, rrule, start_time, requires_response)
       VALUES ('g1', ?, 'テスト', 'c1', 'recurring', 'FREQ=WEEKLY;BYDAY=SA', '21:00', ?)`,
    )
    .bind(segmentId, requiresResponse)
    .run();
  return res.meta.last_row_id as number;
}

async function insertOccurrence(
  notificationId: number,
  dateStr: string,
  status: 'scheduled' | 'cancelled' = 'scheduled',
): Promise<number> {
  const res = await db()
    .prepare(
      "INSERT INTO occurrences (notification_id, occurrence_date, start_time, status) VALUES (?, ?, '', ?)",
    )
    .bind(notificationId, dateStr, status)
    .run();
  return res.meta.last_row_id as number;
}

describe('getAttendanceReport（出勤レポート）', () => {
  it('デフォルト（期間未指定）は各メンバーの初出勤日を起点に集計する', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト', mention_role_id: null });
    await addMember(db(), 'u1', 'n1', 'A子');
    await addMember(db(), 'u2', 'n2', 'B子');
    await addMember(db(), 'u3', 'n3', 'C子');
    await addSegmentMember(db(), seg, 'u1');
    await addSegmentMember(db(), seg, 'u2');
    await addSegmentMember(db(), seg, 'u3');

    const nid = await insertNotification(seg.id);
    const o1 = await insertOccurrence(nid, '2026/07/01');
    const o2 = await insertOccurrence(nid, '2026/07/08');
    const o3 = await insertOccurrence(nid, '2026/07/15');
    // 未来回・中止回・回答不要通知の回は母数に入らない
    await insertOccurrence(nid, '2026/07/29');
    await insertOccurrence(nid, '2026/07/10', 'cancelled');
    const nAnnounce = await insertNotification(seg.id, 0);
    await insertOccurrence(nAnnounce, '2026/07/05');

    // u1: 3回とも参加。u2: 7/8 に初出勤し 7/15 は不参加。u3: 一度も参加なし。
    await upsertResponse(db(), o1, 'u1', 'A子', '参加');
    await upsertResponse(db(), o2, 'u1', 'A子', '参加');
    await upsertResponse(db(), o3, 'u1', 'A子', '参加');
    await upsertResponse(db(), o2, 'u2', 'B子', '参加');
    await upsertResponse(db(), o3, 'u2', 'B子', '不参加');

    const rows = await getAttendanceReport(db(), seg.id, { today: '2026/07/21' });
    const byId = new Map(rows.map((r) => [r.user_id, r]));

    const u1 = byId.get('u1')!;
    expect(u1).toMatchObject({ first_date: '2026/07/01', attended: 3, total: 3, rate: 1 });
    expect(u1.recent).toEqual(['2026/07/15', '2026/07/08', '2026/07/01']);

    const u2 = byId.get('u2')!;
    // 初出勤 7/8 起点 → 母数は 7/8・7/15 の 2 回、出勤 1 回 = 50%
    expect(u2).toMatchObject({ first_date: '2026/07/08', attended: 1, total: 2, rate: 0.5 });
    expect(u2.recent).toEqual(['2026/07/08']);

    const u3 = byId.get('u3')!;
    expect(u3).toMatchObject({ first_date: null, attended: 0, total: 0, rate: null });
    expect(u3.recent).toEqual([]);
  });

  it('notificationId 指定時はその通知の開催回だけを対象にする', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト3', mention_role_id: null });
    await addMember(db(), 'q1', 'n1', 'A');
    await addSegmentMember(db(), seg, 'q1');

    const nA = await insertNotification(seg.id);
    const nB = await insertNotification(seg.id);
    const oA = await insertOccurrence(nA, '2026/07/01');
    const oB1 = await insertOccurrence(nB, '2026/07/02');
    await insertOccurrence(nB, '2026/07/09');

    await upsertResponse(db(), oA, 'q1', 'A', '参加');
    await upsertResponse(db(), oB1, 'q1', 'A', '参加');

    const rows = await getAttendanceReport(db(), seg.id, { today: '2026/07/21', notificationId: nB });
    // 通知 B のみ: 母数 2 回（7/2・7/9）・参加 1 回。初出勤も B の中の 7/2 になる。
    expect(rows[0]).toMatchObject({ user_id: 'q1', first_date: '2026/07/02', attended: 1, total: 2, rate: 0.5 });
    expect(rows[0].recent).toEqual(['2026/07/02']);

    // 指定なしは両通知合算: 母数 3 回・参加 2 回
    const all = await getAttendanceReport(db(), seg.id, { today: '2026/07/21' });
    expect(all[0]).toMatchObject({ first_date: '2026/07/01', attended: 2, total: 3 });
  });

  it('期間指定時は全員同一期間で集計し、未参加者も 0% になる', async () => {
    const seg = await createSegment(db(), { guild_id: 'g1', name: 'キャスト2', mention_role_id: null });
    await addMember(db(), 'p1', 'n1', 'A');
    await addMember(db(), 'p2', 'n2', 'B');
    await addSegmentMember(db(), seg, 'p1');
    await addSegmentMember(db(), seg, 'p2');

    const nid = await insertNotification(seg.id);
    const o1 = await insertOccurrence(nid, '2026/06/01');
    const o2 = await insertOccurrence(nid, '2026/07/01');
    const o3 = await insertOccurrence(nid, '2026/07/10');

    await upsertResponse(db(), o1, 'p1', 'A', '参加'); // 期間外
    await upsertResponse(db(), o2, 'p1', 'A', '参加');
    await upsertResponse(db(), o3, 'p1', 'A', '参加');

    const rows = await getAttendanceReport(db(), seg.id, {
      from: '2026/07/01',
      to: '2026/07/05',
      today: '2026/07/21',
    });
    const byId = new Map(rows.map((r) => [r.user_id, r]));

    // 期間 [7/1, 7/5] → 母数は 7/1 の 1 回のみ（6/1 は期間前・7/10 は to 超過）
    expect(byId.get('p1')).toMatchObject({ attended: 1, total: 1, rate: 1, first_date: '2026/06/01' });
    expect(byId.get('p1')!.recent).toEqual(['2026/07/01']);
    expect(byId.get('p2')).toMatchObject({ attended: 0, total: 1, rate: 0 });
  });
});
