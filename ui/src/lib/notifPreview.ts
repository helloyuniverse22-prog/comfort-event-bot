// スケジュールフォームの「募集/告知メッセージ簡易プレビュー」と「送信タイムライン整合性チェック」。
// 旧 buildRecruitPreviewText()/notifPreview() の純関数移植（DOM 非依存）。
import { nextBiweeklyFromAnchor, nextWeekdayDates, wdLabel, type RepeatMode } from './rrule';

export type PreviewInput = {
  title: string;
  body: string;
  mode: RepeatMode;
  startTime: string;
  weekday: string;
  /** 隔週の起点日 'YYYY/MM/DD'（あればパリティを反映した次回日を表示） */
  biweeklyAnchor?: string;
  duration: number | null;
  deadlineHours: number | null;
  mention: 'role' | 'members' | 'none';
  requireResponse: boolean;
};

/** 日時・締切の計算済みテキスト（新旧フォームのプレビューで共用） */
export type PreviewParts = {
  mention: string | null;
  dateText: string;
  deadline: string | null;
};

/** 完全再現ではなく、フォーム入力に即時追従する部分のみの近似（メンション/複雑な月次・隔週パリティは簡略化）。 */
export function buildRecruitPreviewParts(v: PreviewInput): PreviewParts {
  let mention: string | null = null;
  if (v.mention === 'role') mention = '@ロール or @everyone';
  else if (v.mention === 'members') mention = '@対象メンバー全員';

  let dateStr = '(次回開催日)';
  let dateObj: string | null = null;
  if (v.mode === 'weekly' && v.weekday) {
    const dates = nextWeekdayDates(v.weekday, 1);
    if (dates.length) {
      dateStr = `${dates[0]} (${wdLabel(v.weekday)})`;
      dateObj = dates[0];
    }
  } else if (v.mode === 'biweekly' && v.weekday) {
    const anchored = v.biweeklyAnchor ? nextBiweeklyFromAnchor(v.biweeklyAnchor) : null;
    if (anchored) {
      const [y, m, d] = anchored.split('/').map(Number);
      dateStr = `${anchored} (${'日月火水木金土'[new Date(y, m - 1, d).getDay()]}・隔週)`;
      dateObj = anchored;
    } else {
      const dates = nextWeekdayDates(v.weekday, 1);
      if (dates.length) {
        dateStr = `${dates[0]} (${wdLabel(v.weekday)}・隔週パリティは投稿時に確定)`;
        dateObj = dates[0];
      }
    }
  } else if (v.mode === 'monthly') {
    dateStr = '(月次ルールで計算される開催日)';
  }

  let timeStr = v.startTime || '--:--';
  if (v.startTime && Number.isInteger(v.duration) && (v.duration as number) > 0) {
    const [h, m] = v.startTime.split(':').map(Number);
    const total = h * 60 + m + (v.duration as number);
    const eh = Math.floor(total / 60) % 24;
    const em = total % 60;
    timeStr = `${v.startTime}〜${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
  } else if (v.startTime) {
    timeStr = `${v.startTime}〜`;
  }
  let deadline: string | null = null;
  if (v.requireResponse && Number.isFinite(v.deadlineHours) && (v.deadlineHours as number) > 0 && dateObj && v.startTime) {
    const [yy, mm, dd] = dateObj.split('/').map(Number);
    const [hh, mi] = v.startTime.split(':').map(Number);
    const evt = new Date(yy, mm - 1, dd, hh, mi);
    evt.setHours(evt.getHours() - (v.deadlineHours as number));
    deadline = `${evt.getFullYear()}/${String(evt.getMonth() + 1).padStart(2, '0')}/${String(evt.getDate()).padStart(2, '0')} ${String(evt.getHours()).padStart(2, '0')}:${String(evt.getMinutes()).padStart(2, '0')}`;
  }

  return { mention, dateText: `${dateStr} ${timeStr}`, deadline };
}

export function buildRecruitPreviewText(v: PreviewInput): string {
  const p = buildRecruitPreviewParts(v);
  let msg = p.mention ? p.mention + '\n' : '';
  msg += `**${v.title || '(見出しを入力)'}**\n\n`;
  if (v.body) msg += v.body + '\n\n';
  msg += `日時: **${p.dateText}**`;
  if (p.deadline) msg += `\n回答締切: **${p.deadline}**`;
  if (v.requireResponse) msg += '\n\n〔参加〕〔不参加〕〔未定〕〔状況確認〕';
  return msg;
}

export type TimelineInput = {
  requireResponse: boolean;
  recruitDays: number | null;
  remindStartDays: number | null;
  remindUndecidedDays: number | null;
  deadlineHours: number | null;
  sendHour: number;
  scheduleText: string;
};

/** 配信タイムラインの自然文プレビューと整合性警告。空欄は NaN として「—」表示（比較は常に false のため誤警告なし）。 */
export function notifPreviewSummary(v: TimelineInput): { text: string; warns: string[] } {
  const show = (n: number | null) => (n != null && isFinite(n) ? n : '—');
  const sh = String(v.sendHour).padStart(2, '0');
  const send = `毎日 ${sh}:00 に送信`;
  const warns: string[] = [];
  if (!v.requireResponse) {
    return { text: `${show(v.recruitDays)}日前に告知 → 🎉 開催（${v.scheduleText}）／${send}`, warns };
  }
  const parts = [
    `${show(v.recruitDays)}日前に募集`,
    `${show(v.remindStartDays)}日前から毎日 未回答へ催促`,
    `${show(v.remindUndecidedDays)}日前に未定へ`,
  ];
  if (v.deadlineHours != null) parts.push(`開始${v.deadlineHours}時間前に締切`);
  parts.push(`🎉 開催（${v.scheduleText}）`);
  if (
    v.remindStartDays != null &&
    v.recruitDays != null &&
    isFinite(v.remindStartDays) &&
    isFinite(v.recruitDays) &&
    v.remindStartDays > v.recruitDays
  ) {
    warns.push('未回答リマインド開始が募集より前です（募集前に催促が飛びます）。');
  }
  if (
    v.remindUndecidedDays != null &&
    v.remindStartDays != null &&
    isFinite(v.remindUndecidedDays) &&
    isFinite(v.remindStartDays) &&
    v.remindUndecidedDays > v.remindStartDays
  ) {
    warns.push('未定リマインドが未回答リマインド開始より前です。');
  }
  if (v.deadlineHours != null && v.recruitDays != null && isFinite(v.recruitDays) && v.deadlineHours > v.recruitDays * 24) {
    warns.push('締切が募集より前になっています。');
  }
  return { text: parts.join(' → ') + `／${send}`, warns };
}
