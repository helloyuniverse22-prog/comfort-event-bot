// スケジュールの新規作成・編集ページ（ウィザード型・ルート notifications/new・<uuid>/edit）。
// 設計: 左にステップレール、右に1ステップずつ表示。新規=基本情報から順に、編集=確認（サマリー）から各項目へジャンプ。
// 「開催日時」は 4 カード（毎日／毎週／毎月／毎年）＋間隔＋次回の開催日（間隔 ≥ 2）。
// 不定期（rrule NULL）はリリース保留のため入口を閉鎖中: カード非表示・既存行は編集不可の案内のみ（2026-08-24）。
// 保存形は RRULE サブセット文法（src/lib/rruleGrammar.ts・不定期は null）。開催日の列挙はサーバー
// POST /notifications/preview-plan（cron と同じ評価関数）。設計: docs/dev/schedule-recurrence-redesign.md §6。
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Pill, Select, Switch, TextField, Textarea } from '../../../design-system/src';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { FLOW_STEP_NAMES, buildRecruitPreviewParts, flowWarnings, notifPreviewSummary } from '../lib/notifPreview';
import {
  DEFAULT_RULE_FORM,
  INTERVAL_MAX,
  NTH,
  WEEKDAYS,
  WEEKDAYS_MON_FRI,
  daysFromToday,
  dedupeMonthlyRules,
  describeRule,
  formatRule,
  modelFromRuleForm,
  parseRule,
  ruleFormFromModel,
  shortDateWithWeekday,
  type Freq,
  type RuleForm,
  type WeekdayCode,
} from '../lib/rrule';
import type { ToastFn } from '../App';

type Channel = { id: string; name: string };
type Segment = { id: string; uuid: string; name: string; mention_role_id?: string | null };
type NotifDetail = {
  uuid: string;
  type: string;
  name: string;
  message_title: string;
  message_body: string | null;
  channel_id: string;
  segment_id: string;
  rrule: string | null;
  anchor_date: string | null;
  start_time: string | null;
  duration_minutes: number | null;
  recruit_days_before: number;
  remind_start_days: number;
  remind_undecided_days: number;
  /** 配信の流れの工程スイッチ（ADR 0026）。0=自動では行わない（日数は保持） */
  recruit_enabled?: 0 | 1 | boolean;
  remind_unanswered_enabled?: 0 | 1 | boolean;
  remind_undecided_enabled?: 0 | 1 | boolean;
  quota_enabled: 0 | 1 | boolean;
  quota_interval_days: number | null;
  mention_mode: 'role' | 'members' | 'none';
  requires_response: 0 | 1 | boolean | null;
  send_hour: number | null;
  response_deadline_hours: number | null;
  change_alert_channel_id: string | null;
  active: 0 | 1 | boolean;
};

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

type StepKey = 'basic' | 'when' | 'message' | 'flow' | 'confirm';
const STEPS: { key: StepKey; icon: string; label: string }[] = [
  { key: 'basic', icon: '📌', label: '基本情報' },
  { key: 'when', icon: '🗓️', label: '開催日時' },
  { key: 'message', icon: '📝', label: '投稿メッセージ' },
  { key: 'flow', icon: '📤', label: '配信設定' },
  { key: 'confirm', icon: '✅', label: '確認して保存' },
];
const ALL_STEPS = STEPS.map((s) => s.key);

/** 「開催日時」の繰り返しカード（不定期カードはリリース保留につき非表示・既存の不定期行は irregularRow で案内） */
const CARDS: { key: RuleForm['freq']; label: string; desc: string }[] = [
  { key: 'DAILY', label: '毎日', desc: 'N日おきも' },
  { key: 'WEEKLY', label: '毎週', desc: '隔週・平日・複数曜日' },
  { key: 'MONTHLY', label: '毎月', desc: '第N曜 または 日付' },
  { key: 'YEARLY', label: '毎年', desc: '月日を指定' },
];
/** 間隔セグメントの文言（毎／隔／N…）。隔が無い FREQ は N が 2 から */
const INTERVAL_LABELS: Record<Freq, { every: string; alt?: string; unit: string }> = {
  DAILY: { every: '毎日', unit: '日おき' },
  WEEKLY: { every: '毎週', alt: '隔週', unit: '週おき' },
  MONTHLY: { every: '毎月', alt: '隔月', unit: 'か月おき' },
  YEARLY: { every: '毎年', unit: '年おき' },
};
const customIntervalMin = (freq: Freq) => (INTERVAL_LABELS[freq].alt ? 3 : 2);

type PreviewPlan = { dates: string[]; anchor_candidates: string[]; error?: string };

