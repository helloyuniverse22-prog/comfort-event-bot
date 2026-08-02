import * as React from 'react';
import { useEffect, useState } from 'react';
import { api, type Guild } from '../api';
import { esc } from '../lib/esc';
import { EventBotTable } from '../lib/EventBotTable';
import type { ToastFn } from '../App';

type Segment = { id: number; uuid: string; name: string };

type NotifRow = { uuid: string; name: string; segment_id: number; requires_response: number };

type ReportRow = {
  user_id: string;
  name: string;
  first_date: string | null;
  attended: number;
  total: number;
  rate: number | null;
  recent: string[];
};

export function Reports({ guild, toast }: { guild: Guild; toast: ToastFn }) {
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [notifs, setNotifs] = useState<NotifRow[]>([]);
  const [segUuid, setSegUuid] = useState('');
  const [notifUuid, setNotifUuid] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<ReportRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    const gid = encodeURIComponent(guild.id);
    Promise.all([api('/segments?guild_id=' + gid), api('/notifications?guild_id=' + gid)]).then(
      ([segs, ns]: [Segment[], NotifRow[]]) => {
        if (!alive) return;
        setSegments(segs);
        setNotifs(ns);
        if (segs.length > 0) setSegUuid((cur) => cur || segs[0].uuid);
      },
      (e) => {
        if (alive) {
          setSegments([]);
          toast(e instanceof Error ? e.message : String(e), true);
        }
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  useEffect(() => {
    if (!segUuid) return;
    let alive = true;
    setRows(null);
    const q = new URLSearchParams({ segment_uuid: segUuid });
    if (notifUuid) q.set('notification_uuid', notifUuid);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api('/reports/attendance?' + q.toString()).then(
      (r) => alive && setRows(r),
      (e) => {
        if (alive) {
          setRows([]);
          toast(e instanceof Error ? e.message : String(e), true);
        }
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segUuid, notifUuid, from, to]);

  if (segments === null) return <p className="muted">読み込み中…</p>;
  if (segments.length === 0) {
    return (
      <>
        <h2>出勤レポート</h2>
        <div className="empty">メンバー区分がまだありません。先に「メンバー区分」で区分を作成してください。</div>
      </>
    );
  }

  return (
    <>
      <h2>出勤レポート</h2>
      <p className="muted">
        区分の開催回（募集対象・中止除く）に対する「参加」回答を出勤として集計します。
        期間未指定は各メンバーの初出勤日〜現在で計算します。
      </p>
      <div className="row" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <label>区分</label>
          <select
            value={segUuid}
            onChange={(e) => {
              setSegUuid(e.target.value);
              setNotifUuid(''); // 区分が変わると通知の候補も変わるためリセット
            }}
            style={{ minWidth: 180 }}
          >
            {segments.map((s) => (
              <option key={s.uuid} value={s.uuid}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>通知</label>
          <select value={notifUuid} onChange={(e) => setNotifUuid(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">すべての通知</option>
            {notifs
              .filter((n) => n.segment_id === (segments.find((s) => s.uuid === segUuid)?.id ?? -1) && n.requires_response)
              .map((n) => (
                <option key={n.uuid} value={n.uuid}>
                  {n.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label>期間</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
            〜
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
          </div>
        </div>
        {(from || to) && (
          <button
            className="btn secondary"
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            全期間に戻す
          </button>
        )}
      </div>
      {rows === null ? (
        <p className="muted">読み込み中…</p>
      ) : rows.length === 0 ? (
        <div className="empty">この区分にアクティブなメンバーがいません。</div>
      ) : (
        <EventBotTable
          key={segUuid + '/' + notifUuid + '/' + from + '/' + to}
          options={{
            search: false,
            columns: [
              { id: 'member', header: 'メンバー', accessor: (r: ReportRow) => r.name || r.user_id },
              {
                id: 'rate',
                header: '出勤率',
                accessor: (r: ReportRow) => (r.rate === null ? '' : String(Math.round(r.rate * 100))),
                render: (v: string) => (v === '' ? '<span class="muted">—</span>' : esc(v) + '%'),
              },
              { id: 'count', header: '出勤回数', accessor: (r: ReportRow) => `${r.attended} / ${r.total}回` },
              ...[0, 1, 2].map((i) => ({
                id: 'recent' + i,
                header: ['前回出勤', '前々回出勤', '前々々回出勤'][i],
                accessor: (r: ReportRow) => r.recent[i] || '',
                render: (v: string) => (v ? esc(v) : '<span class="muted">—</span>'),
              })),
              {
                id: 'first',
                header: '初出勤',
                accessor: (r: ReportRow) => r.first_date || '',
                render: (v: string) => (v ? esc(v) : '<span class="muted">—</span>'),
              },
            ],
            rows,
          }}
        />
      )}
    </>
  );
}
