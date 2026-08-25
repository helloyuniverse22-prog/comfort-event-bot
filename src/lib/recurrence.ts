/**
 * RRULE 評価ユーティリティ（タイムゾーン: Asia/Tokyo / JST）
 *
 * RRULE の評価ロジックをこの 1 ファイルに閉じ込める。消費側（cron / interactions / admin）は
 * nextOccurrenceDate(s) / occurrenceDatesBetween / anchorMatchesRule のみを使い、rrule パッケージへ
 * 直接依存しない。文法検証・正規化は src/lib/rruleGrammar.ts（rrule 非依存・UI と共有可）。
 * 設計: docs/dev/schedule-recurrence-redesign.md §5（2026-08-23）。
 *
 * JST 壁時計での評価について（重要）:
 *   Cloudflare Workers のランタイムは常に UTC で動作するため、getJSTNow() が返す Date の
 *   ローカルゲッター（getFullYear/getMonth/getDate/getHours/getDay）は JST のカレンダー値になる
 *   （src/lib/date.ts と同じ前提）。
 *   rrule は内部を常に UTC で評価する。そこで「JST 壁時計のカレンダー値」を UTC フィールドに
 *   載せた Date を渡し、結果も getUTC* で読む。これでランタイムの TZ（本番=UTC / ローカルテスト=
 *   ホストTZ）に依存せず、評価が JST 壁時計で閉じる。
 *
 * 位相（anchor_date = 「次回の開催日」）の扱い:
 *   - INTERVAL=1: 位相は無関係（BYxxx が明示されるため）。dtstart=境界日で走査ゼロ。anchor は無視。
 *   - INTERVAL>=2: anchor が境界以降（未来）ならそのまま dtstart ＝ 次回の開催日より前の回は生成しない。
 *     anchor が過去なら FREQ の周期単位（N 日 / 7N 日 / N か月 / N 年）で境界直前まで前進させる
 *     （月・年は月初・年初に正規化し、境界と同じ月・年の回を取りこぼさない）。
 *     anchor が無ければ固定エポック 2000/01/01 を同規則で整列（既存の隔週行の位相は従来と同一）。
 */

import { RRule, type Options, type Weekday } from 'rrule';
import type { Notification } from '../db/types';
import { getJSTNow } from './date';
import { parseRule, type Freq, type RuleModel, type WeekdayCode } from './rruleGrammar';

export type { WeekdayCode } from './rruleGrammar';

/** 評価に必要な列だけ（Notification 行そのものでも、プレビュー用の仮の値でもよい） */
export type RecurrenceSpec = Pick<Notification, 'rrule' | 'anchor_date' | 'start_time'>;

/**
 * 次の開催日を 'YYYY/MM/DD'（JST）で返す。該当なし（不定期＝rrule NULL・文法外）は null。
 * rrule を JST 基準で評価し、今日以降で最も近い開催日を返す。
 * 当日でも start_time 前なら当日、start_time 以降なら次の回（旧 getTargetDate の当日ロジックを踏襲）。
 */
export function nextOccurrenceDate(n: RecurrenceSpec, now: Date = getJSTNow()): string | null {
  const dates = nextOccurrenceDates(n, 1, now);
  return dates[0] ?? null;
}

/**
 * 未来の開催日を最大 count 件、'YYYY/MM/DD'（JST）昇順で返す。
 * 判定ロジックは nextOccurrenceDate と同一（当日ロジック・anchor 位相含む）。
 * 評価不能（不定期＝rrule 無し・文法外）は空配列。配信予定の仮想表示・プレビューに使う。
 */
export function nextOccurrenceDates(n: RecurrenceSpec, count: number, now: Date = getJSTNow()): string[] {
  const r = ruleFor(n, now);
  if (!r) return [];
  const out: string[] = [];
  // inc=true: 境界日（0:00）に一致する開催日も含める。2 件目以降は直前の結果から非包含で進める。
  let cursor: Date | null = r.rule.after(r.boundary, true);
  while (cursor && out.length < count) {
    out.push(formatUTCDate(cursor));
    cursor = r.rule.after(cursor, false);
  }
  return out;
}

