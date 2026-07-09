// 「通知」タブ: 全通知の開催回を横断表示する運用入口（メンバー配置への導線＋配信予定の中止/再開）。
// 未来の予定は RRULE から仮想導出し、「配信しない」を押した回だけ cancelled で実体化する（墓石方式）。
import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Guild } from '../api';
import { confirmDialog } from '../lib/dialog';
import { FormDialog } from '../lib/FormDialog';
import type { ToastFn } from '../App';

type Notification = { uuid: string; name: string; duration_minutes: number | null; start_time?: string };
type Occurrence = { uuid: string; occurrence_date: string; start_time?: string | null; status?: string };
type Item = { n: Notification; o: Occurrence; virtual: boolean };

/** 表示用ステータス。中止=cancelled、終了=終了時刻が過去、開催中=開始〜終了の間、予定=開始前（保存は cancelled のみ・導出）。 */
type Derived = '予定' | '開催中' | '終了' | '中止';

const JADOW = ['日', '月', '火', '水', '木', '金', '土'];
function jaDow(dateStr: string): string {
  const [y, m, d] = (dateStr || '').split('/').map(Number);
  return y && m && d ? JADOW[new Date(y, m - 1, d).getDay()] : '';
}
function addMinsToTime(time: string, minutes: number): { time: string; nextDay: boolean } {
  const [h, m] = (time || '0:0').split(':').map(Number);
  const total = (h || 0) * 60 + (m || 0) + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return { time: `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`, nextDay: total >= 1440 || total < 0 };
}
function fmtTimeRange(start: string, dur?: number | null): string {
  if (!dur || dur <= 0) return `${start}〜`;
  const e = addMinsToTime(start, dur);
  return `${start}〜${e.nextDay ? '翌' : ''}${e.time}`;
}
function occLabel(o: Occurrence, dur?: number | null): string {
  const w = jaDow(o.occurrence_date);
  return `${o.occurrence_date}${w ? ` (${w})` : ''}${o.start_time ? ' ' + fmtTimeRange(o.start_time, dur) : ''}`;
}
function deriveStatus(o: Occurrence, dur: number | null | undefined, now: Date): Derived {
  if (o.status === 'cancelled') return '中止';
  const [y, m, d] = (o.occurrence_date || '').split('/').map(Number);
  const [h, mi] = (o.start_time || '23:59').split(':').map(Number);
  const start = new Date(y || 0, (m || 1) - 1, d || 1, h || 0, mi || 0);
  if (now.getTime() < start.getTime()) return '予定';
  const end = start.getTime() + (dur && dur > 0 ? dur : 0) * 60000;
  return now.getTime() < end ? '開催中' : '終了';
}
const itemKey = (it: Item) => it.o.uuid || `${it.n.uuid}|${it.o.occurrence_date}|${it.o.start_time || ''}`;
/** 開催日時の昇順（直近の回が先頭）。 */
const byDateAsc = (a: Item, b: Item) =>
  (a.o.occurrence_date + (a.o.start_time || '')).localeCompare(b.o.occurrence_date + (b.o.start_time || ''));

const STATUS_PILL: Record<Derived, string> = { 予定: 'pill accent', 開催中: 'pill on', 終了: 'pill', 中止: 'pill danger' };

/** 未来予定（仮想行）を通知ごとに何回先まで表示するか。表示だけの好みなので localStorage 保存。 */
const PLAN_COUNT_KEY = 'eventbot_plan_count';
const PLAN_COUNT_CHOICES = [1, 2, 4, 8] as const;
function loadPlanCount(): number {
  const v = Number(localStorage.getItem(PLAN_COUNT_KEY));
  return (PLAN_COUNT_CHOICES as readonly number[]).includes(v) ? v : 1;
}

/** ステータスフィルタも localStorage 保存（既知キーだけ取り込み・壊れた値は既定に戻す）。 */
const STATUS_FILTER_KEY = 'eventbot_status_filter';
const DEFAULT_STATUS_FILTER: Record<Derived, boolean> = { 予定: true, 開催中: true, 終了: false, 中止: false };
function loadStatusFilter(): Record<Derived, boolean> {
  const out = { ...DEFAULT_STATUS_FILTER };
  try {
    const saved = JSON.parse(localStorage.getItem(STATUS_FILTER_KEY) || '{}');
    for (const k of Object.keys(out) as Derived[]) if (typeof saved[k] === 'boolean') out[k] = saved[k];
  } catch {}
  return out;
}

