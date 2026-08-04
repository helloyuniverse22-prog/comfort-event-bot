// スケジュールの新規作成・編集ページ v2（ゼロベース再設計・ウィザード型）。
// 現行 NotificationForm.tsx と並存し、ルート notifications/new2・<uuid>/edit2 で表示する。
// 保存 payload・API 契約は v1 と完全に同一（差は画面構成のみ）。
// 設計: 左にステップレール、右に1ステップずつ表示。新規=基本情報から順に、編集=確認（サマリー）から各項目へジャンプ。
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Pill, Select, Switch, TextField, Textarea } from '../../../design-system/src';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { buildRecruitPreviewParts, notifPreviewSummary } from '../lib/notifPreview';
import {
  NTH,
  WEEKDAYS,
  buildRRule,
  dedupeMonthlyRules,
  nextWeekdayDates,
  parseRRuleToBuilder,
  scheduleSummary,
  type MonthlyRule,
  type RepeatMode,
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

const MODES: { key: RepeatMode; label: string; desc: string }[] = [
  { key: 'weekly', label: '毎週', desc: '毎週 同じ曜日に開催' },
  { key: 'biweekly', label: '隔週', desc: '2週おき（起点日を選択）' },
  { key: 'monthly', label: '毎月 第N曜', desc: '第1・第3日曜 など' },
];

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

  // ---- フォーム状態（v1 と同一の既定値） ----
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [segmentUuid, setSegmentUuid] = useState('');
  const [channelId, setChannelId] = useState('');
  const [extraChannelOpt, setExtraChannelOpt] = useState<Channel | null>(null);
  const [mode, setMode] = useState<RepeatMode>('weekly');
  const [weekday, setWeekday] = useState('SA');
  const [monthlyRules, setMonthlyRules] = useState<MonthlyRule[]>([{ nth: '2', byday: 'SA' }]);
  const [biweeklyAnchor, setBiweeklyAnchor] = useState('');
  const [startTime, setStartTime] = useState('21:00');
  const [duration, setDuration] = useState('');
  const [mention, setMention] = useState<'role' | 'members' | 'none'>('role');
  const [requireResponse, setRequireResponse] = useState(true);
  const [deadlineHours, setDeadlineHours] = useState('');
  const [recruitDays, setRecruitDays] = useState('7');
  const [remindStartDays, setRemindStartDays] = useState('3');
  const [remindUndecidedDays, setRemindUndecidedDays] = useState('1');
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
          if (n.type === 'oneoff') {
            toast('単発（旧形式）の編集は現在無効です。', true);
            setNotFound(true);
            return;
          }
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
    setTitle(n.message_title || '');
    setBody(n.message_body || '');
    if (n.channel_id && !c.some((x) => x.id === n.channel_id)) setExtraChannelOpt({ id: n.channel_id, name: 'ID: ' + n.channel_id });
    setChannelId(n.channel_id || '');
    const seg = s.find((x) => x.id === n.segment_id);
    setSegmentUuid(seg ? seg.uuid : '');
    const b = parseRRuleToBuilder(n.rrule);
    setMode(b.mode);
    setWeekday(b.byday);
    setMonthlyRules(b.mode === 'monthly' && b.rules.length ? b.rules : [{ nth: '2', byday: 'SA' }]);
    setBiweeklyAnchor(n.anchor_date || '');
    setStartTime(n.start_time || '21:00');
    setDuration(n.duration_minutes == null ? '' : String(n.duration_minutes));
    setRecruitDays(String(n.recruit_days_before));
    setRemindStartDays(String(n.remind_start_days));
    setRemindUndecidedDays(String(n.remind_undecided_days));
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

  const biweeklyOptions = useMemo(() => {
    const dates = nextWeekdayDates(weekday, 4);
    return biweeklyAnchor && !dates.includes(biweeklyAnchor) ? [biweeklyAnchor, ...dates] : dates;
  }, [weekday, biweeklyAnchor]);

  // 隔週へ切替時に起点未選択なら直近日を既定にする（空のまま保存させない）
  useEffect(() => {
    if (mode === 'biweekly' && !biweeklyAnchor && biweeklyOptions.length) setBiweeklyAnchor(biweeklyOptions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, weekday]);

  const durationNum = duration.trim() === '' ? null : Number(duration);
  const deadlineNum = deadlineHours.trim() === '' ? null : Number(deadlineHours);
  const announceOnly = !requireResponse;
  const scheduleText = scheduleSummary({ mode, weekday, startTime, duration: durationNum, monthlyRules, biweeklyAnchor });
  const { text: timelineText, warns } = notifPreviewSummary({
    requireResponse,
    recruitDays: numOrNull(recruitDays),
    remindStartDays: numOrNull(remindStartDays),
    remindUndecidedDays: numOrNull(remindUndecidedDays),
    deadlineHours: deadlineNum,
    sendHour: Number(sendHour),
    scheduleText,
  });
  const previewParts = buildRecruitPreviewParts({
    title,
    body,
    mode,
    startTime,
    weekday,
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
  // 週次/隔週は次回開催日から具体日を例示（月次の実体化は投稿時のため相対表示のみ）。
  const WD_JP = ['日', '月', '火', '水', '木', '金', '土'];
  const shNum = Number(sendHour);
  const [evH, evM] = (startTime || '21:00').split(':').map((x) => Number(x) || 0);
  const exampleEventDate =
    (mode === 'weekly' || mode === 'biweekly') && weekday ? (nextWeekdayDates(weekday, 1)[0] ?? null) : null;
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
      warn: string | null;
      body: React.ReactNode;
    };
    const nodes: FlowNode[] = [
      {
        key: 'recruit',
        sort: minBeforeDay(rDaysN, 7),
        when: whenDay(rDaysN),
        icon: '📣',
        title: announceOnly ? '告知を投稿' : '募集を投稿',
        chip: 'ch' as const,
        warn: null,
        body: (
          <div className="nf2-tl-inline">
            <span>開催の</span>
            {num(recruitDays, setRecruitDays)}
            <span>日前に投稿</span>
          </div>
        ),
      },
      ...(announceOnly
        ? []
        : ([
            {
              key: 'remind',
              sort: minBeforeDay(rsDaysN, 3),
              when: whenDay(rsDaysN),
              icon: '✉️',
              title: '未回答者へリマインド',
              chip: 'dm',
              warn:
                rsDaysN != null && rDaysN != null && isFinite(rsDaysN) && isFinite(rDaysN) && rsDaysN > rDaysN
                  ? '募集より前に催促が始まります'
                  : null,
              body: (
                <div className="nf2-tl-inline">
                  <span>開催の</span>
                  {num(remindStartDays, setRemindStartDays)}
                  <span>日前から毎日、未回答のメンバーへ</span>
                </div>
              ),
            },
            {
              key: 'undecided',
              sort: minBeforeDay(ruDaysN, 1),
              when: whenDay(ruDaysN),
              icon: '✉️',
              title: '未定者へリマインド',
              chip: 'dm',
              warn:
                ruDaysN != null && rsDaysN != null && isFinite(ruDaysN) && isFinite(rsDaysN) && ruDaysN > rsDaysN
                  ? '未回答リマインドの開始より前です'
                  : null,
              body: (
                <div className="nf2-tl-inline">
                  <span>開催の</span>
                  {num(remindUndecidedDays, setRemindUndecidedDays)}
                  <span>日前に1回、「未定」回答のメンバーへ</span>
                </div>
              ),
            },
            {
              key: 'deadline',
              sort: deadlineNum != null && isFinite(deadlineNum) ? deadlineNum * 60 : 0,
              when: whenDeadline(deadlineNum),
              icon: '⏰',
              title: '回答締切',
              chip: 'ch',
              warn:
                deadlineNum != null && rDaysN != null && isFinite(rDaysN) && deadlineNum > rDaysN * 24
                  ? '募集より前に締め切られてしまいます'
                  : null,
              body: (
                <div className="nf2-tl-inline">
                  <span>開始の</span>
                  {num(deadlineHours, setDeadlineHours, '—')}
                  <span>時間前</span>
                  <span className="muted">（空欄＝締切なし・締切時に告知をチャンネルへ投稿）</span>
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
      body: <div className="nf2-tl-eventdesc">{scheduleText}</div>,
    });
    return nodes;
  })();

  // ---- ステップごとの必須未入力（レール表示・保存前チェックで共用） ----
  const missing: Record<StepKey, string[]> = {
    basic: [!name.trim() && 'スケジュール名', !segmentUuid && '対象区分', !channelId && '投稿チャンネル'].filter(
      (x): x is string => !!x,
    ),
    when: mode === 'biweekly' && !biweeklyAnchor ? ['隔週の起点日'] : [],
    message: !title.trim() ? ['見出し'] : [],
    flow: [],
    confirm: [],
  };

  // 未入力エラーは解消され次第フッターから消す（API エラーは保持）
  const allOk = ALL_STEPS.every((k) => missing[k].length === 0);
  useEffect(() => {
    if (allOk && formErr.startsWith('未入力')) setFormErr('');
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
      setFormErr(`未入力の項目があります: ${missing[firstBad].join('・')}`);
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
      rrule: buildRRule(mode, weekday, dedupeMonthlyRules(monthlyRules)),
      anchor_date: mode === 'biweekly' ? biweeklyAnchor || null : null,
      start_time: startTime.trim() || '21:00',
      duration_minutes: durationNum,
      message_title: title.trim(),
      message_body: body.trim() || null,
      recruit_days_before: numOrNull(recruitDays) ?? 7,
      remind_start_days: numOrNull(remindStartDays) ?? 3,
      remind_undecided_days: numOrNull(remindUndecidedDays) ?? 1,
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
        if (nuuid) await api('/notifications/' + nuuid, { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/notifications', { method: 'POST', body: JSON.stringify(payload) });
        onDirtyChange(false);
        setDirty(false);
        onSaved();
        toast(nuuid ? '更新しました' : '作成しました');
      } catch (e) {
        setFormErr(e instanceof Error ? e.message : String(e));
      }
    });
  };

  if (notFound) return null;
  if (loading) return <p className="muted">読み込み中…</p>;

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

  const stepNav = (
    <div className="nf2-nav">
      {stepIdx > 0 ? (
        <button type="button" className="btn ghost" onClick={() => goto(ALL_STEPS[stepIdx - 1])}>
          ← {STEPS[stepIdx - 1].label}
        </button>
      ) : (
        <span />
      )}
      {stepIdx < ALL_STEPS.length - 1 ? (
        <button type="button" className="btn" onClick={() => goto(ALL_STEPS[stepIdx + 1])}>
          次へ: {STEPS[stepIdx + 1].label} →
        </button>
      ) : (
        <button type="button" className="btn" onClick={(e) => save(e.currentTarget)}>
          {nuuid ? '保存する' : 'この内容で作成する'}
        </button>
      )}
    </div>
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
      <p className="preview-note">※ @メンションと候補日一覧は投稿時に展開されます。月次/隔週の日付は近似表示です。</p>
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
          <h3 id="nFormTitle">
            {nuuid ? 'スケジュールを編集' : '新規スケジュール'} <Pill>✨ 新デザイン</Pill>
          </h3>
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
                  {showBad(s.key) && <span className="nf2-step-alert">未入力</span>}
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
                <p className="nf2-lead">いつ開催するかを決めます。開催日の候補はここから自動で計算されます。</p>
                <label>繰り返し</label>
                <div className="nf2-modes" role="radiogroup" aria-label="繰り返し">
                  {MODES.map((m) => (
                    <button
                      type="button"
                      key={m.key}
                      role="radio"
                      aria-checked={mode === m.key}
                      className={'nf2-mode' + (mode === m.key ? ' on' : '')}
                      onClick={() => {
                        setMode(m.key);
                        markDirty();
                      }}
                    >
                      <span className="nf2-mode-title">{m.label}</span>
                      <span className="nf2-mode-desc">{m.desc}</span>
                    </button>
                  ))}
                </div>

                {mode !== 'monthly' && (
                  <>
                    <label>曜日</label>
                    <div className="nf2-chips" role="radiogroup" aria-label="曜日">
                      {WEEKDAYS.map(([v, l]) => (
                        <button
                          type="button"
                          key={v}
                          role="radio"
                          aria-checked={weekday === v}
                          className={'nf2-chip' + (weekday === v ? ' on' : '')}
                          onClick={() => {
                            setWeekday(v);
                            markDirty();
                          }}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {mode === 'monthly' && (
                  <div>
                    <label>開催日（第N × 曜日・複数可）</label>
                    <div className="timechips">
                      {monthlyRules.map((r, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Select
                            style={{ width: 'auto' }}
                            aria-label="第N"
                            value={r.nth}
                            onChange={(e) => setMonthlyRules(monthlyRules.map((x, xi) => (xi === i ? { ...x, nth: e.target.value } : x)))}
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
                              setMonthlyRules(monthlyRules.map((x, xi) => (xi === i ? { ...x, byday: e.target.value } : x)))
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
                              if (monthlyRules.length > 1) {
                                setMonthlyRules(monthlyRules.filter((_, xi) => xi !== i));
                                markDirty();
                              } else toast('ルールは最低1つ必要です', true);
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
                      onClick={() => {
                        setMonthlyRules([...monthlyRules, { nth: '1', byday: 'SU' }]);
                        markDirty();
                      }}
                    >
                      ＋ ルールを追加
                    </button>
                    <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      例: 第1・第3・第5 日曜／第1日曜＋第3火曜。「第5」は5週ある月のみ・「最終」は常に最後の週。
                    </p>
                  </div>
                )}

                {mode === 'biweekly' && (
                  <div>
                    <label>
                      次にこのスケジュールで開催する日 <span className="muted">（隔週の起点）</span>
                    </label>
                    <Select value={biweeklyAnchor} onChange={(e) => setBiweeklyAnchor(e.target.value)}>
                      {biweeklyOptions.map((d) => (
                        <option key={d} value={d}>
                          {d}（{WEEKDAYS.find((w) => w[0] === weekday)?.[1]}）
                        </option>
                      ))}
                    </Select>
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
                    <div key={n.key} className={'nf2-tl-node' + (n.warn ? ' warn' : '') + (n.key === 'event' ? ' event' : '')}>
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
                        </div>
                        {n.body}
                        {n.warn && <div className="nf2-tl-warn">⚠️ {n.warn}</div>}
                      </div>
                    </div>
                  ))}
                </div>

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
                            <div className="setting-row-desc">前回参加から指定日数を超えたメンバーへ DM で参加を促します。</div>
                          </div>
                          <div className="setting-row-control">
                            <Switch aria-label="ノルマ（参加間隔の督促）" checked={quotaEnabled} onChange={(e) => setQuotaEnabled(e.target.checked)} />
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
                {summaryCard('when', summaryRow('開催日時', scheduleText))}
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
                {warns.map((w, i) => (
                  <div key={i} className="tl-warn">
                    ⚠️ {w}
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

      <div className="modal-foot">
        <span className="muted" style={{ color: 'var(--danger)', marginRight: 'auto' }}>
          {formErr}
        </span>
        <button type="button" className="btn ghost" onClick={attemptClose}>
          キャンセル
        </button>
        <button type="button" className="btn" onClick={(e) => save(e.currentTarget)}>
          保存
        </button>
      </div>
    </dialog>
  );
}
