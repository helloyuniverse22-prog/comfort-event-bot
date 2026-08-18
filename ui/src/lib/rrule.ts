// 繰り返しスケジュール（RRULE は隠して weekly/biweekly/monthly の3モードのみ UI に出す）。
// 旧 ui/index.html の同名関数群の純関数移植（DOM 非依存）。
export const WEEKDAYS: [string, string][] = [
  ['SU', '日'],
  ['MO', '月'],
  ['TU', '火'],
  ['WE', '水'],
  ['TH', '木'],
  ['FR', '金'],
  ['SA', '土'],
];
export const NTH: [string, string][] = [
  ['1', '第1'],
  ['2', '第2'],
  ['3', '第3'],
  ['4', '第4'],
  ['5', '第5'],
  ['-1', '最終'],
];
export const wdLabel = (c: string) => (WEEKDAYS.find((w) => w[0] === c) || ['', ''])[1];
export const nthLabel = (n: string | number) => (NTH.find((x) => x[0] === String(n)) || ['', ''])[1];

export type RepeatMode = 'weekly' | 'biweekly' | 'monthly';
export type MonthlyRule = { nth: string; byday: string };

export function buildRRule(mode: RepeatMode, byday: string, monthlyRules: MonthlyRule[]): string {
  if (mode === 'weekly') return `FREQ=WEEKLY;BYDAY=${byday}`;
  if (mode === 'biweekly') return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${byday}`;
  if (mode === 'monthly') {
    const rules = dedupeMonthlyRules(monthlyRules);
    return rules.length ? `FREQ=MONTHLY;BYDAY=${rules.map((r) => r.nth + r.byday).join(',')}` : '';
  }
  return '';
}

export function parseRRuleToBuilder(rrule?: string | null): {
  mode: RepeatMode;
  byday: string;
  rules: MonthlyRule[];
} {
  const out: { mode: RepeatMode; byday: string; rules: MonthlyRule[] } = { mode: 'weekly', byday: 'SA', rules: [] };
  if (!rrule) return out;
  const p = Object.fromEntries(
    rrule.split(';').map((x) => {
      const [k, v] = x.split('=');
      return [k.toUpperCase(), v];
    }),
  );
  const freq = (p.FREQ || '').toUpperCase();
  const byday = (p.BYDAY || '').toUpperCase();
  if (freq === 'MONTHLY') {
    out.mode = 'monthly';
    out.rules = byday
      .split(',')
      .map((tok) => {
        const m = tok.match(/^(-?\d+)([A-Z]{2})$/);
        return m ? { nth: m[1], byday: m[2] } : null;
      })
      .filter((x): x is MonthlyRule => !!x);
    if (out.rules.length) out.byday = out.rules[0].byday;
  } else if (freq === 'WEEKLY') {
    out.mode = p.INTERVAL === '2' ? 'biweekly' : 'weekly';
    out.byday = byday.replace(/^-?\d+/, '') || 'SA';
  }
  return out;
}

export function dedupeMonthlyRules(rules: MonthlyRule[]): MonthlyRule[] {
  const seen = new Set<string>();
  const out: MonthlyRule[] = [];
  for (const r of rules) {
    const k = r.nth + r.byday;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** 「毎月 第1・第3・第5 日曜日」/ 混在「毎月 第1日曜・第3火曜」 */
export function humanMonthly(rules: MonthlyRule[]): string {
  if (!rules.length) return '毎月（未設定）';
  const wds = new Set(rules.map((r) => r.byday));
  if (wds.size === 1) return `毎月 ${rules.map((r) => nthLabel(r.nth)).join('・')} ${wdLabel(rules[0].byday)}曜日`;
  return `毎月 ${rules.map((r) => nthLabel(r.nth) + wdLabel(r.byday) + '曜').join('・')}`;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** 隔週の起点候補: 指定曜日の直近の日付を count 個（今日以降） */
export function nextWeekdayDates(code: string, count: number): string[] {
  const idx = WEEKDAYS.findIndex((w) => w[0] === code);
  const out: string[] = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 90 && out.length < count; i++) {
    const t = new Date(base);
    t.setDate(base.getDate() + i);
    if (t.getDay() === idx) out.push(fmtDate(t));
  }
  return out;
}

/** 起点日('YYYY/MM/DD')の曜日が選択曜日コードと一致するか（不正な日付は false） */
export function anchorMatchesWeekday(anchor: string, code: string): boolean {
  const [y, m, d] = (anchor || '').split('/').map(Number);
  return !!y && !!m && !!d && new Date(y, m - 1, d).getDay() === WEEKDAYS.findIndex((w) => w[0] === code);
}

/**
 * 隔週の次回開催日: 起点日('YYYY/MM/DD')から14日刻みで today 以降の最初の日。
 * 起点が未来ならそのまま返す。不正な起点は null（呼び出し側でフォールバック）。
 * サーバ nextOccurrenceDates の anchor パリティと同等（日粒度・当日 start_time 境界は近似）。
 */
export function nextBiweeklyFromAnchor(anchor: string, today: Date = new Date()): string | null {
  const [y, m, d] = (anchor || '').split('/').map(Number);
  if (!y || !m || !d) return null;
  const t = new Date(y, m - 1, d);
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = base.getTime() - t.getTime();
  if (diff > 0) t.setDate(t.getDate() + Math.ceil(diff / (14 * 86_400_000)) * 14);
  return fmtDate(t);
}

function addMinsToTime(time: string, minutes: number): { time: string; nextDay: boolean } {
  const [h, m] = (time || '0:0').split(':').map(Number);
  const total = (h || 0) * 60 + (m || 0) + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return { time: `${hh}:${mm}`, nextDay: total >= 1440 || total < 0 };
}

/** 開始時刻＋開催時間(分) を From-To 文字列に（サーバ src/lib/date.ts formatTimeRange と同等） */
export function fmtTimeRange(start: string, dur?: number | null): string {
  if (!dur || dur <= 0) return `${start}〜`;
  const e = addMinsToTime(start, dur);
  return `${start}〜${e.nextDay ? '翌' : ''}${e.time}`;
}

/** 開催回の表示ラベル「YYYY/MM/DD (曜) HH:MM〜HH:MM」（サーバ formatOccurrenceLabel と同等） */
export function occurrenceLabel(dateStr: string, time?: string | null, dur?: number | null): string {
  const [y, m, d] = (dateStr || '').split('/').map(Number);
  const w = y && m && d ? '日月火水木金土'[new Date(y, m - 1, d).getDay()] : '';
  return `${dateStr}${w ? ` (${w})` : ''}${time ? ' ' + fmtTimeRange(time, dur) : ''}`;
}

/** スケジュール一覧向けの短い自然文（毎週/隔週/毎月＋時間帯）。recurring 専用（oneoff は呼び出し側で別処理）。 */
export function humanRRule(rrule: string | null | undefined, time: string | null | undefined, dur: number | null | undefined): string {
  const b = parseRRuleToBuilder(rrule);
  const wd = wdLabel(b.byday);
  const tr = fmtTimeRange(time || '', dur);
  if (b.mode === 'weekly') return `毎週 ${wd}曜日 ${tr}`;
  if (b.mode === 'biweekly') return `隔週 ${wd}曜日 ${tr}`;
  return `${humanMonthly(b.rules)} ${tr}`;
}

export function scheduleSummary(opts: {
  mode: RepeatMode;
  weekday: string;
  startTime: string;
  duration: number | null;
  monthlyRules: MonthlyRule[];
  biweeklyAnchor?: string;
}): string {
  const tr = fmtTimeRange(opts.startTime || '21:00', opts.duration);
  if (opts.mode === 'weekly') return `毎週 ${wdLabel(opts.weekday)}曜日 ${tr}`;
  if (opts.mode === 'biweekly') return `隔週 ${wdLabel(opts.weekday)}曜日 ${tr}（次回 ${opts.biweeklyAnchor || '—'}）`;
  return `${humanMonthly(dedupeMonthlyRules(opts.monthlyRules))} ${tr}`;
}
