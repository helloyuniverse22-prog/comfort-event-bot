import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createSegment } from '../src/db/segments';
import {
  deactivateNotificationsForGuild,
  listActiveNotifications,
  listNotificationsByGuild,
} from '../src/db/notifications';

const db = () => env.DB;

async function insertNotification(guildId: string, segmentId: number, active = 1): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO notifications (guild_id, segment_id, name, channel_id, type, rrule, start_time, active)
       VALUES (?, ?, 'テスト', 'c1', 'recurring', 'FREQ=WEEKLY;BYDAY=SA', '21:00', ?)`,
    )
    .bind(guildId, segmentId, active)
    .run();
}

describe('deactivateNotificationsForGuild（サーバー退出時の論理削除）', () => {
  it('対象ギルドの通知だけ無効化し、cron 対象から外れる（他ギルドは無傷）', async () => {
    const segA = await createSegment(db(), { guild_id: 'leave-a', name: 'A', mention_role_id: null });
    const segB = await createSegment(db(), { guild_id: 'leave-b', name: 'B', mention_role_id: null });
    await insertNotification('leave-a', segA.id);
    await insertNotification('leave-a', segA.id);
    await insertNotification('leave-a', segA.id, 0); // 元から無効（件数に数えない）
    await insertNotification('leave-b', segB.id);

    const changed = await deactivateNotificationsForGuild(db(), 'leave-a');
    expect(changed).toBe(2);

    // cron が拾う active 集合から leave-a が消え、leave-b は残る
    const active = await listActiveNotifications(db());
    expect(active.filter((n) => n.guild_id === 'leave-a')).toHaveLength(0);
    expect(active.filter((n) => n.guild_id === 'leave-b')).toHaveLength(1);

    // 行自体は残る（論理削除＝再招待で復元できる）
    const rows = await listNotificationsByGuild(db(), 'leave-a');
    expect(rows).toHaveLength(3);
    expect(rows.every((n) => n.active === 0)).toBe(true);
  });

  it('対象が無い / 二重実行しても 0 件で安全', async () => {
    expect(await deactivateNotificationsForGuild(db(), 'no-such-guild')).toBe(0);
    const seg = await createSegment(db(), { guild_id: 'leave-c', name: 'C', mention_role_id: null });
    await insertNotification('leave-c', seg.id);
    expect(await deactivateNotificationsForGuild(db(), 'leave-c')).toBe(1);
    expect(await deactivateNotificationsForGuild(db(), 'leave-c')).toBe(0);
  });
});
