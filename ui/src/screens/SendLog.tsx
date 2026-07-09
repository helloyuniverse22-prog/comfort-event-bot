import * as React from 'react';
import { useEffect, useState } from 'react';
import { api, type Guild } from '../api';
import { esc } from '../lib/esc';
import { EventBotTable } from '../lib/EventBotTable';
import type { ToastFn } from '../App';

type LogRow = {
  send_date?: string;
  notification_name?: string;
  occurrence_date?: string;
  kind?: string;
  user_id?: string;
  user_name?: string;
  status?: string;
  error?: string;
};

const KIND_LABEL: Record<string, string> = {
  recruit: '募集',
  remind_unanswered: '未回答リマインド',
  remind_undecided: '未定リマインド',
  quota: 'ノルマ',
  deadline_notice: '締切告知',
};

export function SendLog({ guild, toast }: { guild: Guild; toast: ToastFn }) {
  const [rows, setRows] = useState<LogRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    api('/send-log?limit=300&guild_id=' + encodeURIComponent(guild.id)).then(
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
  }, [guild.id]);

  if (rows === null) return <p className="muted">読み込み中…</p>;

  return (
    <>
      <h2>リマインド送信履歴</h2>
      <p className="muted">
        cron が送った募集・リマインド・ノルマ・締切告知の記録（直近 {rows.length} 件・このサーバー: {guild.name || guild.id}）。DM
        拒否などの失敗もここで確認できます。
      </p>
      {rows.length === 0 ? (
        <div className="empty">まだ送信記録がありません。送信時刻になると cron が送信し、ここに記録されます。</div>
      ) : (
        <EventBotTable
          options={{
            search: false,
            columns: [
              { id: 'date', header: '送信日', accessor: (r: LogRow) => r.send_date || '' },
              { id: 'notif', header: '通知', accessor: (r: LogRow) => r.notification_name || '' },
              { id: 'occ', header: '開催日', accessor: (r: LogRow) => r.occurrence_date || '' },
              { id: 'kind', header: '種別', accessor: (r: LogRow) => KIND_LABEL[r.kind || ''] || r.kind },
              {
                id: 'to',
                header: '宛先',
                accessor: (r: LogRow) => r.user_name || r.user_id || '（チャンネル）',
                render: (_v: string, r: LogRow) =>
                  !r.user_id
                    ? '<span class="muted">（チャンネル）</span>'
                    : r.user_name
                      ? `${esc(r.user_name)} <span class="muted" style="font-size:11px">${esc(r.user_id)}</span>`
                      : esc(r.user_id),
              },
              {
                id: 'status',
                header: '結果',
                accessor: (r: LogRow) => r.status,
                render: (v: string) =>
                  v === 'sent'
                    ? '<span class="pill on">送信</span>'
                    : v === 'failed'
                      ? '<span class="pill" style="color:var(--danger);border-color:var(--danger)">失敗</span>'
                      : `<span class="pill">${esc(v)}</span>`,
              },
              { id: 'error', header: '詳細', accessor: (r: LogRow) => r.error || '', render: (v: string) => (v ? `<span class="muted">${esc(v)}</span>` : '') },
            ],
            rows,
          }}
        />
      )}
    </>
  );
}
