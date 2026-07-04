import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createSegment } from '../src/db/segments';
import {
  upsertGrouping,
  setGroupMembers,
  setGroupStartNo,
  getGroupingView,
} from '../src/db/groupings';
import { applyBoardStateToView, memberLineLabels } from '../src/admin/index';
import type { GroupingView, Notification } from '../src/db/types';

const db = () => env.DB;
const GUILD = 'g-view';

/**
 * このテストの存在意義（バグ後の再発防止）:
 *
 * 2026-06-28 に、`getGroupingView` の戻り値で `groups[].uuid` が含まれていない不具合
 * を発見。view.groups[i].uuid が undefined のまま管理UIへ流れた結果、グループ列の
 * `data-group-key` / `id="count-..."` が全グループで同一値となり、querySelector が
 * 衝突して counter ズレ／制約違反の誤判定／rename 400／保存後の配置消失といった
 * 一連の症状を引き起こしていた。
 *
 * フィールド一個の欠落が UI 全体を機能不全にする ため、レスポンスの**形状そのもの**を
 * テストで固定化する。
 */
async function insertNotification(segmentId: number): Promise<Notification> {
  const ins = await db()
    .prepare(
      `INSERT INTO notifications (
         guild_id, segment_id, name, channel_id, type, rrule, one_off_date, start_time,
         recruit_days_before, remind_start_days, remind_undecided_days,
         quota_enabled, quota_interval_days, assignment_enabled, mention_enabled, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(GUILD, segmentId, 'n', 'c', 'recurring', 'FREQ=WEEKLY;BYDAY=SA',
      null, '21:00', 7, 3, 1, 0, null, 0, 1, 1)
    .run();
  return { id: ins.meta.last_row_id as number } as Notification;
}

async function insertOccurrence(notificationId: number): Promise<number> {
  const r = await db()
    .prepare(
      'INSERT INTO occurrences (notification_id, occurrence_date, start_time, status) VALUES (?, ?, ?, ?)',
    )
    .bind(notificationId, '2026/01/01', '21:00', 'scheduled')
    .run();
  return r.meta.last_row_id as number;
}

describe('getGroupingView レスポンス形状', () => {
  it('groups[] に uuid が必ず含まれる（非空文字列）', async () => {
    const seg = await createSegment(db(), {
      guild_id: GUILD,
      name: 'キャスト',
      mention_role_id: null,
    });
    const n = await insertNotification(seg.id);
    const occId = await insertOccurrence(n.id);
    await upsertGrouping(db(), occId, 3);

    const view = await getGroupingView(db(), occId);

    expect(view.groups.length).toBe(3);
    for (const g of view.groups) {
      expect(typeof g.uuid).toBe('string');
      expect(g.uuid.length).toBeGreaterThan(0);
    }
    // group 同士は互いに別の uuid を持つ
    const uuids = view.groups.map((g) => g.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it('group_count を変更しても残った groups は uuid を保持する', async () => {
    const seg = await createSegment(db(), {
      guild_id: GUILD,
      name: 'キャスト2',
      mention_role_id: null,
    });
    const n = await insertNotification(seg.id);
    const occId = await insertOccurrence(n.id);
    await upsertGrouping(db(), occId, 4);
    const view1 = await getGroupingView(db(), occId);
    const uuidsBefore = view1.groups.map((g) => g.uuid);
    await upsertGrouping(db(), occId, 2);
    const view2 = await getGroupingView(db(), occId);

    expect(view2.groups.length).toBe(2);
    // 残った group の uuid は変更前と一致（uuid が undefined 同士で一致してしまうケースをガード）
    expect(typeof view2.groups[0].uuid).toBe('string');
    expect(view2.groups[0].uuid.length).toBeGreaterThan(0);
    expect(view2.groups[0].uuid).toBe(uuidsBefore[0]);
    expect(view2.groups[1].uuid).toBe(uuidsBefore[1]);
  });

  it('setGroupMembers でメンバーを割り振っても uuid は欠落しない', async () => {
    const seg = await createSegment(db(), {
      guild_id: GUILD,
      name: 'キャスト3',
      mention_role_id: null,
    });
    const n = await insertNotification(seg.id);
    const occId = await insertOccurrence(n.id);
    await upsertGrouping(db(), occId, 2);
    const view1 = await getGroupingView(db(), occId);
    await setGroupMembers(db(), (await db()
      .prepare('SELECT id FROM groupings WHERE occurrence_id = ?')
      .bind(occId)
      .first<{ id: number }>())!.id, [
      { group_id: view1.groups[0].id, members: [] },
      { group_id: view1.groups[1].id, members: [] },
    ]);
    const view2 = await getGroupingView(db(), occId);

    for (const g of view2.groups) {
      expect(typeof g.uuid).toBe('string');
      expect(g.uuid.length).toBeGreaterThan(0);
    }
  });

  it('行頭ラベル（label）が保存・取得できる（migration 0017・null=自動連番）', async () => {
    const seg = await createSegment(db(), {
      guild_id: GUILD,
      name: 'キャスト4',
      mention_role_id: null,
    });
    const n = await insertNotification(seg.id);
    const occId = await insertOccurrence(n.id);
    await upsertGrouping(db(), occId, 1);
    const view1 = await getGroupingView(db(), occId);
    const groupingId = (await db()
      .prepare('SELECT id FROM groupings WHERE occurrence_id = ?')
      .bind(occId)
      .first<{ id: number }>())!.id;
    await setGroupMembers(db(), groupingId, [
      { group_id: view1.groups[0].id, members: [
        { user_id: 'U1', label: 'Leader' },
        { user_id: 'U2', label: null },
      ] },
    ]);
    const view2 = await getGroupingView(db(), occId);
    expect(view2.groups[0].members.map((m) => ({ user_id: m.user_id, label: m.label }))).toEqual([
      { user_id: 'U1', label: 'Leader' },
      { user_id: 'U2', label: null },
    ]);
  });

  it('start_no（連番開始番号）は既定 1・setGroupStartNo で更新できる（migration 0018）', async () => {
    const seg = await createSegment(db(), {
      guild_id: GUILD,
      name: 'キャスト5',
      mention_role_id: null,
    });
    const n = await insertNotification(seg.id);
    const occId = await insertOccurrence(n.id);
    await upsertGrouping(db(), occId, 2);
    const view1 = await getGroupingView(db(), occId);
    expect(view1.groups.map((g) => g.start_no)).toEqual([1, 1]);
    await setGroupStartNo(db(), view1.groups[1].id, 5);
    const view2 = await getGroupingView(db(), occId);
    expect(view2.groups.map((g) => g.start_no)).toEqual([1, 5]);
  });
});

describe('memberLineLabels（行頭ラベル・ADR 0015 追補2）', () => {
  it('上書きはそのまま・残りへ連番（上書きは連番を消費しない）。「：」は一律付与', () => {
    expect(memberLineLabels([
      { label: 'Leader' }, { label: 'Staff' }, { label: null }, { label: null },
    ])).toEqual(['Leader：', 'Staff：', '1：', '2：']);
    // 上書きが途中にあっても連番は詰める
    expect(memberLineLabels([
      { label: null }, { label: 'Leader' }, { label: null },
    ])).toEqual(['1：', 'Leader：', '2：']);
  });

  it('startNo 起点でカウントアップし、保存値の末尾「：」は二重にならない', () => {
    expect(memberLineLabels([{ label: null }, { label: null }], 5)).toEqual(['5：', '6：']);
    expect(memberLineLabels([{ label: 'Leader：' }, { label: null }], 10)).toEqual(['Leader：', '10：']);
  });
});

describe('applyBoardStateToView（盤面同送 dry-run・ADR 0015 追補）', () => {
  const mkView = (): GroupingView => ({
    grouping: { id: 1, uuid: 'gu', occurrence_id: 1, group_count: 2, created_at: '', updated_at: '' },
    groups: [
      { id: 1, uuid: 'u1', group_index: 0, name: 'グループ 1', start_no: 1, members: [{ user_id: 'A', name: 'Aさん', label: null }] },
      { id: 2, uuid: 'u2', group_index: 1, name: 'グループ 2', start_no: 1, members: [{ user_id: 'B', name: 'Bさん', label: null }] },
    ],
    pool: [{ user_id: 'C', name: 'Cさん' }],
    diff: { no_longer_participating: [], newly_participating: [] },
  });

  it('盤面の配置（label 込み）で members/pool を上書きし、名前は view 内の既知メンバーから解決する', () => {
    const view = mkView();
    applyBoardStateToView(view, [
      { group_uuid: 'u1', members: [{ user_id: 'B', label: 'Leader：' }, { user_id: 'C', label: null }] },
      { group_uuid: 'u2', members: [] },
    ], ['A']);
    // 末尾の「：」は正規化で除去される（表示時に一律付与するため）
    expect(view.groups[0].members).toEqual([
      { user_id: 'B', name: 'Bさん', label: 'Leader' },
      { user_id: 'C', name: 'Cさん', label: null },
    ]);
    expect(view.groups[1].members).toEqual([]);
    expect(view.pool).toEqual([{ user_id: 'A', name: 'Aさん' }]);
  });

  it('assignments に無い Group は保存済みのまま・未知の user_id は id をそのまま表示する', () => {
    const view = mkView();
    applyBoardStateToView(view, [{ group_uuid: 'u1', members: [{ user_id: 'X' }] }], []);
    expect(view.groups[0].members).toEqual([{ user_id: 'X', name: 'X', label: null }]);
    expect(view.groups[1].members).toEqual([{ user_id: 'B', name: 'Bさん', label: null }]);
    expect(view.pool).toEqual([]);
  });
});
