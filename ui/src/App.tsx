// 管理UI SPA ルート。Gate → Picker → Workspace の遷移は旧 ui/index.html と同一契約
// （TOKEN_KEY / GUILD_KEY / ハッシュ #g/<gid>/... = ADR 0016）。
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Actions,
  Main,
  NavItem,
  ServerBadge,
  ServerRail,
  ServerRailItem,
  Shell,
  SideNav,
  Topbar,
} from '../../design-system/src';
import {
  AuthError,
  GUILD_KEY,
  clearToken,
  fetchGuilds,
  getToken,
  guildIconUrl,
  invalidateGuilds,
  saveToken,
  type Guild,
} from './api';
import { ConfirmHost, confirmDialog } from './lib/dialog';
import { parseHash, routeFromRest, sectionForRoute, type Route } from './lib/route';
import { NotificationsScreen } from './screens/Notifications';
import { NotifOps } from './screens/NotifOps';
import { NotificationForm } from './screens/NotificationForm';
import { GroupingDialog } from './screens/GroupingDialog';
import { GroupingSettings } from './screens/GroupingSettings';
import { Segments } from './screens/Segments';
import { SegmentMembers } from './screens/SegmentMembers';
import { Records } from './screens/Records';
import { Reports } from './screens/Reports';
import { SendLog } from './screens/SendLog';
import { Setup } from './screens/Setup';

type SecKey = 'notif-ops' | 'notifications' | 'segments' | 'records' | 'reports' | 'sendlog' | 'setup';

const NAV: { key: SecKey; label: string }[] = [
  { key: 'notif-ops', label: '🔔 通知' },
  { key: 'notifications', label: '🛠 通知設定' },
  { key: 'segments', label: '👥 メンバー区分' },
  { key: 'records', label: '🗒 回答履歴' },
  { key: 'reports', label: '📊 出勤レポート' },
  { key: 'sendlog', label: '📤 送信履歴' },
  { key: 'setup', label: '⚙️ Bot 設定' },
];

/** 旧 boot() と同じ復元規則: 保存 guild があり、ハッシュが無いか一致すれば workspace 直行 */
function restoreGuild(): Guild | null {
  const saved = localStorage.getItem(GUILD_KEY);
  if (!saved) return null;
  try {
    const g = JSON.parse(saved) as Guild;
    const { guildId } = parseHash();
    if (!guildId || guildId === g.id) return g;
  } catch {}
  return null;
}

export type ToastFn = (msg: string, err?: boolean) => void;

export function App() {
  const [token, setToken] = useState(getToken());
  const [guild, setGuild] = useState<Guild | null>(() => (getToken() ? restoreGuild() : null));
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null);

  const showToast: ToastFn = useCallback((msg, err = false) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast((t) => (t && t.msg === msg ? null : t)), 2800);
  }, []);

  const onApiError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) setToken('');
      showToast(e instanceof Error ? e.message : String(e), true);
    },
    [showToast],
  );

  const login = (t: string) => {
    const v = t.trim();
    saveToken(v);
    setToken(v);
  };
  const logout = () => {
    clearToken();
    invalidateGuilds();
    setToken('');
    setGuild(null);
  };
  const selectGuild = (g: Guild) => {
    localStorage.setItem(GUILD_KEY, JSON.stringify(g));
    setGuild(g);
    location.hash = 'g/' + g.id; // サーバー切替時は子ページパスをリセット（ADR 0016）
  };
  // 退出後はそのサーバーを開けない。選択を解除してサーバー選択へ戻す（一覧も再取得）。
  const leftGuild = () => {
    localStorage.removeItem(GUILD_KEY);
    invalidateGuilds();
    setGuild(null);
    location.hash = '';
  };

  return (
    <>
      {!token ? (
        <Gate onLogin={login} />
      ) : !guild ? (
        <Picker onSelect={selectGuild} onLogout={logout} onError={onApiError} />
      ) : (
        <Workspace guild={guild} onSelectGuild={selectGuild} onLogout={logout} onLeftGuild={leftGuild} onError={onApiError} toast={showToast} />
      )}
      <div className={'toast' + (toast ? ' show' : '') + (toast?.err ? ' err' : '')}>{toast?.msg}</div>
      <ConfirmHost />
    </>
  );
}

