import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getOrCreateOccurrence,
  setOccurrenceStatus,
  hasCancelledOccurrenceOnDate,
} from '../src/db/occurrences';

const db = () => env.DB;

// 中止の墓石照合（時刻無視・日付のみ）。recurring の送信ゲートが
// start_time 変更後も「その日を中止した」意図を維持できることを検証する。
// occurrences に FK は無いため notification_id は任意の値で挿入できる。
describe('hasCancelledOccurrenceOnDate（中止の墓石・日付照合）', () => {
  it('cancelled 行があれば時刻が違っても日付一致で検出する', async () => {
    const occ = await getOrCreateOccurrence(db(), 9001, '2026/07/15', '22:00');
    await setOccurrenceStatus(db(), occ.id, 'cancelled');
    // 同じスロット
    expect(await hasCancelledOccurrenceOnDate(db(), 9001, '2026/07/15')).toBe(true);
    // start_time が 21:00 に変わった後の照合を想定 —— 日付だけで一致する
    const moved = await getOrCreateOccurrence(db(), 9001, '2026/07/15', '21:00');
    expect(moved.status).toBe('scheduled'); // 別スロットとして新規作成される（既知の仕様）
    expect(await hasCancelledOccurrenceOnDate(db(), 9001, '2026/07/15')).toBe(true);
  });

  it('別日付・別通知には反応しない', async () => {
    const occ = await getOrCreateOccurrence(db(), 9002, '2026/07/15', '22:00');
    await setOccurrenceStatus(db(), occ.id, 'cancelled');
    expect(await hasCancelledOccurrenceOnDate(db(), 9002, '2026/07/22')).toBe(false);
    expect(await hasCancelledOccurrenceOnDate(db(), 9999, '2026/07/15')).toBe(false);
  });

  it('scheduled に戻す（再開）と墓石は消える', async () => {
    const occ = await getOrCreateOccurrence(db(), 9003, '2026/07/15', '22:00');
    await setOccurrenceStatus(db(), occ.id, 'cancelled');
    expect(await hasCancelledOccurrenceOnDate(db(), 9003, '2026/07/15')).toBe(true);
    await setOccurrenceStatus(db(), occ.id, 'scheduled');
    expect(await hasCancelledOccurrenceOnDate(db(), 9003, '2026/07/15')).toBe(false);
  });

  it('scheduled 行だけでは墓石にならない', async () => {
    await getOrCreateOccurrence(db(), 9004, '2026/07/15', '22:00');
    expect(await hasCancelledOccurrenceOnDate(db(), 9004, '2026/07/15')).toBe(false);
  });
});
