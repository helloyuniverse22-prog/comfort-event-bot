// メンバー区分（グループ分けの母集団定義）。新規/編集はオーバーレイモーダル、
// メンバー一覧は子ページ（ADR 0016・#g/<gid>/segments/<uuid>/members）。
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Select, TextField } from '../../../design-system/src';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import { FormDialog } from '../lib/FormDialog';
import type { ToastFn } from '../App';

type Segment = { uuid: string; name: string; mention_role_id?: string | null; members_synced_at?: string | null };
type Role = { id: string; name: string };

export function Segments({
  guild,
  toast,
  onOpenMembers,
}: {
  guild: Guild;
  toast: ToastFn;
  onOpenMembers: (segUuid: string) => void;
}) {
  const [segs, setSegs] = useState<Segment[] | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [editing, setEditing] = useState<Segment | null>(null); // null=閉じる, {}=新規, Segment=編集
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('');

  const load = async () => {
    try {
      setSegs(await api('/segments?guild_id=' + encodeURIComponent(guild.id)));
    } catch (e) {
      setSegs([]);
      toast(e instanceof Error ? e.message : String(e), true);
    }
    // 一覧のロール pill を名前で出すため取得（失敗時は ID フォールバック・ベストエフォート）
    if (!roles) {
      try {
        setRoles(await api(`/guilds/${guild.id}/roles`));
      } catch {}
    }
  };
  /** ロールIDを「@ロール名」で表示（未解決は生IDフォールバック） */
  const roleLabel = (id: string) =>
    id === '@everyone' ? '@everyone' : roles?.some((r) => r.id === id) ? '@' + roles.find((r) => r.id === id)!.name : id;
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  const openNew = async () => {
    setEditing({} as Segment);
    setName('');
    setRoleId('');
    setShowForm(true);
    if (!roles) {
      try {
        setRoles(await api(`/guilds/${guild.id}/roles`));
      } catch (e) {
        setRoles([]);
        toast('ロール一覧の取得に失敗しました: ' + (e instanceof Error ? e.message : String(e)), true);
      }
    }
  };
  const openEdit = async (s: Segment) => {
    setEditing(s);
    setName(s.name);
    setRoleId(s.mention_role_id || '');
    setShowForm(true);
    if (!roles) {
      try {
        setRoles(await api(`/guilds/${guild.id}/roles`));
      } catch (e) {
        setRoles([]);
        toast('ロール一覧の取得に失敗しました: ' + (e instanceof Error ? e.message : String(e)), true);
      }
    }
  };

  const save = async (btn: HTMLElement | null) => {
    if (!name.trim()) return toast('名前は必須です', true);
    await withBusy(btn, async () => {
      try {
        const mention_role_id = roleId || null;
        if (editing && (editing as Segment).uuid) {
          await api(`/segments/${(editing as Segment).uuid}`, { method: 'PUT', body: JSON.stringify({ name: name.trim(), mention_role_id }) });
          toast('更新しました');
        } else {
          await api('/segments', { method: 'POST', body: JSON.stringify({ guild_id: guild.id, name: name.trim(), mention_role_id }) });
          toast('作成しました');
        }
        setShowForm(false);
        await load();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  const remove = async (uuid: string) => {
    const ok = await confirmDialog(
      'この区分を削除します。所属メンバーの登録も解除されます（過去の回答記録は残ります）。元に戻せません。',
      { danger: true, okLabel: '削除する' },
    );
    if (!ok) return;
    try {
      await api('/segments/' + uuid, { method: 'DELETE' });
      toast('削除しました');
      await load();
    } catch (e) {
      // スケジュールの対象になっている区分はサーバー側が 409 で拒否する
      if ((e as { status?: number }).status === 409) {
        toast('この区分はスケジュールの対象になっているため削除できません。先にスケジュール設定を変更してください。', true);
        return;
      }
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };

  if (segs === null) return <p className="muted">読み込み中…</p>;

  const roleOptions = (
    <>
      <option value="">（手動管理）</option>
      <option value="@everyone">@everyone（サーバー全員）</option>
      {(roles || []).map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
      {roleId && roleId !== '@everyone' && roles && !roles.some((r) => r.id === roleId) && (
        <option value={roleId}>⚠ 不明なロール ({roleId})</option>
      )}
    </>
  );

  return (
    <>
      <div className="sec-head">
        <h2>メンバー区分 ({segs.length})</h2>
        <button className="btn" onClick={openNew}>
          ＋ 新規区分
        </button>
      </div>
      {segs.length === 0 ? (
        <div className="empty">
          メンバー区分がまだありません。
          <br />
          例: キャスト / スタッフ などを作成しましょう。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {segs.map((s) => (
            <div key={s.uuid} className="listrow">
              <div>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                  {s.mention_role_id ? (
                    <>
                      <span className="pill on">ロール管理</span> <span className="pill">{roleLabel(s.mention_role_id)}</span>
                    </>
                  ) : (
                    <span className="pill off">手動管理</span>
                  )}
                </div>
              </div>
              <div className="actions">
                <button className="btn sm secondary" onClick={() => onOpenMembers(s.uuid)}>
                  メンバー
                </button>
                <button className="btn sm ghost" onClick={() => openEdit(s)}>
                  編集
                </button>
                <button className="btn sm ghost danger" onClick={() => remove(s.uuid)}>
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <FormDialog
        open={showForm}
        title={editing && (editing as Segment).uuid ? '編集' : '新規区分'}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <button className="btn ghost" type="button" onClick={() => setShowForm(false)}>
              キャンセル
            </button>
            <button className="btn" onClick={(e) => save(e.currentTarget)}>
              保存
            </button>
          </>
        }
      >
        <div className="row">
          <div>
            <label>
              名前 <span className="req">✱</span>
            </label>
            <TextField placeholder="例: キャスト" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label>ロール / @everyone（任意）</label>
            <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roleOptions}
            </Select>
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
              設定するとメンバーをこのロールから自動同期し、メンション先になります。
            </p>
          </div>
        </div>
      </FormDialog>
    </>
  );
}