function Gate({ onLogin }: { onLogin: (t: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div style={{ maxWidth: 420, margin: '80px auto' }}>
      <div className="card" style={{ cursor: 'default' }}>
        <h1>管理トークン</h1>
        <p className="muted">ADMIN_TOKEN を入力してください。</p>
        <input
          type="password"
          placeholder="ADMIN_TOKEN"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onLogin(v)}
        />
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => onLogin(v)}>ログイン</button>
        </div>
      </div>
    </div>
  );
}

function Picker({
  onSelect,
  onLogout,
  onError,
}: {
  onSelect: (g: Guild) => void;
  onLogout: () => void;
  onError: (e: unknown) => void;
}) {
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  useEffect(() => {
    fetchGuilds().then(setGuilds, (e) => {
      setGuilds([]);
      onError(e);
    });
  }, [onError]);
  return (
    <div>
      <Topbar>
        <h1 style={{ margin: 0 }}>🗓 EventBot 管理</h1>
        <button className="btn secondary" onClick={onLogout}>ログアウト</button>
      </Topbar>
      <main style={{ maxWidth: 760, margin: '0 auto' }}>
        <h2>管理するサーバーを選択</h2>
        <p className="muted">Bot が参加しているサーバーから選びます（Discord から自動取得）。</p>
        <div className="grid-cards">
          {guilds === null ? (
            <p className="muted">読み込み中…</p>
          ) : guilds.length === 0 ? (
            <p className="muted">参加サーバーが取得できませんでした。bot トークン / 権限を確認してください。</p>
          ) : (
            guilds.map((g) => (
              <div key={g.id} className="card" onClick={() => onSelect(g)}>
                <ServerBadge
                  name={<div style={{ fontWeight: 600 }}>{g.name}</div>}
                  subtitle={'ID: ' + g.id}
                  fallback={<GuildIcon g={g} />}
                />
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
}

function GuildIcon({ g }: { g: Guild }) {
  const u = guildIconUrl(g);
  return u ? <img src={u} alt="" loading="lazy" /> : <>{(g.name || '?').slice(0, 1)}</>;
}

function Workspace({
  guild,
  onSelectGuild,
  onLogout,
  onLeftGuild,
  onError,
  toast,
}: {
  guild: Guild;
  onSelectGuild: (g: Guild) => void;
  onLogout: () => void;
  onLeftGuild: () => void;
  onError: (e: unknown) => void;
  toast: ToastFn;
}) {
  const [sec, setSec] = useState<SecKey>('notif-ops');
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [rest, setRest] = useState<string[]>(() => parseHash().rest);
  const [dirty, setDirty] = useState(false);
  const [listKey, setListKey] = useState(0); // 一覧の再フェッチトリガ（子ページからの戻り時）

  useEffect(() => {
    fetchGuilds().then(setGuilds, () => {}); // rail はベストエフォート（旧実装踏襲）
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash();
      if (parsed.guildId === guild.id) setRest(parsed.rest);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [guild.id]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const route: Route = routeFromRest(rest);

  // ルート種別に応じてサイドナビのアクティブ表示を同期（旧 handleHashRoute の switchSection 呼び出し相当）
  useEffect(() => {
    const wantSec = sectionForRoute(route.kind);
    if (wantSec) setSec(wantSec as SecKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.kind]);

  const navigate = useCallback(
    (subpath: string) => {
      const base = 'g/' + guild.id;
      const next = '#' + (subpath ? base + '/' + subpath : base);
      if (location.hash === next) setRest(subpath ? subpath.split('/').filter(Boolean) : []);
      else location.hash = next;
    },
    [guild.id],
  );

  const selectSection = async (s: SecKey) => {
    if (dirty) {
      const ok = await confirmDialog('未保存の変更があります。移動してもよろしいですか？', { okLabel: '移動する', danger: true });
      if (!ok) return;
    }
    setDirty(false);
    setSec(s);
    navigate('');
  };

  const backToList = () => {
    setListKey((k) => k + 1);
    navigate('');
  };

  const renderChildPage = (): React.ReactNode => {
    switch (route.kind) {
      case 'notif-new':
        return (
          <NotificationForm key="new" guild={guild} toast={toast} onDirtyChange={setDirty} onClose={backToList} onSaved={backToList} />
        );
      case 'notif-edit':
        return (
          <NotificationForm
            key={route.nuuid}
            guild={guild}
            nuuid={route.nuuid}
            toast={toast}
            onDirtyChange={setDirty}
            onClose={backToList}
            onSaved={backToList}
          />
        );
      case 'grouping-settings':
        return <GroupingSettings key={route.nuuid} guild={guild} nuuid={route.nuuid} toast={toast} onClose={backToList} />;
      case 'grouping':
        return (
          <GroupingDialog
            key={route.nuuid + '/' + route.ouuid}
            guild={guild}
            nuuid={route.nuuid}
            ouuid={route.ouuid}
            toast={toast}
            onDirtyChange={setDirty}
            onClose={backToList}
            onNavigateConstraints={() => navigate('notifications/' + route.nuuid + '/grouping-settings')}
          />
        );
      case 'seg-members':
        return <SegmentMembers key={route.suuid} guild={guild} segUuid={route.suuid} toast={toast} onClose={backToList} />;
      default:
        return null;
    }
  };

  const childPage = renderChildPage();

  return (
    <div className="ws-layout">
      <ServerRail aria-label="サーバー一覧">
        {guilds.map((g) => (
          <ServerRailItem
            key={g.id}
            active={g.id === guild.id}
            label={g.name}
            src={guildIconUrl(g) || undefined}
            onClick={() => g.id !== guild.id && onSelectGuild(g)}
          >
            {(g.name || '?').slice(0, 1)}
          </ServerRailItem>
        ))}
      </ServerRail>
      <div className="ws-body">
        <Topbar>
          <ServerBadge
            name={<div style={{ fontWeight: 600 }}>{guild.name}</div>}
            subtitle="サーバー"
            fallback={<GuildIcon g={guilds.find((g) => g.id === guild.id) || guild} />}
          />
          <Actions>
            <button className="btn secondary" onClick={onLogout}>ログアウト</button>
          </Actions>
        </Topbar>
        <Shell>
          <SideNav>
            {NAV.map((n) => (
              <NavItem key={n.key} active={sec === n.key} onClick={() => selectSection(n.key)} style={{ cursor: 'pointer' }}>
                {n.label}
              </NavItem>
            ))}
          </SideNav>
          <Main>
            {childPage ? (
              childPage
            ) : sec === 'notif-ops' ? (
              <NotifOps key={listKey} guild={guild} toast={toast} onOpenGrouping={(n, o) => navigate(`notifications/${n}/occurrences/${o}/grouping`)} />
            ) : sec === 'notifications' ? (
              <NotificationsScreen
                key={listKey}
                guild={guild}
                toast={toast}
                onError={onError}
                onNew={() => navigate('notifications/new')}
                onEdit={(uuid) => navigate(`notifications/${uuid}/edit`)}
                onGroupingSettings={(uuid) => navigate(`notifications/${uuid}/grouping-settings`)}
              />
            ) : sec === 'segments' ? (
              <Segments key={listKey} guild={guild} toast={toast} onOpenMembers={(uuid) => navigate(`segments/${uuid}/members`)} />
            ) : sec === 'records' ? (
              <Records guild={guild} toast={toast} />
            ) : sec === 'reports' ? (
              <Reports guild={guild} toast={toast} />
            ) : sec === 'sendlog' ? (
              <SendLog guild={guild} toast={toast} />
            ) : (
              <Setup guild={guild} toast={toast} onLeft={onLeftGuild} />
            )}
          </Main>
        </Shell>
      </div>
    </div>
  );
}
