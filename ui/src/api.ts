// 管理UI SPA — /api/admin クライアント。ui/index.html（旧 vanilla）の api() と同一契約。
export const TOKEN_KEY = 'eventbot_admin_token';
export const GUILD_KEY = 'eventbot_guild';

export type Guild = { id: string; name: string; icon?: string | null };

export class AuthError extends Error {}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function saveToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api(path: string, opts: RequestInit = {}): Promise<any> {
  // 検証用シーム: Playwright/preview が window.api を差し替えたらそちらを使う
  // （staging ADMIN_TOKEN がローカルに無いため、認証後画面はスタブで描画検証する運用）
  const stub = (window as any).api;
  if (typeof stub === 'function' && stub !== api) return stub(path, opts);

  const res = await fetch('/api/admin' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + getToken(),
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
  if (res.status === 401) throw new AuthError('認証に失敗しました');
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const b = await res.json();
      if (b && b.error) detail = res.status + ' ' + b.error;
    } catch {}
    const err = new Error('エラー: ' + detail) as Error & { status?: number };
    err.status = res.status; // 呼び出し側でステータス分岐できるように（409=送信済み等）
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export function guildIconUrl(g: Guild | null | undefined): string | null {
  return g && g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96` : null;
}

// サーバー一覧はセッション中キャッシュ（旧 cacheGuilds と同じ挙動）
let cacheGuilds: Guild[] | null = null;
export async function fetchGuilds(): Promise<Guild[]> {
  if (cacheGuilds) return cacheGuilds;
  cacheGuilds = await api('/guilds');
  return cacheGuilds!;
}
export function invalidateGuilds() {
  cacheGuilds = null;
}
