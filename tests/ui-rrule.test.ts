// 管理UI の繰り返しヘルパ（ui/src/lib/rrule.ts）: フォーム状態 ⇄ 文法モデルの往復と要約文言（docs §6.4）。
// 既存の保存形式（毎週・隔週・毎月第N曜）を開いて保存しても文字列が変わらないこと（往復不変）を担保する。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULE_FORM,
  daysFromToday,
  describeRule,
  modelFromRuleForm,
  parseRule,
  ruleFormFromModel,
  rruleFromRuleForm,
  shortDate,
  shortDateWithWeekday,
} from '../ui/src/lib/rrule';

describe('ruleFormFromModel → modelFromRuleForm → formatRule（往復不変）', () => {
  it.each([
    'FREQ=WEEKLY;BYDAY=SA',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
    'FREQ=MONTHLY;BYDAY=2SA',
    'FREQ=MONTHLY;BYDAY=1SU,3SU,5SU',
    'FREQ=MONTHLY;BYDAY=1SU,3TU',
    'FREQ=MONTHLY;BYDAY=-1SA',
    'FREQ=DAILY',
    'FREQ=DAILY;INTERVAL=3',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    'FREQ=WEEKLY;INTERVAL=3;BYDAY=SA,SU',
    'FREQ=MONTHLY;BYMONTHDAY=1,15',
    'FREQ=MONTHLY;BYMONTHDAY=-1',
    'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15,-1',
    'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20',
    'FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29',
  ])('%s', (s) => {
    expect(rruleFromRuleForm(ruleFormFromModel(parseRule(s)))).toBe(s);
  });

  it('不定期（null）⇄ IRREGULAR', () => {
    const f = ruleFormFromModel(null);
    expect(f.freq).toBe('IRREGULAR');
    expect(modelFromRuleForm(f)).toBeNull();
    expect(rruleFromRuleForm(f)).toBeNull();
  });

  it('フォームの既定は毎週 土曜', () => {
    expect(rruleFromRuleForm(DEFAULT_RULE_FORM)).toBe('FREQ=WEEKLY;BYDAY=SA');
  });

  it('入力不足・間隔不正は null（保存不可）', () => {
    expect(modelFromRuleForm({ ...DEFAULT_RULE_FORM, weekdays: [] })).toBeNull();
    expect(modelFromRuleForm({ ...DEFAULT_RULE_FORM, freq: 'MONTHLY', monthlyMode: 'bymonthday', monthDays: [] })).toBeNull();
    expect(modelFromRuleForm({ ...DEFAULT_RULE_FORM, interval: 0 })).toBeNull();
    expect(modelFromRuleForm({ ...DEFAULT_RULE_FORM, interval: 27 })).toBeNull();
    expect(modelFromRuleForm({ ...DEFAULT_RULE_FORM, interval: NaN })).toBeNull();
    expect(modelFromRuleForm({ ...DEFAULT_RULE_FORM, interval: 26 })).not.toBeNull();
  });

  it('毎月 第N曜の重複ルールは除去して保存（1SU,1SU → 1SU）', () => {
    const f = {
      ...DEFAULT_RULE_FORM,
      freq: 'MONTHLY' as const,
      monthlyMode: 'byday' as const,
      monthlyRules: [
        { nth: '1', byday: 'SU' },
        { nth: '1', byday: 'SU' },
        { nth: '3', byday: 'TU' },
      ],
    };
    expect(rruleFromRuleForm(f)).toBe('FREQ=MONTHLY;BYDAY=1SU,3TU');
  });
});

describe('describeRule - 要約文言（§6.4）', () => {
  const d = (s: string | null, next?: string | null, dur: number | null = null, time = '21:00') =>
    describeRule(parseRule(s), time, dur, next);
  const thisYear = new Date().getFullYear();
  it.each<[string | null, string | null | undefined, number | null, string]>([
    ['FREQ=DAILY', null, null, '毎日 21:00〜'],
    ['FREQ=DAILY;INTERVAL=3', `${thisYear}/09/05`, null, '3日おき 21:00〜（次回 9/5）'],
    ['FREQ=WEEKLY;BYDAY=SA,SU', null, 120, '毎週 土・日曜日 21:00〜23:00'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', `${thisYear}/09/05`, null, '隔週 土曜日 21:00〜（次回 9/5）'],
    ['FREQ=WEEKLY;INTERVAL=3;BYDAY=WE', `${thisYear}/09/09`, null, '3週おき 水曜日 21:00〜（次回 9/9）'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', null, null, '毎週 平日（月〜金） 21:00〜'],
    ['FREQ=MONTHLY;BYDAY=1SU,3SU,5SU', null, null, '毎月 第1・第3・第5 日曜日 21:00〜'],
    ['FREQ=MONTHLY;BYDAY=1SU,3TU', null, null, '毎月 第1日曜・第3火曜 21:00〜'],
    ['FREQ=MONTHLY;BYDAY=-1FR', null, null, '毎月 最終 金曜日 21:00〜'],
    ['FREQ=MONTHLY;BYMONTHDAY=1,15', null, null, '毎月 1日・15日 21:00〜'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', null, null, '毎月 月末 21:00〜'],
    ['FREQ=MONTHLY;BYMONTHDAY=15,-1', null, null, '毎月 15日・月末 21:00〜'],
    ['FREQ=MONTHLY;INTERVAL=2;BYDAY=2SA', `${thisYear}/10/10`, null, '隔月 第2 土曜日 21:00〜（次回 10/10）'],
    ['FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1', null, null, '3か月おき 1日 21:00〜'],
    ['FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20', null, null, '毎年 3月20日 21:00〜'],
    ['FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=20', '2099/03/20', null, '2年おき 3月20日 21:00〜（次回 2099/3/20）'],
    [null, null, null, '不定期 21:00〜'],
    [null, `${thisYear}/09/09`, null, '不定期 21:00〜（次回 9/9）'],
  ])('%s → %s', (rrule, next, dur, expected) => {
    expect(d(rrule, next, dur)).toBe(expected);
  });

  it('間隔 1 では nextDate を渡しても「次回」は付かない（一覧で混乱させない）', () => {
    expect(d('FREQ=WEEKLY;BYDAY=SA', `${thisYear}/09/05`)).toBe('毎週 土曜日 21:00〜');
  });

  it('日付の短縮表記・曜日付き・日数差', () => {
    const now = new Date(2026, 8, 2);
    expect(shortDate('2026/09/05', now)).toBe('9/5');
    expect(shortDate('2027/03/20', now)).toBe('2027/3/20');
    expect(shortDateWithWeekday('2026/09/05', now)).toBe('9/5(土)');
    expect(daysFromToday('2026/09/05', now)).toBe(3);
    expect(daysFromToday('2026/09/02', now)).toBe(0);
    expect(daysFromToday('bad', now)).toBeNaN();
  });
});

describe('describeRule - フォーム入力順に依らず保存形と同じ並びで表示', () => {
  it('日付は昇順・月末は末尾、第N曜は第N→曜日順', () => {
    expect(
      describeRule({ freq: 'MONTHLY', interval: 1, byday: [], bymonthday: [15, -1, 1], bymonth: [] }, '21:00', null),
    ).toBe('毎月 1日・15日・月末 21:00〜');
    expect(
      describeRule(
        { freq: 'MONTHLY', interval: 1, byday: [{ nth: 3, day: 'TU' }, { nth: 1, day: 'SU' }], bymonthday: [], bymonth: [] },
        '21:00',
        null,
      ),
    ).toBe('毎月 第1日曜・第3火曜 21:00〜');
  });
});