/** 通知絞り込みの保存キー（通知は guild ごとなので guild.id を付ける）。 */
const NOTIF_FILTER_KEY = 'eventbot_notif_filter.';

export function NotifOps({ guild, toast, onOpenGrouping }: { guild: Guild; toast: ToastFn; onOpenGrouping: (nuuid: string, ouuid: string) => void }) {
  const [notifs, setNotifs] = useState<Notification[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState(() => localStorage.getItem(NOTIF_FILTER_KEY + guild.id) || '');
  const [statusFilter, setStatusFilter] = useState<Record<Derived, boolean>>(loadStatusFilter);
  const [planCount, setPlanCount] = useState(loadPlanCount);
  const [tallies, setTallies] = useState<Record<string, string>>({});
  // ＋臨時回ダイアログ（既存の通知設定に単発の開催回をぶら下げる。区分・制約・配置設定を引き継ぐ）
  const [adhocOpen, setAdhocOpen] = useState(false);
  const [adhocNotif, setAdhocNotif] = useState('');
  const [adhocDate, setAdhocDate] = useState('');
  const [adhocTime, setAdhocTime] = useState('');
  const [adhocNote, setAdhocNote] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const n: Notification[] = await api('/notifications?guild_id=' + encodeURIComponent(guild.id));
        if (!alive) return;
        setNotifs(n);
        // 保存されていた絞り込み通知が削除済みなら「すべての通知」へ戻す
        setFilter((cur) => (cur && !n.some((x) => x.uuid === cur) ? '' : cur));
        if (!n.length) return;
        const lists = await Promise.all(
          n.map(async (notif) => {
            const [occs, plan] = await Promise.all([
              api(`/notifications/${notif.uuid}/occurrences`).catch(() => []),
              api(`/notifications/${notif.uuid}/plan?count=${planCount}`).catch(() => []),
            ]);
            return [
              ...occs.map((o: Occurrence) => ({ n: notif, o, virtual: false })),
              ...plan.map((o: Occurrence) => ({ n: notif, o: { ...o, uuid: '', status: 'scheduled' }, virtual: true })),
            ] as Item[];
          }),
        );
        if (!alive) return;
        const all = lists.flat().sort(byDateAsc);
        setItems(all);
        for (const { o, virtual } of all) {
          if (virtual) continue;
          api(`/occurrences/${o.uuid}/status`).then(
            (s) => alive && setTallies((t) => ({ ...t, [o.uuid]: `参加 ${s.参加.length}・不参加 ${s.不参加.length}・未定 ${s.未定.length}・未回答 ${s.未回答.length}` })),
            () => alive && setTallies((t) => ({ ...t, [o.uuid]: '集計を取得できません' })),
          );
        }
      } catch (e) {
        if (alive) {
          setNotifs([]);
          toast(e instanceof Error ? e.message : String(e), true);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id, planCount]);

  /** 配信しない（仮想行は cancelled で実体化＝墓石、実体行は status 変更） */
  async function suppress(it: Item) {
    const label = occLabel(it.o, it.n.duration_minutes);
    const ok = await confirmDialog(
      `${label}（${it.n.name}）を中止しますか？\n\nこの回の募集・リマインドなどの自動送信が止まり、回答ボタンも無効になります。`,
      { title: 'この回を中止する', okLabel: '中止する', danger: true },
    );
    if (!ok) return;
    try {
      if (it.virtual) {
        const created: Occurrence = await api(`/notifications/${it.n.uuid}/occurrences`, {
          method: 'POST',
          body: JSON.stringify({ date: it.o.occurrence_date, start_time: it.o.start_time || '', status: 'cancelled' }),
        });
        setItems((cur) => cur.map((x) => (x === it ? { ...x, o: created, virtual: false } : x)));
        setTallies((t) => ({ ...t, [created.uuid]: '回答なし' }));
      } else {
        await api(`/occurrences/${it.o.uuid}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
        setItems((cur) => cur.map((x) => (x === it ? { ...x, o: { ...x.o, status: 'cancelled' } } : x)));
      }
      toast('この回を中止しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** 臨時回を追加（scheduled で実体化。cron が窓内で募集・リマインドを自動送信する） */
  async function addAdhoc() {
    const n = notifs?.find((x) => x.uuid === adhocNotif);
    if (!n || !adhocDate) {
      toast('通知と日付を指定してください', true);
      return;
    }
    const date = adhocDate.replace(/-/g, '/');
    const t = new Date();
    const todayStr = `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}`;
    if (date < todayStr) {
      toast('過去の日付には作成できません', true);
      return;
    }
    try {
      const created: Occurrence = await api(`/notifications/${n.uuid}/occurrences`, {
        method: 'POST',
        body: JSON.stringify({
          date,
          start_time: adhocTime || n.start_time || '',
          status: 'scheduled',
          note: adhocNote.trim(),
        }),
      });
      setItems((cur) =>
        [...cur.filter((x) => !(x.virtual && x.n.uuid === n.uuid && x.o.occurrence_date === date)), { n, o: created, virtual: false }].sort(byDateAsc),
      );
      setTallies((t) => ({ ...t, [created.uuid]: '回答なし' }));
      setAdhocOpen(false);
      toast(`${date} の臨時回を追加しました`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** 単一開催回の即時募集（臨時回向け。送信済み=409 は確認のうえ force 再送できる） */
  async function recruitOne(it: Item) {
    const ok = await confirmDialog(
      `${occLabel(it.o, it.n.duration_minutes)}（${it.n.name}）の募集メッセージを今すぐチャンネルへ投稿しますか？`,
      { title: '今すぐ募集', okLabel: '投稿する' },
    );
    if (!ok) return;
    try {
      await api(`/occurrences/${it.o.uuid}/recruit`, { method: 'POST' });
      toast('募集メッセージを投稿しました');
    } catch (e) {
      // 送信済み（409）: Discord 上で投稿を削除したケースを想定し、確認のうえ再送する
      if ((e as { status?: number }).status === 409) {
        const again = await confirmDialog(
          'この回の募集は既に送信済みです。Discord 上の投稿を削除した場合など、もう一度投稿してよい場合のみ再送してください（元の投稿が残っていると募集が2つ並びます）。',
          { title: '募集を再送', okLabel: '再送する', danger: true },
        );
        if (!again) return;
        try {
          await api(`/occurrences/${it.o.uuid}/recruit`, { method: 'POST', body: JSON.stringify({ force: true }) });
          toast('募集メッセージを再送しました');
        } catch (e2) {
          toast(e2 instanceof Error ? e2.message : String(e2), true);
        }
        return;
      }
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** 配信する（中止の取り消し） */
  async function resume(it: Item) {
    try {
      await api(`/occurrences/${it.o.uuid}`, { method: 'PUT', body: JSON.stringify({ status: 'scheduled' }) });
      setItems((cur) => cur.map((x) => (x === it ? { ...x, o: { ...x.o, status: 'scheduled' } } : x)));
      toast('この回を再開しました');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  const now = new Date();
  const shown = useMemo(
    () =>
      items
        .filter((x) => (filter ? x.n.uuid === filter : true))
        .filter((x) => statusFilter[deriveStatus(x.o, x.n.duration_minutes, now)]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, filter, statusFilter],
  );

  if (notifs === null) return <p className="muted">読み込み中…</p>;

  if (notifs.length === 0) {
    return (
      <>
        <div className="sec-head">
          <h2>通知</h2>
        </div>
        <div className="empty">
          まだ通知がありません。
          <br />
          「通知設定」から最初の通知を作成しましょう。
        </div>
      </>
    );
  }

  return (
    <>
      <div className="sec-head">
        <h2>通知</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              localStorage.setItem(NOTIF_FILTER_KEY + guild.id, e.target.value);
            }}
            style={{ maxWidth: 280 }}
            aria-label="通知の種類で絞り込み"
          >
            <option value="">すべての通知</option>
            {notifs.map((n) => (
              <option key={n.uuid} value={n.uuid}>
                {n.name}
              </option>
            ))}
          </select>
          <button
            className="btn sm"
            onClick={() => {
              const first = notifs[0];
              setAdhocNotif(filter || first.uuid);
              const base = notifs.find((x) => x.uuid === (filter || first.uuid));
              setAdhocTime(base?.start_time || '');
              setAdhocDate('');
              setAdhocNote('');
              setAdhocOpen(true);
            }}
          >
            ＋ 臨時回を追加
          </button>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        {(['予定', '開催中', '終了', '中止'] as Derived[]).map((s) => (
          <label key={s} className="inline">
            <input
              type="checkbox"
              checked={statusFilter[s]}
              onChange={(e) => {
                const next = { ...statusFilter, [s]: e.target.checked };
                setStatusFilter(next);
                localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify(next));
              }}
            />
            {s}
          </label>
        ))}
        <label className="inline" style={{ marginLeft: 12 }}>
          予定の表示
          <select
            value={planCount}
            onChange={(e) => {
              const v = Number(e.target.value);
              localStorage.setItem(PLAN_COUNT_KEY, String(v));
              setPlanCount(v);
            }}
            style={{ width: 'auto' }}
            aria-label="未来の予定をいくつ表示するか"
          >
            {PLAN_COUNT_CHOICES.map((c) => (
              <option key={c} value={c}>
                {c === 1 ? '次の1回' : `${c}回先まで`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="empty">
          この条件に当てはまる開催回がありません。
          <br />
          上のステータスや通知の絞り込みを変更してみてください。
        </div>
      ) : (
        shown.map((it) => {
          const { n, o, virtual } = it;
          const st = deriveStatus(o, n.duration_minutes, now);
          return (
            <div className="pickrow" key={itemKey(it)}>
              <div>
                {occLabel(o, n.duration_minutes)} <span className={STATUS_PILL[st]}>{st}</span>{' '}
                <span className="muted" style={{ fontSize: 12 }}>{n.name}</span>
                {st !== '中止' && (
                  <>
                    <br />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {virtual ? '配信予定（まだ募集していません）' : tallies[o.uuid] || '集計中…'}
                    </span>
                  </>
                )}
              </div>
              <div className="actions">
                {st === '中止' && !virtual && (
                  <button className="btn sm secondary" onClick={() => resume(it)}>
                    ▶ 再開する
                  </button>
                )}
                {st === '予定' && !virtual && (
                  <button className="btn sm secondary" onClick={() => recruitOne(it)}>
                    📣 今すぐ募集
                  </button>
                )}
                {st === '予定' && (
                  <button className="btn sm secondary" onClick={() => suppress(it)}>
                    🚫 中止する
                  </button>
                )}
                {!virtual && (
                  <button className="btn sm secondary" onClick={() => onOpenGrouping(n.uuid, o.uuid)}>
                    {st === '予定' || st === '開催中' ? 'メンバー配置' : '配置を見る'}
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
      <FormDialog
        open={adhocOpen}
        title="臨時回を追加"
        onClose={() => setAdhocOpen(false)}
        footer={
          <>
            <button className="btn secondary" onClick={() => setAdhocOpen(false)}>
              キャンセル
            </button>
            <button className="btn" onClick={addAdhoc}>
              追加する
            </button>
          </>
        }
      >
        <p className="muted" style={{ marginTop: 0 }}>
          既存の通知に単発の開催回を追加します。区分・ペア制約・配置設定はその通知のものを引き継ぎ、
          募集・リマインドは通常の回と同じタイミングで自動送信されます（すぐ告知したい場合は追加後に「📣 今すぐ募集」）。
        </p>
        <label>
          対象の通知
          <select
            value={adhocNotif}
            onChange={(e) => {
              setAdhocNotif(e.target.value);
              const base = notifs.find((x) => x.uuid === e.target.value);
              if (base?.start_time) setAdhocTime(base.start_time);
            }}
          >
            {notifs.map((n) => (
              <option key={n.uuid} value={n.uuid}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          日付
          <input type="date" value={adhocDate} onChange={(e) => setAdhocDate(e.target.value)} />
        </label>
        <label>
          開始時刻
          <input type="time" value={adhocTime} onChange={(e) => setAdhocTime(e.target.value)} />
        </label>
        <label>
          補足メッセージ（任意・募集メッセージに掲載）
          <textarea
            value={adhocNote}
            onChange={(e) => setAdhocNote(e.target.value)}
            placeholder={'例: 〇〇さんとのコラボ回です！\n例: 〇〇の事前の練習会です！'}
            rows={3}
            maxLength={500}
          />
        </label>
      </FormDialog>
    </>
  );
}