export function NotificationFormV2({
  guild,
  nuuid,
  toast,
  onDirtyChange,
  onClose,
  onSaved,
}: {
  guild: Guild;
  nuuid?: string; // 未指定 = 新規
  toast: ToastFn;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [segs, setSegs] = useState<Segment[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // 不定期（rrule NULL・旧単発からの変換行）はリリース保留中: フォームは出さず案内だけ表示する
  const [irregularRow, setIrregularRow] = useState(false);

  // ---- フォーム状態（v1 と同一の既定値） ----
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [segmentUuid, setSegmentUuid] = useState('');
  const [channelId, setChannelId] = useState('');
  const [extraChannelOpt, setExtraChannelOpt] = useState<Channel | null>(null);
  const [rule, setRule] = useState<RuleForm>(DEFAULT_RULE_FORM);
  const [intervalCustom, setIntervalCustom] = useState(false); // 間隔セグメントが「N…」
  const [ruleUnreadable, setRuleUnreadable] = useState(false); // 既存の rrule が文法外（再選択するまで保存不可）
  const [anchorDate, setAnchorDate] = useState(''); // 次回の開催日（間隔 ≥ 2 のときだけ保存）
  const [plan, setPlan] = useState<PreviewPlan | null>(null); // サーバー preview-plan の結果
  const [startTime, setStartTime] = useState('21:00');
  const [duration, setDuration] = useState('');
  const [mention, setMention] = useState<'role' | 'members' | 'none'>('role');
  const [requireResponse, setRequireResponse] = useState(true);
  const [deadlineHours, setDeadlineHours] = useState('');
  const [recruitDays, setRecruitDays] = useState('7');
  const [remindStartDays, setRemindStartDays] = useState('3');
  const [remindUndecidedDays, setRemindUndecidedDays] = useState('1');
  // 配信の流れの工程スイッチ（案A・ADR 0026）。OFF でも日数の入力値は保持する（ON に戻すと復帰）。
  // 締切だけは response_deadline_hours の有無（NULL=締切なし）がそのままスイッチ。
  // 募集は定期では常時 ON（手動投稿は不定期専用・リリース保留中）のためスイッチを持たない。
  const [remindUnansweredOn, setRemindUnansweredOn] = useState(true);
  const [remindUndecidedOn, setRemindUndecidedOn] = useState(true);
  const [deadlineOn, setDeadlineOn] = useState(false);
  const [quotaEnabled, setQuotaEnabled] = useState(false);
  const [quotaInterval, setQuotaInterval] = useState('');
  const [sendHour, setSendHour] = useState('21');
  const [alertChannelId, setAlertChannelId] = useState('');
  const [extraAlertChannelOpt, setExtraAlertChannelOpt] = useState<Channel | null>(null);
  const [active, setActive] = useState(true);
  const [formErr, setFormErr] = useState('');
  const [dirty, setDirty] = useState(false);

  // ---- ウィザード状態 ----
  const [step, setStep] = useState<StepKey>(nuuid ? 'confirm' : 'basic');
  const [visited, setVisited] = useState<Set<StepKey>>(() => new Set(nuuid ? ALL_STEPS : ['basic']));
  const [attempted, setAttempted] = useState(false); // 保存を試みた後は未入力を強調表示

  const markDirty = () => {
    if (!dirty) {
      setDirty(true);
      onDirtyChange(true);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, c] = await Promise.all([
          api('/segments?guild_id=' + encodeURIComponent(guild.id)),
          api(`/guilds/${guild.id}/channels`).catch(() => []),
        ]);
        if (!alive) return;
        setSegs(s);
        setChannels(c);
        if (nuuid) {
          const n: NotifDetail = await api('/notifications/' + nuuid);
          if (!alive) return;
          fillForm(n, s, c);
        }
      } catch (e) {
        if (nuuid) {
          toast('スケジュールが見つかりません', true);
          setNotFound(true);
        } else {
          toast(e instanceof Error ? e.message : String(e), true);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nuuid, guild.id]);

  function fillForm(n: NotifDetail, s: Segment[], c: Channel[]) {
    setName(n.name || '');
    if (!n.rrule) {
      // 不定期は編集フォームを出さない（保留中）。開催回の運用（追加・📣投稿）は「📅 開催回」画面で生きている
      setIrregularRow(true);
      return;
    }
    setTitle(n.message_title || '');
    setBody(n.message_body || '');
    if (n.channel_id && !c.some((x) => x.id === n.channel_id)) setExtraChannelOpt({ id: n.channel_id, name: 'ID: ' + n.channel_id });
    setChannelId(n.channel_id || '');
    const seg = s.find((x) => x.id === n.segment_id);
    setSegmentUuid(seg ? seg.uuid : '');
    const model = parseRule(n.rrule);
    if (n.rrule && !model) {
      // 文法外（旧形式・未対応）。黙って既定値に丸めず、設定し直すまで保存できない（P5 対策）
      setRuleUnreadable(true);
      setRule({ ...DEFAULT_RULE_FORM });
    } else {
      const f = ruleFormFromModel(model);
      setRule(f);
      setIntervalCustom(f.freq !== 'IRREGULAR' && f.interval >= customIntervalMin(f.freq));
    }
    setAnchorDate(n.anchor_date || '');
    setStartTime(n.start_time || '21:00');
    setDuration(n.duration_minutes == null ? '' : String(n.duration_minutes));
    setRecruitDays(String(n.recruit_days_before));
    setRemindStartDays(String(n.remind_start_days));
    setRemindUndecidedDays(String(n.remind_undecided_days));
    setRemindUnansweredOn(n.remind_unanswered_enabled == null ? true : !!n.remind_unanswered_enabled);
    setRemindUndecidedOn(n.remind_undecided_enabled == null ? true : !!n.remind_undecided_enabled);
    setDeadlineOn(n.response_deadline_hours != null);
    setQuotaInterval(n.quota_interval_days == null ? '' : String(n.quota_interval_days));
    setQuotaEnabled(!!n.quota_enabled);
    setMention((n.mention_mode as any) || 'role');
    setRequireResponse(n.requires_response == null ? true : !!n.requires_response);
    setActive(!!n.active);
    setSendHour(String(n.send_hour == null ? 21 : n.send_hour));
    setDeadlineHours(n.response_deadline_hours == null ? '' : String(n.response_deadline_hours));
    if (n.change_alert_channel_id && !c.some((x) => x.id === n.change_alert_channel_id)) {
      setExtraAlertChannelOpt({ id: n.change_alert_channel_id, name: 'ID: ' + n.change_alert_channel_id });
    }
    setAlertChannelId(n.change_alert_channel_id || '');
  }

  const patchRule = (patch: Partial<RuleForm>) => {
    setRule((r) => ({ ...r, ...patch }));
    markDirty();
  };
  const model = ruleUnreadable ? null : modelFromRuleForm(rule);
  const rrule = model ? formatRule(model) : null;
  const needsAnchor = !!model && model.interval >= 2;
  const intervalBad = !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > INTERVAL_MAX[rule.freq as Freq];

  // サーバープレビュー（cron と同じ評価）: 次の開催日・次回の開催日の候補・anchor の整合。入力が落ち着いてから取得。
  // 間隔 ≥ 2 で次回の開催日が未選択／ルールと不一致なら、候補の先頭に取り直す（曜日変更で旧起点が残らないように）。
  useEffect(() => {
    if (!rrule) {
      setPlan(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const r: PreviewPlan = await api('/notifications/preview-plan', {
          method: 'POST',
          body: JSON.stringify({ rrule, anchor_date: needsAnchor ? anchorDate || null : null, start_time: startTime || '21:00', count: 10 }),
        });
        if (!alive) return;
        setPlan(r);
        if (needsAnchor && r.anchor_candidates?.length && (!anchorDate || r.error)) setAnchorDate(r.anchor_candidates[0]);
      } catch {
        if (alive) setPlan(null);
      }
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rrule, anchorDate, startTime, needsAnchor]);
  const nextDate = plan?.dates[0] ?? null;
  const anchorCandidates = plan?.anchor_candidates ?? [];
  const anchorOptions = anchorDate && !anchorCandidates.includes(anchorDate) ? [anchorDate, ...anchorCandidates] : anchorCandidates;

  const durationNum = duration.trim() === '' ? null : Number(duration);
  const deadlineNum = deadlineOn && deadlineHours.trim() !== '' ? Number(deadlineHours) : null;
  const announceOnly = !requireResponse;
  // 間隔 ≥ 2 の「次回」はサーバー計算の先頭日（anchor が過去でも実際の次回を出す）。未取得の間は anchor
  const scheduleText = ruleUnreadable
    ? '⚠️ 繰り返し設定を読み取れません（設定し直してください）'
    : describeRule(model, startTime, durationNum, needsAnchor ? nextDate ?? (anchorDate || null) : null);
  // 工程オフは null（文から省く／判定から外す）・未入力は NaN（「—」・判定しない）
  const flowInput = {
    requireResponse,
    recruitDays: numOrNull(recruitDays) ?? NaN,
    remindStartDays: remindUnansweredOn ? (numOrNull(remindStartDays) ?? NaN) : null,
    remindUndecidedDays: remindUndecidedOn ? (numOrNull(remindUndecidedDays) ?? NaN) : null,
    deadlineHours: deadlineNum,
    sendHour: Number(sendHour),
  };
  const timelineText = notifPreviewSummary({ ...flowInput, scheduleText });
  // 順序ルール E1〜E6（判定は src/lib/flowRules に一本化）。違反は保存不可（flow-settings-spec §4）
  const flowIssues = flowWarnings({ ...flowInput, startTime: startTime || '21:00' });
  const warnOf = (step: 'recruit' | 'remind' | 'undecided' | 'deadline') => flowIssues.find((w) => w.step === step) ?? null;
  const previewParts = buildRecruitPreviewParts({
    title,
    body,
    nextDate,
    startTime,
    duration: durationNum,
    deadlineHours: deadlineNum,
    mention,
    requireResponse,
  });
  const mentionSeg = segs.find((s) => s.uuid === segmentUuid);
  const mentionWarn = mention === 'members' && !!mentionSeg && mentionSeg.mention_role_id === '@everyone';
  const chLabel = (id: string) => {
    const all = extraChannelOpt ? [extraChannelOpt, ...channels] : channels;
    const c = all.find((x) => x.id === id);
    return c ? '#' + c.name : id;
  };

  // ---- ④配信設定: 実時系列タイムライン ----
  // 入力値から各送信の「開催何分前か」を出し、実際に送られる順に並べる。
  // 次回開催日（サーバー preview-plan の先頭）があれば具体日を例示（未計算の間は相対表示）。
  const WD_JP = ['日', '月', '火', '水', '木', '金', '土'];
  const shNum = Number(sendHour);
  const [evH, evM] = (startTime || '21:00').split(':').map((x) => Number(x) || 0);
  const exampleEventDate = nextDate;
  // 密度警告（Q9）: 募集窓（今日〜募集 N 日前・両端含む）に入るルール回が 3 件以上なら常に複数回が並行する
  const rDaysForDense = numOrNull(recruitDays);
  const denseCount =
    plan && rDaysForDense != null && isFinite(rDaysForDense)
      ? plan.dates.filter((d) => {
          const k = daysFromToday(d);
          return k >= 0 && k <= rDaysForDense;
        }).length
      : 0;
  const denseWarn =
    denseCount >= 3
      ? `この設定では常に約 ${denseCount} 回分の募集／リマインドが並行します。募集日数を短く（例: 1 日前）すると 1 回ずつになります。`
      : null;
  const fmtDt = (d: Date) =>
    `${d.getMonth() + 1}/${d.getDate()}(${WD_JP[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const whenDay = (days: number | null): string => {
    if (days == null || !isFinite(days)) return '—';
    if (exampleEventDate) {
      const [y, mo, dd] = exampleEventDate.split('/').map(Number);
      return fmtDt(new Date(y, mo - 1, dd - days, shNum, 0));
    }
    return `${days}日前 ${String(shNum).padStart(2, '0')}:00`;
  };
  const whenDeadline = (hours: number | null): string => {
    if (hours == null || !isFinite(hours)) return '—';
    if (exampleEventDate) {
      const [y, mo, dd] = exampleEventDate.split('/').map(Number);
      const d = new Date(y, mo - 1, dd, evH, evM);
      d.setMinutes(d.getMinutes() - hours * 60);
      return fmtDt(d);
    }
    return `開始${hours}時間前`;
  };
  // ソートキー = 開催開始からさかのぼった分数（日単位送信は送信時刻を加味）。未入力は既定値の位置に置く
  const minBeforeDay = (days: number | null, fallbackDays: number) =>
    (days != null && isFinite(days) ? days : fallbackDays) * 1440 + (evH * 60 + evM) - shNum * 60;
  const rDaysN = numOrNull(recruitDays);
  const rsDaysN = numOrNull(remindStartDays);
  const ruDaysN = numOrNull(remindUndecidedDays);
  const eventWhen = exampleEventDate
    ? (() => {
        const [y, mo, dd] = exampleEventDate.split('/').map(Number);
        return fmtDt(new Date(y, mo - 1, dd, evH, evM));
      })()
    : null;
  const flowTimeline = (() => {
    const num = (v: string, set: (s: string) => void, placeholder?: string) => (
      <TextField type="number" min={0} placeholder={placeholder} value={v} onChange={(e) => set(e.target.value)} />
    );
    type FlowNode = {
      key: string;
      sort: number;
      when: string;
      icon: string;
      title: string;
      chip: 'ch' | 'dm' | null;
      /** 整合性警告（flowWarnings・見出し＋詳細）。オフの工程には出ない */
      warn: { head: string; detail: string } | null;
      body: React.ReactNode;
      /** 工程スイッチ（案A・ADR 0026）。on=false なら body の代わりに offText を出し、点を白抜きにする。開催ノードは無し */
      on: boolean;
      offText?: string;
      onToggle?: (on: boolean) => void;
    };
    // 「やる／やらない」はスイッチ、「いつ」は数字。OFF の工程は位置（並び）は数字のまま・薄く残す（行が飛び回らない）
    const recruitWord = announceOnly ? '告知' : '募集';
    const nodes: FlowNode[] = [
      {
        key: 'recruit',
        sort: minBeforeDay(rDaysN, 7),
        when: whenDay(rDaysN),
        icon: '📣',
        title: `${recruitWord}を投稿`,
        chip: 'ch' as const,
        warn: warnOf('recruit'),
        on: true,
        body: (
          <div className="nf2-tl-inline">
            <span>開催の</span>
            {num(recruitDays, setRecruitDays)}
            <span>日前に投稿</span>
            {rDaysN === 0 && <span className="muted">＝ 当日の {String(shNum).padStart(2, '0')}:00 に投稿</span>}
          </div>
        ),
      },
      // 告知（回答不要）は②③④を持たない
      ...(announceOnly
        ? []
        : ([
            {
              key: 'remind',
              sort: minBeforeDay(rsDaysN, 3),
              when: remindUnansweredOn ? whenDay(rsDaysN) : '送らない',
              icon: '✉️',
              title: '未回答者へリマインド',
              chip: 'dm',
              warn: warnOf('remind'),
              on: remindUnansweredOn,
              onToggle: setRemindUnansweredOn,
              offText: '送りません。',
              body: (
                <div className="nf2-tl-inline">
                  <span>開催の</span>
                  {num(remindStartDays, setRemindStartDays)}
                  <span>日前から{deadlineOn ? '締切まで' : ''}毎日、未回答のメンバーへ</span>
                  {rsDaysN === 0 && <span className="muted">＝ 当日のみ</span>}
                </div>
              ),
            },
            {
              key: 'undecided',
              sort: minBeforeDay(ruDaysN, 1),
              when: remindUndecidedOn ? whenDay(ruDaysN) : '送らない',
              icon: '✉️',
              title: '未定者へリマインド',
              chip: 'dm',
              warn: warnOf('undecided'),
              on: remindUndecidedOn,
              onToggle: setRemindUndecidedOn,
              offText: '送りません。',
              body: (
                <div className="nf2-tl-inline">
                  <span>開催の</span>
                  {num(remindUndecidedDays, setRemindUndecidedDays)}
                  <span>日前に1回、「未定」回答のメンバーへ</span>
                  {ruDaysN === 0 && <span className="muted">＝ 当日</span>}
                </div>
              ),
            },
            {
              key: 'deadline',
              sort: deadlineNum != null && isFinite(deadlineNum) ? deadlineNum * 60 : 0,
              when: deadlineOn ? whenDeadline(deadlineNum) : '締切なし',
              icon: '⏰',
              title: '回答締切',
              chip: 'ch',
              warn: warnOf('deadline'),
              on: deadlineOn,
              onToggle: setDeadlineOn,
              offText: '締め切りません（開催までいつでも回答できます）。',
              body: (
                <div className="nf2-tl-inline">
                  <span>開始の</span>
                  {num(deadlineHours, setDeadlineHours)}
                  <span>時間前</span>
                  <span className="muted">（締切時に告知をチャンネルへ投稿）</span>
                </div>
              ),
            },
          ] as FlowNode[])),
    ].sort((a, b) => b.sort - a.sort);
    nodes.push({
      key: 'event',
      sort: -1,
      when: eventWhen ?? `開催日 ${startTime}`,
      icon: '🎉',
      title: '開催',
      chip: null,
      warn: null,
      on: true,
      body: <div className="nf2-tl-eventdesc">{scheduleText}</div>,
    });
    return nodes;
  })();

  // ---- ステップごとの必須未入力（レール表示・保存前チェックで共用） ----
  const missing: Record<StepKey, string[]> = {
    basic: [!name.trim() && 'スケジュール名', !segmentUuid && '対象区分', !channelId && '投稿チャンネル'].filter(
      (x): x is string => !!x,
    ),
    when: ruleUnreadable
      ? ['繰り返し（設定し直してください）']
      : [
          rule.freq === 'WEEKLY' && !rule.weekdays.length && '曜日',
          rule.freq === 'MONTHLY' && rule.monthlyMode === 'byday' && !dedupeMonthlyRules(rule.monthlyRules).length && '第N曜',
          rule.freq === 'MONTHLY' && rule.monthlyMode === 'bymonthday' && !rule.monthDays.length && '日付',
          intervalBad && '間隔',
          needsAnchor && !anchorDate && '次回の開催日',
        ].filter((x): x is string => !!x),
    message: !title.trim() ? ['見出し'] : [],
    flow: [
      ...(deadlineOn && deadlineNum == null ? ['回答締切の時間'] : []),
      ...flowIssues.map((w) => w.head),
    ],
    confirm: [],
  };

  // 未入力エラーは解消され次第フッターから消す（API エラーは保持）
  const allOk = ALL_STEPS.every((k) => missing[k].length === 0);
  useEffect(() => {
    if (allOk && formErr.startsWith('保存できません')) setFormErr('');
  }, [allOk, formErr]);

  const goto = (next: StepKey) => {
    setVisited((v) => new Set(v).add(step).add(next));
    setStep(next);
  };
  const stepIdx = ALL_STEPS.indexOf(step);

  const attemptClose = async () => {
    if (dirty) {
      const ok = await confirmDialog('未保存の変更があります。破棄して閉じますか？', { okLabel: '破棄する', danger: true });
      if (!ok) return;
    }
    onDirtyChange(false);
    onClose();
  };

  const save = async (btn: HTMLElement | null) => {
    const firstBad = ALL_STEPS.find((k) => missing[k].length > 0);
    if (firstBad) {
      setAttempted(true);
      setFormErr(`保存できません: ${missing[firstBad].join('・')}`);
      goto(firstBad);
      return;
    }
    setFormErr('');
    const payload = {
      guild_id: guild.id,
      name: name.trim(),
      channel_id: channelId.trim(),
      segment_uuid: segmentUuid,
      type: 'recurring',
      rrule, // 正規形の RRULE
      anchor_date: needsAnchor ? anchorDate || null : null,
      start_time: startTime.trim() || '21:00',
      duration_minutes: durationNum,
      message_title: title.trim(),
      message_body: body.trim() || null,
      recruit_days_before: numOrNull(recruitDays) ?? 7,
      remind_start_days: numOrNull(remindStartDays) ?? 3,
      remind_undecided_days: numOrNull(remindUndecidedDays) ?? 1,
      recruit_enabled: 1,
      remind_unanswered_enabled: remindUnansweredOn ? 1 : 0,
      remind_undecided_enabled: remindUndecidedOn ? 1 : 0,
      quota_enabled: quotaEnabled ? 1 : 0,
      quota_interval_days: numOrNull(quotaInterval),
      assignment_enabled: 1,
      grouping_enabled: 1,
      mention_mode: mention,
      requires_response: requireResponse ? 1 : 0,
      send_hour: Number(sendHour),
      response_deadline_hours: deadlineNum,
      change_alert_channel_id: alertChannelId.trim() || null,
      active: active ? 1 : 0,
    };
    await withBusy(btn, async () => {
      try {
        let msg = '作成しました';
        if (nuuid) {
          // ルール変更時はサーバーが未投稿のルール回を掃除して作り直す（投稿済みは残す）。件数を案内する
          const r = (await api('/notifications/' + nuuid, { method: 'PUT', body: JSON.stringify(payload) })) as {
            pruned?: number;
            kept_posted?: number;
          } | null;
          const kept = r?.kept_posted ?? 0;
          const pruned = r?.pruned ?? 0;
          msg =
            kept > 0
              ? `更新しました。投稿済みの ${kept} 件はそのまま残しています（不要なら「開催回」タブで中止）`
              : pruned > 0
                ? `更新しました（未投稿の予定 ${pruned} 件を新しいルールで作り直します）`
                : '更新しました';
        } else {
          await api('/notifications', { method: 'POST', body: JSON.stringify(payload) });
        }
        onDirtyChange(false);
        setDirty(false);
        onSaved();
        toast(msg);
      } catch (e) {
        setFormErr(e instanceof Error ? e.message : String(e));
      }
    });
  };

  if (notFound) return null;
  if (loading) return <p className="muted">読み込み中…</p>;
  if (irregularRow) {
    return (
      <dialog className="modal-lg as-page" open aria-labelledby="nFormTitle">
        <div className="modal-head">
          <div>
            <div className="page-crumb">
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                }}
              >
                スケジュール設定
              </a>{' '}
              <span>›</span> <span>編集</span>
            </div>
            <h3 id="nFormTitle">{name || 'スケジュールを編集'}</h3>
          </div>
          <button type="button" className="page-back" aria-label="戻る" onClick={onClose}>
            ← 戻る
          </button>
        </div>
        <div className="modal-body">
          <p>このスケジュールは不定期（開催回を都度追加するタイプ）です。不定期の設定編集は準備中のため、この画面では変更できません。</p>
          <p className="muted">開催回の追加や募集・告知の投稿は、メニューの「📅 開催回」から行えます。</p>
        </div>
      </dialog>
    );
  }

  const segOptions = segs.map((s) => (
    <option key={s.uuid} value={s.uuid}>
      {s.name}
    </option>
  ));
  const channelOptions = (extraChannelOpt ? [extraChannelOpt, ...channels] : channels).map((c) => (
    <option key={c.id} value={c.id}>
      #{c.name}
    </option>
  ));
  const alertChannelOptions = (extraAlertChannelOpt ? [extraAlertChannelOpt, ...channels] : channels).map((c) => (
    <option key={c.id} value={c.id}>
      #{c.name}
    </option>
  ));

  // 保存試行後 or 訪問済みステップにのみ「未入力」を出す（初見のステップを赤くしない）
  const showBad = (k: StepKey) => missing[k].length > 0 && (attempted || (visited.has(k) && k !== step));

  const fieldErr = (cond: boolean, msg: string) =>
    cond && attempted ? (
      <p className="nf2-field-err" role="alert">
        {msg}
      </p>
    ) : null;

  // 保存は確認ステップの 1 か所だけ（モーダル殻のフッター「キャンセル／保存」は 2026-08-23 に撤去。閉じるはヘッダーの「← 戻る」）。
  // 新規: 前へ／次へ で直線に進み、最後に「この内容で作成する」。
  // 編集: 確認がハブ（開くと確認から始まる）。各ステップからは「← 確認に戻る」で戻って「保存する」。
  // 未入力／API エラーはナビ直下に出す（未入力時は該当ステップへ飛ぶので、どのステップでも同じ位置に見える）。
  // 先頭ステップでは前が無い（STEPS[-1]）ので評価しない
  const prevStep = STEPS[stepIdx - 1];
  const prevBtn = prevStep ? (
    <button type="button" className="btn ghost" onClick={() => goto(prevStep.key)}>
      ← {prevStep.label}
    </button>
  ) : (
    <span />
  );
  const stepNav = (
    <>
      <div className="nf2-nav">
        {step === 'confirm' ? (
          <>
            {nuuid ? <span /> : prevBtn}
            <button type="button" className="btn" onClick={(e) => save(e.currentTarget)}>
              {nuuid ? '保存する' : 'この内容で作成する'}
            </button>
          </>
        ) : nuuid ? (
          <>
            <span />
            <button type="button" className="btn" onClick={() => goto('confirm')}>
              ← 確認に戻る
            </button>
          </>
        ) : (
          <>
            {prevBtn}
            <button type="button" className="btn" onClick={() => goto(ALL_STEPS[stepIdx + 1])}>
              次へ: {STEPS[stepIdx + 1].label} →
            </button>
          </>
        )}
      </div>
      {formErr && (
        <p className="nf2-field-err" role="alert" style={{ marginTop: 10 }}>
          {formErr}
        </p>
      )}
    </>
  );

  const discordPreview = (
    <div className="nf2-discord" aria-label={announceOnly ? '告知メッセージのプレビュー' : '募集メッセージのプレビュー'}>
      <div className="nf2-dc-msg">
        <div className="nf2-dc-ava">🤖</div>
        <div className="nf2-dc-main">
          <div className="nf2-dc-head">
            <b>EventBot</b>
            <span className="nf2-dc-app">APP</span>
            <span className="nf2-dc-time">送信日 {String(Number(sendHour)).padStart(2, '0')}:00</span>
          </div>
          {mention !== 'none' && (
            <div className="nf2-dc-mentions">
              {mention === 'members' ? (
                <>
                  {/* バイネーム＝対象メンバー1人ずつの個別メンション。サンプル名で雰囲気を再現 */}
                  {['田中太郎', '鈴木花子', '佐藤次郎'].map((n) => (
                    <span key={n} className="nf2-dc-mention">@{n}</span>
                  ))}
                  <span className="nf2-dc-mention-note">…対象メンバー全員（名前はサンプル）</span>
                </>
              ) : (
                <span className="nf2-dc-mention">
                  {mentionSeg ? (mentionSeg.mention_role_id === '@everyone' ? '@everyone' : '@' + mentionSeg.name) : '@ロール'}
                </span>
              )}
            </div>
          )}
          <div className="nf2-dc-title">{title || '（見出しを入力）'}</div>
          {body && <div className="nf2-dc-body">{body}</div>}
          <div className="nf2-dc-line">
            日時: <b>{previewParts.dateText}</b>
          </div>
          {previewParts.deadline && (
            <div className="nf2-dc-line">
              回答締切: <b>{previewParts.deadline}</b>
            </div>
          )}
          {requireResponse && (
            <div className="nf2-dc-btns">
              <span className="ok">参加</span>
              <span className="no">不参加</span>
              <span>未定</span>
              <span>状況確認</span>
            </div>
          )}
        </div>
      </div>
      <p className="preview-note">※ @メンションは投稿時に展開されます。日付は次回の開催日（サーバー計算）の例です。</p>
    </div>
  );

  const summaryRow = (label: string, value: React.ReactNode) => (
    <div className="nf2-sum-row">
      <span className="nf2-sum-label">{label}</span>
      <span className="nf2-sum-value">{value}</span>
    </div>
  );

  const summaryCard = (key: StepKey, children: React.ReactNode) => {
    const meta = STEPS.find((s) => s.key === key)!;
    return (
      <section className={'nf2-sum-card' + (missing[key].length ? ' bad' : '')}>
        <header>
          <span>
            {meta.icon} {meta.label}
          </span>
          <button type="button" className="btn xs ghost" onClick={() => goto(key)}>
            編集
          </button>
        </header>
        {children}
      </section>
    );
  };

  return (
    <dialog className="modal-lg as-page" open aria-labelledby="nFormTitle">
      <div className="modal-head">
        <div>
          <div className="page-crumb">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                attemptClose();
              }}
            >
              スケジュール設定
            </a>{' '}
            <span>›</span> <span>{nuuid ? '編集' : '新規'}</span>
          </div>
          <h3 id="nFormTitle">{nuuid ? 'スケジュールを編集' : '新規スケジュール'}</h3>
        </div>
        <button type="button" className="page-back" aria-label="戻る" onClick={attemptClose}>
          ← 戻る
        </button>
      </div>

      <div className="modal-body" onInput={markDirty} onChange={markDirty}>
        <div className="nf2-layout">
          <nav className="nf2-steps" aria-label="入力ステップ">
            {STEPS.map((s, i) => {
              const done = visited.has(s.key) && missing[s.key].length === 0 && s.key !== 'confirm';
              return (
                <button
                  type="button"
                  key={s.key}
                  className={'nf2-step-item' + (step === s.key ? ' active' : '') + (showBad(s.key) ? ' bad' : '')}
                  aria-current={step === s.key ? 'step' : undefined}
                  onClick={() => goto(s.key)}
                >
                  <span className={'nf2-step-no' + (done ? ' done' : '')}>{done ? '✓' : i + 1}</span>
                  <span className="nf2-step-label">
                    {s.icon} {s.label}
                  </span>
                  {showBad(s.key) && <span className="nf2-step-alert">要修正</span>}
                </button>
              );
            })}
          </nav>

          <div className="nf2-main">
            {step === 'basic' && (
              <>
                <p className="nf2-lead">このスケジュールの名前と、誰に・どこに投稿するかを決めます。</p>
                <label>
                  スケジュール名 <span className="req">✱</span> <span className="muted">（管理用の名前・投稿には表示されません）</span>
                </label>
                <TextField placeholder="例: 土曜定例・キャスト出欠" value={name} onChange={(e) => setName(e.target.value)} />
                {fieldErr(!name.trim(), 'スケジュール名を入力してください')}
                <label>
                  対象区分 <span className="req">✱</span> <span className="muted">（出欠を聞くメンバーのグループ）</span>
                </label>
                <Select value={segmentUuid} onChange={(e) => setSegmentUuid(e.target.value)}>
                  <option value="" />
                  {segOptions}
                </Select>
                {fieldErr(!segmentUuid, '対象区分を選択してください')}
                <label>
                  投稿チャンネル <span className="req">✱</span> <span className="muted">（募集・告知を投稿する場所）</span>
                </label>
                <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  <option value="" />
                  {channelOptions}
                </Select>
                {fieldErr(!channelId, '投稿チャンネルを選択してください')}
                {stepNav}
              </>
            )}

            {step === 'when' && (
              <>
                <p className="nf2-lead">いつ開催するかを決めます。開催日はここから自動で計算され、募集やリマインドの日程の基準になります。</p>
                {ruleUnreadable && (
                  <p className="nf2-field-err" role="alert">
                    この繰り返し設定は読み取れません（旧形式または未対応の形式）。下から設定し直してください。
                  </p>
                )}
                <label>繰り返し</label>
                <div className="nf2-modes nf2-modes-5" role="radiogroup" aria-label="繰り返し">
                  {CARDS.map((c) => (
                    <button
                      type="button"
                      key={c.key}
                      role="radio"
                      aria-checked={!ruleUnreadable && rule.freq === c.key}
                      className={'nf2-mode' + (!ruleUnreadable && rule.freq === c.key ? ' on' : '')}
                      onClick={() => {
                        setRuleUnreadable(false);
                        setIntervalCustom(false);
                        patchRule({ freq: c.key, interval: 1 });
                      }}
                    >
                      <span className="nf2-mode-title">{c.label}</span>
                      <span className="nf2-mode-desc">{c.desc}</span>
                    </button>
                  ))}
                </div>

                {rule.freq === 'WEEKLY' && (
                  <>
                    <label>
                      曜日 <span className="muted">（複数選択可）</span>
                    </label>
                    <div className="nf2-chips" role="group" aria-label="曜日">
                      {WEEKDAYS.map(([v, l]) => {
                        const on = rule.weekdays.includes(v);
                        return (
                          <button
                            type="button"
                            key={v}
                            role="checkbox"
                            aria-checked={on}
                            className={'nf2-chip' + (on ? ' on' : '')}
                            onClick={() => patchRule({ weekdays: on ? rule.weekdays.filter((x) => x !== v) : [...rule.weekdays, v] })}
                          >
                            {l}
                          </button>
                        );
                      })}
                      <button type="button" className="btn xs ghost" onClick={() => patchRule({ weekdays: [...WEEKDAYS_MON_FRI] })}>
                        平日
                      </button>
                      <button type="button" className="btn xs ghost" onClick={() => patchRule({ weekdays: ['SA', 'SU'] })}>
                        週末
                      </button>
                    </div>
                    {fieldErr(!rule.weekdays.length, '曜日を 1 つ以上選んでください')}
                  </>
                )}

                {rule.freq === 'MONTHLY' && (
                  <>
                    <label>指定方法</label>
                    <div className="nf2-seg" role="radiogroup" aria-label="毎月の指定方法">
                      {(
                        [
                          ['byday', '第N曜'],
                          ['bymonthday', '日付'],
                        ] as const
                      ).map(([k, l]) => (
                        <button
                          type="button"
                          key={k}
                          role="radio"
                          aria-checked={rule.monthlyMode === k}
                          className={'nf2-seg-btn' + (rule.monthlyMode === k ? ' on' : '')}
                          onClick={() => patchRule({ monthlyMode: k })}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                    {rule.monthlyMode === 'byday' ? (
                      <div>
                        <label>開催日（第N × 曜日・複数可）</label>
                        <div className="timechips">
                          {rule.monthlyRules.map((r, i) => (
                            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <Select
                                style={{ width: 'auto' }}
                                aria-label="第N"
                                value={r.nth}
                                onChange={(e) =>
                                  patchRule({ monthlyRules: rule.monthlyRules.map((x, xi) => (xi === i ? { ...x, nth: e.target.value } : x)) })
                                }
                              >
                                {NTH.map(([v, l]) => (
                                  <option key={v} value={v}>
                                    {l}
                                  </option>
                                ))}
                              </Select>
                              <Select
                                style={{ width: 'auto' }}
                                aria-label="曜日"
                                value={r.byday}
                                onChange={(e) =>
                                  patchRule({ monthlyRules: rule.monthlyRules.map((x, xi) => (xi === i ? { ...x, byday: e.target.value } : x)) })
                                }
                              >
                                {WEEKDAYS.map(([v, l]) => (
                                  <option key={v} value={v}>
                                    {l}曜
                                  </option>
                                ))}
                              </Select>
                              <button
                                type="button"
                                className="btn xs ghost"
                                aria-label="このルールを削除"
                                onClick={() => {
                                  if (rule.monthlyRules.length > 1) patchRule({ monthlyRules: rule.monthlyRules.filter((_, xi) => xi !== i) });
                                  else toast('ルールは最低1つ必要です', true);
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="btn sm secondary"
                          style={{ marginTop: 4 }}
                          onClick={() => patchRule({ monthlyRules: [...rule.monthlyRules, { nth: '1', byday: 'SU' }] })}
                        >
                          ＋ ルールを追加
                        </button>
                        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                          例: 第1・第3・第5 日曜／第1日曜＋第3火曜。「第5」は5週ある月のみ・「最終」は常に最後の週。
                        </p>
                      </div>
                    ) : (
                      <div>
                        <label>
                          日付 <span className="muted">（複数選択可）</span>
                        </label>
                        <div className="nf2-chips" role="group" aria-label="日付">
                          {[...Array.from({ length: 31 }, (_, i) => i + 1), -1].map((d) => {
                            const on = rule.monthDays.includes(d);
                            return (
                              <button
                                type="button"
                                key={d}
                                role="checkbox"
                                aria-checked={on}
                                className={'nf2-chip' + (d === -1 ? ' wide' : '') + (on ? ' on' : '')}
                                onClick={() => patchRule({ monthDays: on ? rule.monthDays.filter((x) => x !== d) : [...rule.monthDays, d] })}
                              >
                                {d === -1 ? '月末' : d}
                              </button>
                            );
                          })}
                        </div>
                        {rule.monthDays.some((d) => d >= 29) && (
                          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                            29〜31日は、その日が無い月はスキップされます。毎月末に開催するなら「月末」を選んでください。
                          </p>
                        )}
                        {fieldErr(!rule.monthDays.length, '日付を 1 つ以上選んでください')}
                      </div>
                    )}
                  </>
                )}

                {rule.freq === 'YEARLY' && (
                  <>
                    <label>月日</label>
                    <div className="nf2-inline">
                      <Select style={{ width: 'auto' }} aria-label="月" value={rule.yearMonth} onChange={(e) => patchRule({ yearMonth: Number(e.target.value) })}>
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                          <option key={m} value={m}>
                            {m}月
                          </option>
                        ))}
                      </Select>
                      <Select style={{ width: 'auto' }} aria-label="日" value={rule.yearDay} onChange={(e) => patchRule({ yearDay: Number(e.target.value) })}>
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                          <option key={d} value={d}>
                            {d}日
                          </option>
                        ))}
                      </Select>
                    </div>
                    {rule.yearMonth === 2 && rule.yearDay === 29 && (
                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        2月29日はうるう年（4年に1回）だけ開催されます。
                      </p>
                    )}
                    {[4, 6, 9, 11].includes(rule.yearMonth) && rule.yearDay === 31 && (
                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        その月に31日はありません。別の日を選んでください。
                      </p>
                    )}
                  </>
                )}

                {!ruleUnreadable && (
                  <>
                    <label>間隔</label>
                    <div className="nf2-seg" role="radiogroup" aria-label="間隔">
                      {(() => {
                        const freq = rule.freq as Freq;
                        const L = INTERVAL_LABELS[freq];
                        const min = customIntervalMin(freq);
                        const seg = (on: boolean, label: string, onClick: () => void) => (
                          <button type="button" key={label} role="radio" aria-checked={on} className={'nf2-seg-btn' + (on ? ' on' : '')} onClick={onClick}>
                            {label}
                          </button>
                        );
                        return (
                          <>
                            {seg(!intervalCustom && rule.interval === 1, L.every, () => {
                              setIntervalCustom(false);
                              patchRule({ interval: 1 });
                            })}
                            {L.alt &&
                              seg(!intervalCustom && rule.interval === 2, L.alt, () => {
                                setIntervalCustom(false);
                                patchRule({ interval: 2 });
                              })}
                            {seg(intervalCustom, `N${L.unit}`, () => {
                              setIntervalCustom(true);
                              if (rule.interval < min) patchRule({ interval: min });
                            })}
                            {intervalCustom && (
                              <span className="nf2-inline">
                                <TextField
                                  type="number"
                                  min={min}
                                  max={INTERVAL_MAX[freq]}
                                  aria-label="間隔"
                                  style={{ width: 80 }}
                                  value={Number.isFinite(rule.interval) ? String(rule.interval) : ''}
                                  onChange={(e) => patchRule({ interval: e.target.value === '' ? NaN : Number(e.target.value) })}
                                />
                                <span className="muted">
                                  {L.unit}（{min}〜{INTERVAL_MAX[freq]}）
                                </span>
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    {fieldErr(intervalBad, `間隔は ${customIntervalMin(rule.freq as Freq)}〜${INTERVAL_MAX[rule.freq as Freq]} で指定してください`)}
                  </>
                )}

                {needsAnchor && (
                  <div>
                    <label>
                      次にこのスケジュールで開催する日 <span className="muted">（間隔の起点）</span>
                    </label>
                    <Select
                      value={anchorDate}
                      onChange={(e) => {
                        setAnchorDate(e.target.value);
                        markDirty();
                      }}
                    >
                      {!anchorOptions.length && <option value="">（計算中…）</option>}
                      {anchorOptions.map((d) => (
                        <option key={d} value={d}>
                          {shortDateWithWeekday(d)}
                          {!anchorCandidates.includes(d) ? '（現在の設定）' : ''}
                        </option>
                      ))}
                    </Select>
                    {rule.freq === 'WEEKLY' && rule.weekdays.length > 1 && (
                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        この日より前の、同じ週の曜日は開催に含まれません。
                      </p>
                    )}
                    {fieldErr(!anchorDate, '次回の開催日を選んでください')}
                  </div>
                )}

                <div className="row">
                  <div>
                    <label>
                      開始時刻 <span className="req">✱</span>
                    </label>
                    <TextField type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                  </div>
                  <div>
                    <label>
                      開催時間（分）<span className="muted">（任意）</span>
                    </label>
                    <TextField type="number" min={0} placeholder="例: 120（2時間）" value={duration} onChange={(e) => setDuration(e.target.value)} />
                  </div>
                </div>

                <div className="nf2-live">
                  🗓️ <b>{scheduleText}</b>
                  {plan && plan.dates.length > 0 && (
                    <div className="nf2-live-dates">
                      次の開催日: {plan.dates.slice(0, 6).map((d) => shortDateWithWeekday(d)).join('　')}
                      {plan.dates.length > 6 ? '　…' : ''}
                    </div>
                  )}
                  {plan?.error && <div className="nf2-field-err">{plan.error}</div>}
                </div>
                {stepNav}
              </>
            )}

            {step === 'message' && (
              <>
                <p className="nf2-lead">チャンネルに投稿されるメッセージを作ります。下のプレビューに即時反映されます。</p>
                {/* 項目順はプレビューの表示順（メンション→見出し→本文）に合わせる */}
                <label>メンション方法 <span className="muted">（投稿の冒頭で呼びかける相手）</span></label>
                <Select value={mention} onChange={(e) => setMention(e.target.value as any)}>
                  <option value="role">ロール（区分のロール / @everyone）</option>
                  <option value="members">バイネーム（メンバーを個別に呼ぶ）</option>
                  <option value="none">なし</option>
                </Select>
                {mentionWarn && (
                  <p className="muted" style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                    ⚠️ @everyone 区分でバイネームは全員への個別メンションになり、人数が多いと「ほかN名」で省略されます。
                  </p>
                )}
                <label>
                  見出し <span className="req">✱</span> <span className="muted">（投稿の1行目・太字で表示）</span>
                </label>
                <TextField
                  maxLength={100}
                  placeholder="例: 第1・3・5日曜キャスト 開催のお知らせ"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                {fieldErr(!title.trim(), '見出しを入力してください')}
                <label>
                  本文 <span className="muted">（任意・複数行可。日時と回答ボタンは自動で付きます）</span>
                </label>
                <Textarea rows={3} maxLength={1500} placeholder="補足メッセージ（任意）" value={body} onChange={(e) => setBody(e.target.value)} />
                {/* 回答ボタンの有無＝メッセージの見た目に直結するため、プレビュー直前に置く */}
                <div className="setting-row">
                  <div className="setting-row-main">
                    <div className="setting-row-title">出欠確認（参加/不参加/未定の回答を集める）</div>
                    <div className="setting-row-desc">オフ＝出欠をとらず、開催告知の投稿だけを行います。リマインド・締切・ノルマは無効になります。</div>
                  </div>
                  <div className="setting-row-control">
                    <Switch
                      aria-label="出欠確認（参加/不参加/未定の回答を集める）"
                      checked={requireResponse}
                      onChange={(e) => setRequireResponse(e.target.checked)}
                    />
                  </div>
                </div>
                <div className="subhead">📺 プレビュー</div>
                {discordPreview}
                {stepNav}
              </>
            )}

            {step === 'flow' && (
              <>
                <p className="nf2-lead">
                  いつ・何が・誰に届くかの流れです。日数を変えると、下のタイムラインが実際に送られる順で並び替わります。
                  各工程のスイッチをオフにすると、その工程は自動では行いません（0 日前＝開催当日）。
                  {announceOnly ? '（出欠確認オフのため告知の投稿のみ）' : ''}
                </p>
                <div className="setting-row">
                  <div className="setting-row-main">
                    <div className="setting-row-title">🕘 送信時刻</div>
                    <div className="setting-row-desc">募集・リマインドなど日単位の送信は、毎日この時刻（JST）にまとめて行われます。</div>
                  </div>
                  <div className="setting-row-control">
                    <Select value={sendHour} onChange={(e) => setSendHour(e.target.value)}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="subhead">
                  📤 配信の流れ{' '}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {eventWhen ? `（次回 ${eventWhen} 開催の場合の例）` : '（開催日からの逆算・実際の日付は投稿時に確定）'}
                  </span>
                </div>
                <div className="nf2-tl">
                  {flowTimeline.map((n) => (
                    <div
                      key={n.key}
                      className={
                        'nf2-tl-node' + (n.warn ? ' err' : '') + (n.key === 'event' ? ' event' : '') + (n.on ? '' : ' off')
                      }
                    >
                      <div className="nf2-tl-when">{n.when}</div>
                      <div className="nf2-tl-spine">
                        <span className="nf2-tl-dot" />
                      </div>
                      <div className="nf2-tl-card">
                        <div className="nf2-tl-title">
                          <span>
                            {n.icon} {n.title}
                          </span>
                          {n.chip && <span className="pill">{n.chip === 'ch' ? '📢 チャンネル投稿' : '✉️ 個別DM'}</span>}
                          {n.onToggle && (
                            <span className="nf2-tl-switch" title={n.on ? 'オン＝自動で行う' : 'オフ＝自動では行わない'}>
                              <Switch aria-label={`${n.title}を自動で行う`} checked={n.on} onChange={(e) => n.onToggle!(e.target.checked)} />
                            </span>
                          )}
                        </div>
                        {n.on ? n.body : <div className="nf2-tl-off">{n.offText}</div>}
                        {n.warn && (
                          <div className="nf2-tl-err">
                            <span className="nf2-tip" tabIndex={0} role="note" aria-label={n.warn.detail} data-tip={n.warn.detail}>
                              ⚠️ {n.warn.head}（保存できません）
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {denseWarn && <div className="tl-warn">⚠️ {denseWarn}</div>}

                {/* 折りたたみにしない: 「有効」「ノルマ」の状態が隠れると気づけないため常時表示（2026-08-03 裁定） */}
                <div className="nf2-flow-more">
                  {!announceOnly && (
                      <div>
                        <div className="subhead">締切後の変更通知</div>
                        <label>
                          変更通知チャンネル <span className="muted">（締切後の変更を投稿・空欄＝投稿チャンネル）</span>
                        </label>
                        <Select value={alertChannelId} onChange={(e) => setAlertChannelId(e.target.value)}>
                          <option value="">（投稿チャンネルと同じ）</option>
                          {alertChannelOptions}
                        </Select>
                        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                          締切後に回答が変更されると、上のチャンネルへメンションなしで記録投稿し、回答履歴に「締切後変更」として残ります。
                        </p>
                        <div className="subhead">機能</div>
                        <div className="setting-row">
                          <div className="setting-row-main">
                            <div className="setting-row-title">ノルマ（参加間隔の督促）</div>
                            <div className="setting-row-desc">前回参加から指定日数を超えたメンバーへ DM で参加を促します（募集を投稿する日に送ります）。</div>
                          </div>
                          <div className="setting-row-control">
                            <Switch
                              aria-label="ノルマ（参加間隔の督促）"
                              checked={quotaEnabled}
                              onChange={(e) => setQuotaEnabled(e.target.checked)}
                            />
                          </div>
                        </div>
                        {quotaEnabled && (
                          <div style={{ maxWidth: 280 }}>
                            <label>ノルマ間隔（日数）</label>
                            <TextField type="number" placeholder="例: 30" value={quotaInterval} onChange={(e) => setQuotaInterval(e.target.value)} />
                          </div>
                        )}
                      </div>
                    )}
                    <div className="subhead">状態</div>
                    <div className="setting-row">
                      <div className="setting-row-main">
                        <div className="setting-row-title">有効</div>
                        <div className="setting-row-desc">オフにすると自動送信の対象外になります。</div>
                      </div>
                      <div className="setting-row-control">
                        <Switch aria-label="有効（自動送信の対象）" checked={active} onChange={(e) => setActive(e.target.checked)} />
                      </div>
                    </div>
                </div>
                {stepNav}
              </>
            )}

            {step === 'confirm' && (
              <>
                <p className="nf2-lead">内容を確認して{nuuid ? '保存' : '作成'}してください。各カードの「編集」から修正できます。</p>
                {summaryCard(
                  'basic',
                  <>
                    {summaryRow('スケジュール名', name.trim() || <span className="nf2-unset">未入力</span>)}
                    {summaryRow('対象区分', mentionSeg ? mentionSeg.name : <span className="nf2-unset">未選択</span>)}
                    {summaryRow('投稿チャンネル', channelId ? chLabel(channelId) : <span className="nf2-unset">未選択</span>)}
                  </>,
                )}
                {summaryCard(
                  'when',
                  <>
                    {summaryRow('開催日時', scheduleText)}
                    {plan && plan.dates.length > 0 && summaryRow('次の開催日', plan.dates.slice(0, 4).map((d) => shortDateWithWeekday(d)).join('　'))}
                  </>,
                )}
                {summaryCard(
                  'message',
                  <>
                    {summaryRow(
                      'メンション',
                      mention === 'role' ? 'ロール' : mention === 'members' ? 'バイネーム' : 'なし',
                    )}
                    {summaryRow('見出し', title.trim() || <span className="nf2-unset">未入力</span>)}
                    {summaryRow('本文', body.trim() ? `${body.trim().split('\n')[0].slice(0, 30)}${body.trim().length > 30 ? '…' : ''}` : 'なし')}
                    {summaryRow('出欠確認', requireResponse ? 'あり（募集）' : 'なし（告知のみ）')}
                  </>,
                )}
                {summaryCard(
                  'flow',
                  <>
                    {summaryRow('配信', timelineText)}
                    {!announceOnly && summaryRow('ノルマ', quotaEnabled ? `あり（${quotaInterval || '—'}日間隔）` : 'なし')}
                    {summaryRow('状態', <Pill tone={active ? 'on' : 'off'}>{active ? '有効' : '無効'}</Pill>)}
                  </>,
                )}
                {[
                  ...flowIssues.map((w) => ({ text: `${FLOW_STEP_NAMES[w.step]}: ${w.head}。${w.detail}（保存できません）`, err: true })),
                  ...(denseWarn ? [{ text: denseWarn, err: false }] : []),
                ].map((w, i) => (
                  <div key={i} className={w.err ? 'tl-err' : 'tl-warn'}>
                    ⚠️ {w.text}
                  </div>
                ))}
                <div className="subhead">📺 投稿されるメッセージ</div>
                {discordPreview}
                {stepNav}
              </>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
