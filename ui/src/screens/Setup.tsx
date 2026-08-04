import * as React from 'react';
import { useEffect, useState } from 'react';
import { api, type Guild } from '../api';
import { confirmDialog, withBusy } from '../lib/dialog';
import type { ToastFn } from '../App';

type SetupStatus = {
  secrets: Record<string, boolean>;
  interaction_endpoint_url: string;
};

const SECRET_ROWS: [string, string][] = [
  ['DISCORD_PUBLIC_KEY', '署名検証用の公開鍵（Discord → General Information）'],
  ['DISCORD_APPLICATION_ID', 'アプリID（Discord → General Information）'],
  ['DISCORD_BOT_TOKEN', 'Bot のトークン（Discord → Bot）'],
  ['ADMIN_TOKEN', 'この管理画面のパスワード（自分で決めた文字列）'],
];

export function Setup({ guild, toast, onLeft }: { guild: Guild; toast: ToastFn; onLeft: () => void }) {
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [registerResult, setRegisterResult] = useState('');

  const load = () =>
    api('/setup/status').then(setSt, (e) => toast(e instanceof Error ? e.message : String(e), true));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!st) return <p className="muted">読み込み中…</p>;

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(st.interaction_endpoint_url);
      toast('コピーしました');
    } catch {
      toast('コピーできませんでした。URL を手動で選択してください', true);
    }
  };

  const registerCommands = async (btn: HTMLElement | null) => {
    setRegisterResult('登録中…');
    await withBusy(btn, async () => {
      try {
        const r = await api('/setup/register-commands', { method: 'POST', body: JSON.stringify({ guild_id: guild.id }) });
        if (r && r.ok) {
          setRegisterResult(`✅ 登録しました: ${(r.names || []).map((n: string) => '/' + n).join(' ')}`);
          toast('コマンドを登録しました');
        } else {
          setRegisterResult('⚠️ ' + ((r && r.error) || '登録に失敗しました'));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setRegisterResult('⚠️ ' + msg);
        toast(msg, true);
      }
    });
  };

  const leave = async (btn: HTMLElement | null) => {
    const ok = await confirmDialog(
      `Bot を「${guild.name || guild.id}」から退出させます。\n\n` +
        'このサーバーのスケジュールはすべて停止し、サーバー一覧から消えます。\n' +
        'データ（区分・スケジュール設定・回答履歴）は残るため、再招待すれば元に戻せます。',
      { title: 'サーバーから退出', okLabel: '退出する', danger: true },
    );
    if (!ok) return;
    await withBusy(btn, async () => {
      try {
        const r = await api('/guilds/' + guild.id + '/leave', { method: 'POST' });
        toast(`退出しました（スケジュール ${r?.deactivated ?? 0} 件を停止）`);
        onLeft();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      }
    });
  };

  return (
    <>
      <h2>⚙️ Bot 設定</h2>
      <p className="muted">
        初期設定は 1〜4 を上から順に進めてください。設定後は Bot の参加状態をここで管理できます。
      </p>

      <fieldset>
        <legend>1. シークレットを確認</legend>
        <p className="muted" style={{ fontSize: 13 }}>
          Cloudflare の管理画面（Settings → Variables and Secrets）で設定します。未設定があると Bot は動きません。
        </p>
        {SECRET_ROWS.map(([key, label]) => {
          const ok = st.secrets[key];
          return (
            <div className="pickrow" key={key}>
              <div>
                <b>{key}</b>
                <br />
                <span className="muted" style={{ fontSize: 12 }}>
                  {label}
                </span>
              </div>
              <span className={'pill ' + (ok ? 'on' : 'off')}>{ok ? '設定済み' : '未設定'}</span>
            </div>
          );
        })}
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn sm secondary" onClick={load}>
            再読み込み
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>2. スラッシュコマンドを登録</legend>
        <p className="muted" style={{ fontSize: 13 }}>
          /notify /help /manage の 3 つを Discord に登録します（このサーバーへ即時反映）。
        </p>
        <div className="actions">
          <button className="btn" onClick={(e) => registerCommands(e.currentTarget)}>
            コマンドを登録
          </button>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          {registerResult}
        </div>
      </fieldset>

      <fieldset>
        <legend>3. Interactions Endpoint URL を設定</legend>
        <p className="muted" style={{ fontSize: 13 }}>
          下の URL をコピーし、Discord Developer Portal → General Information の「Interactions Endpoint URL」に貼り付けて保存してください。
        </p>
        <div className="pickrow">
          <code style={{ wordBreak: 'break-all' }}>{st.interaction_endpoint_url}</code>
          <button className="btn sm" onClick={copyEndpoint}>
            コピー
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          続けて Discord → Bot の <b>Server Members Intent</b> を ON にしてください（メンバー一覧の取得に必要）。
        </p>
      </fieldset>

      <fieldset>
        <legend>4. 区分とスケジュールを作成</legend>
        <p className="muted" style={{ fontSize: 13 }}>
          左メニューの「メンバー区分」で区分を作成してメンバーを登録し、「スケジュール設定」でスケジュールを作成すれば完了です。
        </p>
      </fieldset>

      <fieldset>
        <legend>このサーバーの管理をやめる</legend>
        <p className="muted" style={{ fontSize: 13 }}>
          Bot が <b>{guild.name || guild.id}</b> から退出し、サーバー一覧から消えます。
          退出前にこのサーバーのスケジュールをすべて停止するので、以降の募集・リマインドは送られません。
          <br />
          区分・スケジュール設定・回答履歴は<b>消えません</b>。もう一度 Bot を招待すればそのまま表示され、
          必要なスケジュールを「スケジュール設定」で再開できます。
        </p>
        <div className="actions">
          <button className="btn danger" onClick={(e) => leave(e.currentTarget)}>
            Bot をこのサーバーから退出させる
          </button>
        </div>
      </fieldset>
    </>
  );
}
