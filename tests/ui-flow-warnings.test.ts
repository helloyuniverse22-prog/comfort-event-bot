// 管理UI「配信の流れ」の整合性警告（ui/src/lib/notifPreview.ts flowWarnings）。
// 判定は分単位（日単位の送信＝送信時刻、締切＝開始の N 時間前）。見出し（常時表示）と詳細（ⓘ）を返す。
import { describe, expect, it } from 'vitest';
import { flowWarnings, notifPreviewSummary, type FlowCheckInput } from '../ui/src/lib/notifPreview';

const base: FlowCheckInput = {
  requireResponse: true,
  sendHour: 21,
  startTime: '22:00',
  recruitDays: 7,
  remindStartDays: 3,
  remindUndecidedDays: 1,
  deadlineHours: null,
};
const w = (over: Partial<FlowCheckInput> = {}) => flowWarnings({ ...base, ...over });
const steps = (over: Partial<FlowCheckInput> = {}) => w(over).map((x) => x.step);

describe('flowWarnings - 判定ルール', () => {
  it('標準的な設定（募集7 → 未回答3 → 未定1 → 開催）は警告なし', () => {
    expect(w()).toEqual([]);
  });

  it('未回答の開始が募集より前: 未回答カードに「募集（N日前 HH:00）より前から催促」', () => {
    const r = w({ recruitDays: 3, remindStartDays: 5 });
    expect(r).toHaveLength(1);
    expect(r[0].step).toBe('remind');
    expect(r[0].head).toBe('募集（3日前 21:00）より前から催促');
    expect(r[0].detail).toContain('投稿前に');
    // 同じ日（同じ送信時刻）は警告しない（募集直後の DM は運用としてあり得る）
    expect(steps({ recruitDays: 3, remindStartDays: 3 })).toEqual([]);
  });

  it('未定が募集と同時か前: 未定カードに出す（未回答との前後は見ない）', () => {
    // スクショのケース: 募集3・未定4・未回答0 → 未定だけ「募集より前」。旧「未回答リマインドの開始より前」は出ない
    const r = w({ recruitDays: 3, remindUndecidedDays: 4, remindStartDays: 0 });
    expect(r.map((x) => [x.step, x.head])).toEqual([['undecided', '募集（3日前 21:00）より前です']]);
    expect(r[0].detail).toBe('その時点では「未定」と答えた人がいないため、ほとんど届きません。募集の後（2日前以降）にすると届きます。');
    // 同じ日時
    expect(w({ recruitDays: 3, remindUndecidedDays: 3 })[0].head).toBe('募集（3日前 21:00）と同じ日時です');
    // 募集 1 日前なら「当日」を案内・募集 0 日前（当日）なら案内なし
    const und = (over: Partial<FlowCheckInput>) => w({ remindStartDays: 0, ...over }).find((x) => x.step === 'undecided')!;
    expect(und({ recruitDays: 1, remindUndecidedDays: 2 }).detail).toContain('募集の後（当日）');
    expect(und({ recruitDays: 0, remindUndecidedDays: 1 }).detail).not.toContain('募集の後');
    // 未定が未回答より前でも募集より後なら何も出ない（母集団が別）
    expect(steps({ recruitDays: 7, remindStartDays: 0, remindUndecidedDays: 4 })).toEqual([]);
  });

  it('締切が募集と同時か前: 締切カードに出す（分単位で比較）', () => {
    // 開始 22:00・送信 21:00・募集 3 日前 ＝ 73 時間前（③は締切より前=12h に置いて E5 を切り分ける）
    const off = { remindStartDays: null, remindUndecidedDays: null } as const;
    const dl = (over: Partial<FlowCheckInput>) => steps({ ...off, ...over });
    expect(dl({ recruitDays: 3, deadlineHours: 72 })).toEqual([]);
    expect(w({ ...off, recruitDays: 3, deadlineHours: 73 })[0]).toMatchObject({ step: 'deadline', head: '募集（3日前 21:00）と同時に締切' });
    expect(w({ ...off, recruitDays: 3, deadlineHours: 74 })[0]).toMatchObject({ step: 'deadline', head: '募集（3日前 21:00）より前に締切' });
    // 開始が送信時刻より早い日（開始 20:00）は募集 3 日前 ＝ 71 時間前
    expect(dl({ startTime: '20:00', recruitDays: 3, deadlineHours: 70 })).toEqual([]);
    expect(dl({ startTime: '20:00', recruitDays: 3, deadlineHours: 72 })).toEqual(['deadline']);
  });

  it('E5/E6: 締切より後の③・締切より後に開始する②は「送られない」（B1 の締切ゲート）', () => {
    // 開始 22:00・送信 21:00・締切 48 時間前。③ 1 日前（25h）→ 締切の後
    const r = w({ recruitDays: 7, remindStartDays: 3, remindUndecidedDays: 1, deadlineHours: 48 });
    expect(r.map((x) => [x.step, x.head])).toEqual([['undecided', '締切（開始48時間前）より後です']]);
    expect(r[0].detail).toContain('送られません');
    // ③ 3 日前（73h）なら締切より前で OK
    expect(steps({ recruitDays: 7, remindStartDays: 3, remindUndecidedDays: 3, deadlineHours: 48 })).toEqual([]);
    // ② の開始が締切より後（開始 2 日前=49h ≦ 72h）→ 1 通も送られない
    expect(w({ recruitDays: 7, remindStartDays: 2, remindUndecidedDays: null, deadlineHours: 72 })[0]).toMatchObject({
      step: 'remind',
      head: '開始が締切（開始72時間前）より後です',
    });
    // 同時（73h ちょうど）も送られない扱い
    expect(steps({ recruitDays: 7, remindStartDays: 3, remindUndecidedDays: null, deadlineHours: 73 })).toEqual(['remind']);
    expect(steps({ recruitDays: 7, remindStartDays: 3, remindUndecidedDays: null, deadlineHours: 72 })).toEqual([]);
    // 募集オフ（不定期・手動）でも E5/E6 は①に依存しないので出る
    expect(steps({ recruitDays: null, remindStartDays: 2, remindUndecidedDays: 1, deadlineHours: 72 })).toEqual(['remind', 'undecided']);
  });

  it('0 日前 × 送信時刻 ≧ 開催開始: その工程に「開催開始より後」', () => {
    // 開始 20:00・送信 21:00
    const r = w({ startTime: '20:00', recruitDays: 0, remindStartDays: 0, remindUndecidedDays: 0 });
    expect(r.map((x) => x.step)).toEqual(['recruit', 'remind', 'undecided']);
    expect(r[0].head).toBe('開催開始（20:00）より後の投稿');
    expect(r[1].head).toBe('開催開始（20:00）より後の送信');
    expect(r[1].detail).toContain('届きません');
    // 開始 22:00 なら当日 21:00 は開始前＝「開催後」は出ない。未定 0＝募集 0 と同じ日時なのでそちらの警告だけ
    const same = w({ recruitDays: 0, remindStartDays: 0, remindUndecidedDays: 0 });
    expect(same.map((x) => [x.step, x.head])).toEqual([['undecided', '募集（当日 21:00）と同じ日時です']]);
    // 同時刻（開始 21:00・送信 21:00）も後扱い
    expect(steps({ startTime: '21:00', recruitDays: 0, remindStartDays: null, remindUndecidedDays: null })).toEqual(['recruit']);
  });

  it('オフ（null）・未入力（NaN）の工程は判定から外す', () => {
    // 募集オフ（手動投稿）なら「募集より前」系は出ない（締切なしなら何も出ない）
    expect(steps({ recruitDays: null, remindStartDays: 10, remindUndecidedDays: 10, deadlineHours: null })).toEqual([]);
    // 未定オフ
    expect(steps({ recruitDays: 3, remindUndecidedDays: null })).toEqual([]);
    // 未入力
    expect(steps({ recruitDays: NaN, remindStartDays: 10 })).toEqual([]);
    expect(steps({ recruitDays: 3, remindUndecidedDays: NaN })).toEqual([]);
  });

  it('出欠確認なし（告知）はリマインド・締切を見ず、文言は「告知」', () => {
    expect(steps({ requireResponse: false, recruitDays: 3, remindStartDays: 10, remindUndecidedDays: 10, deadlineHours: 1000 })).toEqual([]);
    expect(w({ requireResponse: false, startTime: '20:00', recruitDays: 0 })[0].head).toBe('開催開始（20:00）より後の投稿');
  });
});

describe('notifPreviewSummary - 要約文（警告は含まない）', () => {
  it('オフの工程は省き、募集オフは「手動投稿」', () => {
    const t = notifPreviewSummary({
      requireResponse: true,
      recruitDays: null,
      remindStartDays: 3,
      remindUndecidedDays: null,
      deadlineHours: 24,
      sendHour: 21,
      scheduleText: '不定期 22:00〜',
    });
    expect(t).toBe('募集は手動投稿 → 3日前から締切まで毎日 未回答へ催促 → 開始24時間前に締切 → 🎉 開催（不定期 22:00〜）／毎日 21:00 に送信');
  });
});
