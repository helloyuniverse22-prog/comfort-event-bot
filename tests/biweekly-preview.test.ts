// 管理UI「募集メッセージ プレビュー」の隔週次回日計算（起点パリティ反映・2026-08-18 問い合わせ起点）。
// 起点 8/24 選択時にプレビューが直近の月曜 8/17 を出す表示バグの回帰テスト。
import { describe, expect, it } from 'vitest';
import { anchorMatchesWeekday, nextBiweeklyFromAnchor } from '../ui/src/lib/rrule';

describe('nextBiweeklyFromAnchor', () => {
  const today = new Date(2026, 7, 17); // 2026/08/17 (月)

  it('未来の起点はそのまま返す（8/24 起点で 8/17 に化けない）', () => {
    expect(nextBiweeklyFromAnchor('2026/08/24', today)).toBe('2026/08/24');
    expect(nextBiweeklyFromAnchor('2026/08/31', today)).toBe('2026/08/31');
    expect(nextBiweeklyFromAnchor('2026/09/07', today)).toBe('2026/09/07');
  });

  it('当日の起点は当日', () => {
    expect(nextBiweeklyFromAnchor('2026/08/17', today)).toBe('2026/08/17');
  });

  it('過去の起点は14日刻みで今日以降の最初の日へ進める', () => {
    expect(nextBiweeklyFromAnchor('2026/08/10', today)).toBe('2026/08/24');
    expect(nextBiweeklyFromAnchor('2026/08/03', today)).toBe('2026/08/17');
    expect(nextBiweeklyFromAnchor('2026/06/01', today)).toBe('2026/08/24');
  });

  it('不正な起点は null（呼び出し側でフォールバック）', () => {
    expect(nextBiweeklyFromAnchor('', today)).toBeNull();
    expect(nextBiweeklyFromAnchor('invalid', today)).toBeNull();
  });
});

describe('anchorMatchesWeekday', () => {
  it('曜日一致の判定（曜日変更後の旧起点リセット用）', () => {
    expect(anchorMatchesWeekday('2026/08/24', 'MO')).toBe(true); // 月曜
    expect(anchorMatchesWeekday('2026/08/22', 'MO')).toBe(false); // 土曜の起点が残った状態
    expect(anchorMatchesWeekday('', 'MO')).toBe(false);
    expect(anchorMatchesWeekday('invalid', 'MO')).toBe(false);
  });
});
