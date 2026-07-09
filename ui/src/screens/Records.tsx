import * as React from 'react';
import { useEffect, useState } from 'react';
import { api, type Guild } from '../api';
import { esc } from '../lib/esc';
import { EventBotTable } from '../lib/EventBotTable';
import type { ToastFn } from '../App';

type ResponseRow = {
  occurrence_date?: string;
  occurrence_time?: string;
  notification_name?: string;
  user_name?: string;
  user_id?: string;
  status?: string;
  post_deadline_change?: boolean;
  updated_at?: string;
};

export function Records({ guild, toast }: { guild: Guild; toast: ToastFn }) {
  const [rows, setRows] = useState<ResponseRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    api('/responses?limit=200&guild_id=' + encodeURIComponent(guild.id)).then(
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
      <h2>回答履歴</h2>
      <p className="muted">
        直近 {rows.length} 件（このサーバー: {guild.name || guild.id}）。列ヘッダのクリックでソート、各列下で絞り込み、ヘッダのドラッグで並べ替え。
      </p>
      {rows.length === 0 ? (
        <div className="empty">まだ回答がありません。募集を投稿し、メンバーがボタンで回答すると、ここに表示されます。</div>
      ) : (
        <EventBotTable
          options={{
            search: false,
            columns: [
              { id: 'when', header: '開催日時', accessor: (r: ResponseRow) => `${r.occurrence_date || ''}${r.occurrence_time ? ' ' + r.occurrence_time : ''}` },
              { id: 'notif', header: '通知', accessor: (r: ResponseRow) => r.notification_name || '' },
              { id: 'member', header: 'メンバー', accessor: (r: ResponseRow) => r.user_name || r.user_id },
              { id: 'status', header: '回答', accessor: (r: ResponseRow) => r.status || '' },
              {
                id: 'deadline',
                header: '締切後変更',
                accessor: (r: ResponseRow) => (r.post_deadline_change ? 'あり' : 'なし'),
                render: (v: string) => (v === 'あり' ? '<span class="pill" style="color:var(--warn);border-color:var(--warn)">締切後変更</span>' : '<span class="muted">—</span>'),
              },
              {
                id: 'updated',
                header: '更新',
                accessor: (r: ResponseRow) => (r.updated_at || '').slice(0, 19),
                render: (v: string) => `<span class="muted">${esc(v)}</span>`,
              },
            ],
            rows,
          }}
        />
      )}
    </>
  );
}