/**
 * 境界日（当日ロジック適用後の「今日」）から windowDays 日後までのルール開催日を 'YYYY/MM/DD' 昇順で
 * 全件返す（両端含む・between() 1 回）。送信窓内の全ルール回を実体化するロールフォワード用。
 * 先頭は nextOccurrenceDate と一致する（窓内にあれば）。不定期（rrule 無し）・文法外は空配列。
 */
export function occurrenceDatesBetween(n: RecurrenceSpec, windowDays: number, now: Date = getJSTNow()): string[] {
  const r = ruleFor(n, now);
  if (!r) return [];
  const end = new Date(r.boundary);
  end.setUTCDate(end.getUTCDate() + windowDays);
  return r.rule.between(r.boundary, end, true).map(formatUTCDate);
}

/**
 * anchor('YYYY/MM/DD') がルールの開催日か（位相に関わらず「その日にルールが当たる」か）。
 * API の anchor_date 検証用。rrule が文法外・日付不正なら false。
 */
export function anchorMatchesRule(rrule: string, anchor: string): boolean {
  const model = parseRule(rrule);
  const a = parseAnchor(anchor);
  if (!model || !a) return false;
  const hit = new RRule({ ...toRRuleOptions(model), dtstart: a }).after(a, true);
  return !!hit && hit.getTime() === a.getTime();
}

/** 評価用 RRule（dtstart 整列済み）と境界日。rrule 無し・文法外は null。 */
function ruleFor(n: RecurrenceSpec, now: Date): { rule: RRule; boundary: Date } | null {
  if (!n.rrule) return null;
  const model = parseRule(n.rrule);
  if (!model) return null;

  const [sh, sm] = n.start_time.split(':').map(Number);
  const beforeStart = now.getHours() * 60 + now.getMinutes() < sh * 60 + sm;
  // 当日ロジック（旧 getTargetDate 踏襲）: start_time 前なら今日を含め、以降なら翌日へ＝次の回。
  // 境界の 0:00 は「UTC フィールド = JST のカレンダー日付」で構築する。
  const boundary = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  if (!beforeStart) boundary.setUTCDate(boundary.getUTCDate() + 1);

  const dtstart = alignDtstart(model.freq, model.interval, parseAnchor(n.anchor_date), boundary);
  return { rule: new RRule({ ...toRRuleOptions(model), dtstart }), boundary };
}

const DAY_MS = 86_400_000;

/**
 * 評価の起点 dtstart を決める（ファイル冒頭「位相の扱い」参照）。
 * 境界より未来の anchor はそのまま。過去の anchor（無ければエポック 2000/01/01）は周期の倍数で
 * 境界直前 (boundary - 周期, boundary] へ前進させ、rrule が dtstart から全履歴を列挙する CPU 負荷を避ける
 * （Workers Free の CPU 10ms 制限・2026-07-08）。
 */
export function alignDtstart(freq: Freq, interval: number, anchor: Date | null, boundary: Date): Date {
  if (interval === 1) return boundary;
  const a = anchor ?? new Date(Date.UTC(2000, 0, 1));
  if (a.getTime() >= boundary.getTime()) return a;
  switch (freq) {
    case 'DAILY':
    case 'WEEKLY': {
      const period = (freq === 'DAILY' ? 1 : 7) * interval;
      const days = Math.floor((boundary.getTime() - a.getTime()) / DAY_MS / period) * period;
      return new Date(a.getTime() + days * DAY_MS);
    }
    case 'MONTHLY': {
      const months =
        (boundary.getUTCFullYear() - a.getUTCFullYear()) * 12 + (boundary.getUTCMonth() - a.getUTCMonth());
      return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + Math.floor(months / interval) * interval, 1));
    }
    case 'YEARLY': {
      const years = boundary.getUTCFullYear() - a.getUTCFullYear();
      return new Date(Date.UTC(a.getUTCFullYear() + Math.floor(years / interval) * interval, 0, 1));
    }
  }
}

const FREQ_MAP: Record<Freq, number> = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
};

