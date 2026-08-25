// 配信の流れの順序ルール（docs/dev/flow-settings-spec.md §4・E1〜E6）。
// 管理UI（タイムラインのカード・確認ステップ）と admin API（定期の保存時検証）で共用する pure 関数。
// 深刻度はここでは決めない: 定期＝保存不可のエラー・不定期＝警告、は呼び出し側の裁定（§4・2026-08-24）。
// 判定は「開催開始からさかのぼった分」: 日単位の工程はその日の送信時刻（send_hour）、締切は開始の N 時間前。
// 締切が来たら②③のリマインドは送らない（B1・cron 側でゲート）ため、締切より後の②開始・③は「送られない」設定になる。

export type FlowStep = 'recruit' | 'remind' | 'undecided' | 'deadline';
export type FlowWarning = { step: FlowStep; head: string; detail: string };
export type FlowCheckInput = {
  requireResponse: boolean;
  /** 送信時刻（時・JST） */
  sendHour: number;
  /** 開催開始 'HH:MM' */
  startTime: string;
  /** 各工程の日数。null＝工程オフ（判定から外す）。未入力は NaN（判定しない） */
  recruitDays: number | null;
  remindStartDays: number | null;
  remindUndecidedDays: number | null;
  /** 締切: 開始の N 時間前。null＝締切なし */
  deadlineHours: number | null;
};

export const FLOW_STEP_NAMES: Record<FlowStep, string> = {
  recruit: '募集を投稿',
  remind: '未回答者へリマインド',
  undecided: '未定者へリマインド',
  deadline: '回答締切',
};

/**
 * 順序ルール違反の一覧（工程ごとに最初の 1 件・head=常時表示の見出し・detail=理由と直し方）。
 * E1: ②の開始は①と同日か後  E2: ③は①より後  E3: ④は①より後
 * E4: 0 日前の①②③は送信時刻が開催開始より前  E5: ③は④より前  E6: ②の開始は④より前
 */
export function flowWarnings(v: FlowCheckInput): FlowWarning[] {
  const out: FlowWarning[] = [];
  const [sh, sm] = v.startTime.split(':').map((x) => Number(x) || 0);
  const startMin = sh * 60 + sm;
  const sendMin = v.sendHour * 60;
  const hh = String(v.sendHour).padStart(2, '0');
  const num = (n: number | null): n is number => n != null && isFinite(n);
  /** 日単位の送信が開催開始の何分前か（0 日前で送信時刻が開始以降なら負になる） */
  const dayMin = (days: number) => days * 1440 + startMin - sendMin;
  const dayLabel = (days: number) => `${days === 0 ? '当日' : `${days}日前`} ${hh}:00`;
  const recruitWord = v.requireResponse ? '募集' : '告知';
  const announceOnly = !v.requireResponse;

  const rd = v.recruitDays; // const に置くと num() の絞り込みが後続でも効く
  const recruitOk = num(rd);
  const recruitMin = recruitOk ? dayMin(rd) : null;
  const recruitLabel = recruitOk ? `${recruitWord}（${dayLabel(rd)}）` : '';
  const afterRecruitHint =
    recruitOk && rd >= 1 ? `${recruitWord}の後（${rd - 1 === 0 ? '当日' : `${rd - 1}日前以降`}）にすると届きます。` : '';
  const dl = announceOnly ? null : v.deadlineHours;
  const deadlineOk = num(dl);
  const deadlineMin = deadlineOk ? dl * 60 : null;
  const deadlineLabel = deadlineOk ? `締切（開始${dl}時間前）` : '';

  // 当日 × 送信時刻が開始以降（E4）
  const lateDay = sendMin >= startMin;
  if (recruitOk && rd === 0 && lateDay) {
    out.push({
      step: 'recruit',
      head: `開催開始（${v.startTime}）より後の投稿`,
      detail: `当日分は開催が始まった後に投稿されます。送信時刻を早めるか、1日前にしてください。`,
    });
  }
  if (!announceOnly && num(v.remindStartDays)) {
    if (v.remindStartDays === 0 && lateDay) {
      out.push({
        step: 'remind',
        head: `開催開始（${v.startTime}）より後の送信`,
        detail: '当日は開始前にしか送らないため、このリマインドは届きません。送信時刻を早めるか、開始を 1日前にしてください。',
      });
    } else if (recruitMin != null && dayMin(v.remindStartDays) > recruitMin) {
      out.push({
        step: 'remind',
        head: `${recruitLabel}より前から催促`,
        detail: `${recruitWord}の投稿前に「回答してください」の DM が届きます。開始を${recruitWord}の日以降にしてください。`,
      });
    } else if (deadlineMin != null && dayMin(v.remindStartDays) <= deadlineMin) {
      // E6: 開始が締切と同時か後 → 締切ゲート（B1）により 1 通も送られない
      out.push({
        step: 'remind',
        head: `開始が${deadlineLabel}より後です`,
        detail: '締切で催促は止まるため、1 通も送られません。開始を締切より前の日数にしてください。',
      });
    }
  }
  if (!announceOnly && num(v.remindUndecidedDays)) {
    if (v.remindUndecidedDays === 0 && lateDay) {
      out.push({
        step: 'undecided',
        head: `開催開始（${v.startTime}）より後の送信`,
        detail: '開催が始まった後に届きます。送信時刻を早めるか、1日前にしてください。',
      });
    } else if (recruitMin != null && dayMin(v.remindUndecidedDays) >= recruitMin) {
      const same = dayMin(v.remindUndecidedDays) === recruitMin;
      out.push({
        step: 'undecided',
        head: same ? `${recruitLabel}と同じ日時です` : `${recruitLabel}より前です`,
        detail: `その時点では「未定」と答えた人がいないため、ほとんど届きません。${afterRecruitHint}`,
      });
    } else if (deadlineMin != null && dayMin(v.remindUndecidedDays) <= deadlineMin) {
      // E5: ③が締切と同時か後 → 締切ゲート（B1）により送られない
      const same = dayMin(v.remindUndecidedDays) === deadlineMin;
      out.push({
        step: 'undecided',
        head: same ? `${deadlineLabel}と同時です` : `${deadlineLabel}より後です`,
        detail: '締切で催促は止まるため送られません。締切より前の日数にしてください。',
      });
    }
  }
  if (deadlineOk && recruitMin != null && dl * 60 >= recruitMin) {
    const same = dl * 60 === recruitMin;
    out.push({
      step: 'deadline',
      head: same ? `${recruitLabel}と同時に締切` : `${recruitLabel}より前に締切`,
      detail: `誰も回答できないまま締め切られます。時間を短くするか、${recruitWord}を早めてください。`,
    });
  }
  return out;
}
