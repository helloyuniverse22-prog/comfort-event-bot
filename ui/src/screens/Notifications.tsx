// スケジュール設定（マスター一覧）。新規/編集/メンバー配置設定は子ページへ遷移（ADR 0016）、
// 投稿/削除はその場でアクション。Phase 4 ブループリント（.design-sync/templates/NotificationList.dc.html）準拠。
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Actions, Pill, Switch } from '../../../design-system/src';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { fmtTimeRange, humanRRule } from '../lib/rrule';
import type { ToastFn } from '../App';

type Segment = { id: string; name: string };
type Channel = { id: string; name: string };
type Notification = {
  uuid: string;
  name: string;
  type: 'oneoff' | 'recurring' | string;
  rrule?: string | null;
  start_time?: string | null;
  duration_minutes?: number | null;
  one_off_date?: string | null;
  decided_occurrence_id?: string | null;
  decided_date?: string | null;
  decided_time?: string | null;
  candidate_count?: number | null;
  segment_id: string;
  channel_id: string;
  requires_response?: number;
  active: 0 | 1 | boolean;
};
type Estimate = {
  overDaily: boolean;
  overWindow: boolean;
  dailyTotal: number;
  maxWindow: number;
  recommendedDaily: number;
  recommendedPerWindow: number;
  budget: number;
};

type Filter = 'all' | 'on' | 'off';

function oneoffSched(n: Notification): string {
  const earliest = `${n.one_off_date || ''}${n.start_time ? ' ' + fmtTimeRange(n.start_time, n.duration_minutes) : ''}`;
  if (n.decided_occurrence_id && n.decided_date) {
    return `単発・確定 ${n.decided_date}${n.decided_time ? ' ' + fmtTimeRange(n.decided_time, n.duration_minutes) : ''}`;
  }
  if ((n.candidate_count || 0) > 1) return `単発・調整中（候補${n.candidate_count}件・最早 ${earliest}）`;
  return `単発 ${earliest}`;
}
function schedText(n: Notification): string {
  return n.type === 'oneoff' ? oneoffSched(n) : humanRRule(n.rrule, n.start_time, n.duration_minutes);
}