/** 文法モデル → rrule のオプション（dtstart を除く）。WKST は MO 固定。 */
function toRRuleOptions(m: RuleModel): Partial<Options> {
  return {
    freq: FREQ_MAP[m.freq],
    interval: m.interval,
    wkst: RRule.MO,
    byweekday: m.byday.length ? m.byday.map((d) => (d.nth ? WEEKDAY_MAP[d.day].nth(d.nth) : WEEKDAY_MAP[d.day])) : null,
    bymonthday: m.bymonthday.length ? m.bymonthday : null,
    bymonth: m.bymonth.length ? m.bymonth : null,
  };
}

/** 'YYYY/MM/DD' を UTC フィールドに JST 日付を載せた Date で返す。不正・未設定は null。 */
function parseAnchor(s: string | null | undefined): Date | null {
  const [y, m, d] = (s ?? '').split('/').map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null;
}

/** UTC フィールド（= JST 日付）を 'YYYY/MM/DD' に */
function formatUTCDate(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** buildRRule のオプション */
export type BuildRRuleOptions =
  | {
      /** 毎週: 指定曜日に毎週 */
      freq: 'weekly';
      /** 'SU'|'MO'|'TU'|'WE'|'TH'|'FR'|'SA' */
      byday: WeekdayCode;
    }
  | {
      /** 隔週: 指定曜日に 2 週おき（INTERVAL=2） */
      freq: 'biweekly';
      byday: WeekdayCode;
    }
  | {
      /** 毎月第 N 曜日（例 第2土曜 = nth:2, byday:'SA'） */
      freq: 'monthly-nth-weekday';
      /** 第 N（1〜5、-1 で最終週も可） */
      nth: number;
      byday: WeekdayCode;
    }
  | {
      /** 毎月の (第N, 曜日) 複数指定（例 第1・第3・第5 日曜 / 第1日曜＋第3火曜）。BYDAY をカンマ連結する。 */
      freq: 'monthly-nth-weekdays';
      rules: { nth: number; byday: WeekdayCode }[];
    };

/** 曜日コード → rrule の Weekday 定数 */
const WEEKDAY_MAP: Record<WeekdayCode, Weekday> = {
  SU: RRule.SU,
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
};

/**
 * UI / テスト用の RRULE 文字列ビルダ（任意）。
 * weekly(byday) / biweekly(interval=2) / monthly-nth-weekday を組み立てる。
 * 例: 毎週土曜=FREQ=WEEKLY;BYDAY=SA / 隔週土曜=FREQ=WEEKLY;INTERVAL=2;BYDAY=SA /
 *     毎月第2土曜=FREQ=MONTHLY;BYDAY=2SA
 */
export function buildRRule(opts: BuildRRuleOptions): string {
  let rule: RRule;
  switch (opts.freq) {
    case 'weekly':
      rule = new RRule({ freq: RRule.WEEKLY, byweekday: [WEEKDAY_MAP[opts.byday]] });
      break;
    case 'biweekly':
      rule = new RRule({
        freq: RRule.WEEKLY,
        interval: 2,
        byweekday: [WEEKDAY_MAP[opts.byday]],
      });
      break;
    case 'monthly-nth-weekday':
      // 第 N 曜日は Weekday.nth(N) で表現（例 RRule.SA.nth(2) → BYDAY=2SA）
      rule = new RRule({
        freq: RRule.MONTHLY,
        byweekday: [WEEKDAY_MAP[opts.byday].nth(opts.nth)],
      });
      break;
    case 'monthly-nth-weekdays':
      // 複数の (第N, 曜日) を BYDAY にカンマ連結（例 1SU,3SU,5SU / 1SU,3TU）
      rule = new RRule({
        freq: RRule.MONTHLY,
        byweekday: opts.rules.map((r) => WEEKDAY_MAP[r.byday].nth(r.nth)),
      });
      break;
  }
  // RRule.toString() は 'RRULE:' 接頭辞を含み、正の序数に '+'（例 BYDAY=+2SA）を付ける。
  // 本文だけ・'+' 無しの正規形（BYDAY=2SA）で返す。
  return rule.toString().replace(/^RRULE:/, '').replace(/\+(\d)/g, '$1');
}
