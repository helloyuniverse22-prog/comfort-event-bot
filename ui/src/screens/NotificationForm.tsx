// スケジュールの新規作成・編集ページ（旧 #nDialog の子ページ化。ADR 0016）。
// 単発(oneoff)UIは撤去済み・recurring 専用（旧実装踏襲。type は常に 'recurring' で送信）。
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Select, Switch, TextField, Textarea } from '../../../design-system/src';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { buildRecruitPreviewText, notifPreviewSummary } from '../lib/notifPreview';
import {
  NTH,
  WEEKDAYS,
  anchorMatchesWeekday,
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

export function NotificationForm({
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

  // ---- フォーム状態（既定値は旧 resetNotifForm と同一） ----
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [segmentUuid, setSegmentUuid] = useState('');
  const [channelId, setChannelId] = useState('');
  const [extraChannelOpt, setExtraChannelOpt] = useState<Channel | null>(null); // 取得できなかった既存チャンネルの救済表示
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [dirty, setDirty] = useState(false);

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
    setAdvancedOpen(true);
  }

  const biweeklyOptions = useMemo(() => {
    const dates = nextWeekdayDates(weekday, 4);
    return biweeklyAnchor && !dates.includes(biweeklyAnchor) ? [biweeklyAnchor, ...dates] : dates;
  }, [weekday, biweeklyAnchor]);

  // 隔週へ切替時・曜日変更時: 起点が未選択または曜日不一致なら直近日に取り直す
  // （未選択のまま保存すると select の見た目と保存値(null)がズレ、パリティが不定になるため）
  useEffect(() => {
    if (mode !== 'biweekly' || anchorMatchesWeekday(biweeklyAnchor, weekday)) return;
    const dates = nextWeekdayDates(weekday, 1);
    if (dates.length) setBiweeklyAnchor(dates[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, weekday]);

  const durationNum = duration.trim() === '' ? null : Number(duration);
  const deadlineNum = deadlineHours.trim() === '' ? null : Number(deadlineHours);
  const scheduleText = scheduleSummary({
    mode,
    weekday,
    startTime,
    duration: durationNum,
    monthlyRules,
    biweeklyAnchor,
  });
  const { text: timelineText, warns } = notifPreviewSummary({
    requireResponse,
    recruitDays: numOrNull(recruitDays),
    remindStartDays: numOrNull(remindStartDays),
    remindUndecidedDays: numOrNull(remindUndecidedDays),
    deadlineHours: deadlineNum,
    sendHour: Number(sendHour),
    scheduleText,
  });
  const previewText = buildRecruitPreviewText({
    title,
    body,
    mode,
    startTime,
    weekday,
    biweeklyAnchor,
    duration: durationNum,
    deadlineHours: deadlineNum,
    mention,
    requireResponse,
  });
  const mentionSeg = segs.find((s) => s.uuid === segmentUuid);
  const mentionWarn = mention === 'members' && !!mentionSeg && mentionSeg.mention_role_id === '@everyone';

  const attemptClose = async () => {
    if (dirty) {
      const ok = await confirmDialog('未保存の変更があります。破棄して閉じますか？', { okLabel: '破棄する', danger: true });
      if (!ok) return;
    }
    onDirtyChange(false);
    onClose();
  };

  const save = async (btn: HTMLElement | null) => {
    if (!name.trim()) return setFormErr('名前は必須です');
    if (!title.trim()) return setFormErr('見出しは必須です');
    if (!channelId) return setFormErr('チャンネルを選択してください');
    if (!segmentUuid) return setFormErr('区分を選択してください');
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

  const announceOnly = !requireResponse;
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
          <h3 id="nFormTitle">{nuuid ? '編集' : '新規スケジュール'}</h3>
        </div>
        <button type="button" className="page-back" aria-label="戻る" onClick={attemptClose}>
          ← 戻る
        </button>
      </div>

      <div className="modal-body" onInput={markDirty} onChange={markDirty}>
        <div className="form-pane">
          <div className="subhead">📣 メンション</div>
          <label>
            対象区分 <span className="req">✱</span>
          </label>
          <Select value={segmentUuid} onChange={(e) => setSegmentUuid(e.target.value)}>
            <option value="" />
            {segOptions}
          </Select>
          <label>メンション方法</label>
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

          <div className="subhead">📝 投稿メッセージ</div>
          <label>
            見出し <span className="req">✱</span> <span className="muted">（投稿の1行目）</span>
          </label>
          <TextField
            maxLength={100}
            placeholder="例: 第1・3・5日曜キャスト 開催のお知らせ"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label>
            本文 <span className="muted">（任意・複数行可。日時と回答ボタンは自動で付きます）</span>
          </label>
          <Textarea
            rows={3}
            maxLength={1500}
            placeholder="補足メッセージ（任意）"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />

          <div className="subhead">🗓️ 開催スケジュール</div>
          <div className="row">
            <div>
              <label>
                繰り返し <span className="req">✱</span>
              </label>
              <Select value={mode} onChange={(e) => setMode(e.target.value as RepeatMode)}>
                <option value="weekly">毎週</option>
                <option value="biweekly">隔週</option>
                <option value="monthly">毎月第N曜</option>
              </Select>
            </div>
            <div>
              <label>
                イベント開始時刻 <span className="req">✱</span>
              </label>
              <TextField type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
          </div>
          {mode !== 'monthly' && (
            <div>
              <label>曜日</label>
              <Select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                {WEEKDAYS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
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
                開催時間（分）<span className="muted">（任意・空欄で開始時刻のみ表示）</span>
              </label>
              <TextField type="number" min={0} placeholder="例: 120（2時間）" value={duration} onChange={(e) => setDuration(e.target.value)} />
            </div>
            <div />
          </div>

          <div className="subhead">🗳️ 出欠確認</div>
          <div className="setting-row">
            <div className="setting-row-main">
              <div className="setting-row-title">出欠確認（参加/不参加/未定の回答を集める）</div>
              <div className="setting-row-desc">オフ＝出欠をとらず、開催告知の投稿だけを行います。リマインド・締切・ノルマ・番号は無効になります。</div>
            </div>
            <div className="setting-row-control">
              <Switch
                aria-label="出欠確認（参加/不参加/未定の回答を集める）"
                checked={requireResponse}
                onChange={(e) => setRequireResponse(e.target.checked)}
              />
            </div>
          </div>
          {!announceOnly && (
            <div style={{ marginTop: 8 }}>
              <label>
                回答締切 <span className="muted">（任意・空欄＝締切なし）</span>{' '}
                <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                  📢 締切告知はチャンネルに投稿
                </span>
              </label>
              <div className="tl-row">
                <span className="pre">開始の</span>
                <TextField type="number" min={0} placeholder="—" value={deadlineHours} onChange={(e) => setDeadlineHours(e.target.value)} />
                <span className="post">時間前</span>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                設定すると投稿本文に「回答締切」行が追加されます。締切後の変更通知先は「動作設定 → 詳細設定」で変更できます。
              </p>
            </div>
          )}

          <div className="preview-boundary">↓ プレビューには影響しません</div>

          <div className="subhead">⚙️ 動作設定</div>
          <div className="row">
            <div>
              <label>
                スケジュール名 <span className="req">✱</span>
              </label>
              <TextField placeholder="例: 土曜定例・キャスト出欠" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label>
                投稿チャンネル <span className="req">✱</span>
              </label>
              <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                <option value="" />
                {channelOptions}
              </Select>
            </div>
          </div>

          <div className="tl" style={{ marginTop: 12 }}>
            <div className="tl-step">
              <span className="tl-badge">1</span>
              <div className="tl-main">
                <div className="tl-title">
                  <span>{announceOnly ? '告知を投稿' : '募集を投稿'}</span>{' '}
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                    📢 チャンネルに投稿
                  </span>
                </div>
                <div className="tl-row">
                  <span className="pre">開催の</span>
                  <TextField type="number" min={0} value={recruitDays} onChange={(e) => setRecruitDays(e.target.value)} />
                  <span className="post">日前</span>
                </div>
              </div>
            </div>
            {!announceOnly && (
              <>
                <div className="tl-step">
                  <span className="tl-badge">2</span>
                  <div className="tl-main">
                    <div className="tl-title">
                      未回答者へリマインド{' '}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                        ✉️ 未回答のメンバーへ個別DM
                      </span>
                    </div>
                    <div className="tl-row">
                      <span className="pre">開催の</span>
                      <TextField type="number" min={0} value={remindStartDays} onChange={(e) => setRemindStartDays(e.target.value)} />
                      <span className="post">日前から毎日</span>
                    </div>
                  </div>
                </div>
                <div className="tl-step">
                  <span className="tl-badge">3</span>
                  <div className="tl-main">
                    <div className="tl-title">
                      未定者へリマインド{' '}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                        ✉️ 「未定」回答のメンバーへ個別DM
                      </span>
                    </div>
                    <div className="tl-row">
                      <span className="pre">開催の</span>
                      <TextField
                        type="number"
                        min={0}
                        value={remindUndecidedDays}
                        onChange={(e) => setRemindUndecidedDays(e.target.value)}
                      />
                      <span className="post">日前に1回</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="tl-send muted">
            🕘 送信時刻{' '}
            <Select style={{ display: 'inline-block', width: 'auto' }} value={sendHour} onChange={(e) => setSendHour(e.target.value)}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </Select>
            （JST）
          </div>

          <div>
            {warns.map((w, i) => (
              <div key={i} className="tl-warn">
                ⚠️ {w}
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            {timelineText}
          </p>

          <details className="section" open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
            <summary>詳細設定（必要に応じて）</summary>
            <div className="section-body">
              {/* 回答を集めない（告知のみ）場合、回答に依存する設定は見出しごと出さない（M9） */}
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
                </div>
              )}

              {!announceOnly && (
                <>
                  <div className="subhead">機能</div>
                  <div className="setting-row">
                    <div className="setting-row-main">
                      <div className="setting-row-title">ノルマ（参加間隔の督促）</div>
                      <div className="setting-row-desc">前回参加から指定日数を超えたメンバーへ DM で参加を促します。</div>
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
                </>
              )}

              <div className="subhead">状態</div>
              <div className="setting-row">
                <div className="setting-row-main">
                  <div className="setting-row-title">有効</div>
                  <div className="setting-row-desc">オフにすると cron 送信の対象外になります。</div>
                </div>
                <div className="setting-row-control">
                  <Switch aria-label="有効（cron 送信の対象）" checked={active} onChange={(e) => setActive(e.target.checked)} />
                </div>
              </div>
            </div>
          </details>
        </div>

        <aside className="preview-pane" aria-label={announceOnly ? '告知メッセージのプレビュー' : '募集メッセージのプレビュー'}>
          <h4>📺 {announceOnly ? '告知' : '募集'}メッセージ プレビュー</h4>
          <pre className="preview-content">{previewText}</pre>
          <p className="preview-note">※ @メンションと候補日一覧は投稿時に展開されます。月次/隔週は次回開催日が近似表示です。</p>
        </aside>
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