export function NotificationsScreen({
  guild,
  toast,
  onError,
  onNew,
  onEdit,
  onGroupingSettings,
}: {
  guild: Guild;
  toast: ToastFn;
  onError: (e: unknown) => void;
  onNew: (v2?: boolean) => void;
  onEdit: (uuid: string, v2?: boolean) => void;
  onGroupingSettings: (uuid: string) => void;
}) {
  const [segs, setSegs] = useState<Segment[]>([]);
  const [notifs, setNotifs] = useState<Notification[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [est, setEst] = useState<Estimate | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // 新デザインのフォーム（v2）を使うか。現行フォームと並存中の切替スイッチ。
  const [formV2, setFormV2] = useState(() => localStorage.getItem('eb.formV2') === '1');
  const toggleFormV2 = (on: boolean) => {
    setFormV2(on);
    localStorage.setItem('eb.formV2', on ? '1' : '0');
  };

  const load = async () => {
    try {
      const g = encodeURIComponent(guild.id);
      const [s, n, c] = await Promise.all([
        api('/segments?guild_id=' + g),
        api('/notifications?guild_id=' + g),
        api(`/guilds/${guild.id}/channels`).catch(() => []),
      ]);
      setSegs(s);
      setNotifs(n);
      setChannels(c);
    } catch (e) {
      setNotifs([]);
      onError(e);
    }
    try {
      setEst(await api('/send-estimate?guild_id=' + encodeURIComponent(guild.id)));
    } catch {}
  };

  useEffect(() => {
    let alive = true;
    load().then(() => {
      if (!alive) return;
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  const segName = (id: string) => segs.find((x) => x.id === id)?.name ?? '?';
  const chName = (id: string) => {
    const c = channels.find((x) => x.id === id);
    return c ? '#' + c.name : id;
  };

  const recruit = async (btn: HTMLElement | null, n: Notification) => {
    // 出欠確認なし（告知のみ）のスケジュールは操作名も「告知」で統一する（用語は CONTEXT.md）
    const noun = n.requires_response === 0 ? '告知' : '募集';
    const ok = await confirmDialog(
      noun === '告知'
        ? 'このスケジュールの開催告知を今すぐチャンネルへ投稿しますか？'
        : 'このスケジュールの募集メッセージを今すぐチャンネルへ投稿しますか？',
      { title: `今すぐ${noun}`, okLabel: '投稿する' },
    );
    if (!ok) return;
    await withBusy(btn, async () => {
      try {
        const r = await api('/notifications/' + n.uuid + '/recruit', { method: 'POST' });
        toast(r && r.message ? r.message : `${noun}メッセージを投稿しました`);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  const remove = async (uuid: string) => {
    const ok = await confirmDialog('このスケジュールを、配下の開催日・回答ごとすべて削除します。元に戻せません。', { danger: true, okLabel: '削除する' });
    if (!ok) return;
    try {
      await api('/notifications/' + uuid, { method: 'DELETE' });
      toast('削除しました');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };

  if (notifs === null) return <p className="muted">読み込み中…</p>;

  const over = est && (est.overDaily || est.overWindow);
  const shown = notifs.filter((n) => (filter === 'all' ? true : filter === 'on' ? !!n.active : !n.active));

  return (
    <>
      {over && est && (
        <div className="alert warn" style={{ marginBottom: 14 }}>
          <div className="alert-icon">⚠️</div>
          <div>
            <div style={{ fontWeight: 600 }}>送信量が無料枠の推奨上限を超えています</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              推定ピーク: <b>{est.dailyTotal}</b> 件/日（同一送信時刻 最大 <b>{est.maxWindow}</b> 件）／ 推奨: 日次 ≤{' '}
              {est.recommendedDaily}・同一時刻 ≤ {est.recommendedPerWindow}（送信予算 {est.budget}/分）。
              送信時刻を分散するか、Paid 化のうえ送信予算を上げてください。
            </div>
          </div>
        </div>
      )}

      <div className="sec-head">
        <h2>スケジュール設定 ({notifs.length})</h2>
        <button className="btn" disabled={!segs.length} onClick={() => onNew(formV2)}>
          ＋ 新規スケジュール
        </button>
      </div>
      {!segs.length && <p className="muted">※ 先に「メンバー区分」を作成してください（スケジュールの対象になります）。</p>}

      <Actions style={{ margin: '4px 0 12px' }}>
        {(
          [
            ['all', 'すべて'],
            ['on', '有効'],
            ['off', '無効'],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <button key={k} className={'btn sm ' + (filter === k ? 'secondary' : 'ghost')} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
        <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <span className="muted">✨ 新デザインのフォームを使う</span>
          <Switch aria-label="新デザインのフォームを使う" checked={formV2} onChange={(e) => toggleFormV2(e.target.checked)} />
        </label>
      </Actions>

      {shown.length === 0 ? (
        <div className="empty">
          {notifs.length === 0 ? (
            <>
              まだスケジュールがありません。
              <br />
              「＋ 新規スケジュール」から最初のスケジュールを作成しましょう。
            </>
          ) : (
            '該当するスケジュールがありません。'
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((n) => (
            <div key={n.uuid} className="listrow">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div className="ava">{(n.name || '?').slice(0, 1)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{n.name}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 1 }}>
                    <Pill>{segName(n.segment_id)}</Pill> {schedText(n)} ・ {chName(n.channel_id)}
                  </div>
                </div>
              </div>
              <Actions>
                <Pill tone={n.active ? 'on' : 'off'}>{n.active ? '有効' : '無効'}</Pill>
                <button className="btn sm ghost" onClick={(e) => recruit(e.currentTarget, n)}>
                  📣 今すぐ{n.requires_response === 0 ? '告知' : '募集'}
                </button>
                <button className="btn sm ghost" onClick={() => onGroupingSettings(n.uuid)}>
                  メンバー配置設定
                </button>
                <button className="btn sm ghost" onClick={() => onEdit(n.uuid, formV2)}>
                  編集
                </button>
                <button className="btn sm ghost danger" onClick={() => remove(n.uuid)}>
                  削除
                </button>
              </Actions>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
