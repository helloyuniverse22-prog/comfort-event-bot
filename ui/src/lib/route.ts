// ハッシュルータ（ADR 0016 準拠）。URL 形式: #g/<guildId>/<resource>/<uuid?>/<sub?>
// 旧 vanilla 実装の parseHash()/handleHashRoute() の want 判定を純関数として移植。
export type Route =
  | { kind: 'list' }
  | { kind: 'notif-new' }
  | { kind: 'notif-edit'; nuuid: string }
  | { kind: 'grouping-settings'; nuuid: string }
  | { kind: 'grouping'; nuuid: string; ouuid: string }
  | { kind: 'seg-members'; suuid: string };

export function parseHash(): { guildId: string | null; rest: string[] } {
  const raw = (location.hash || '').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'g') return { guildId: parts[1], rest: parts.slice(2) };
  return { guildId: null, rest: [] };
}

export function routeFromRest(rest: string[]): Route {
  if (rest.length === 0) return { kind: 'list' };
  if (rest[0] === 'notifications') {
    // new2/edit2 は旧「新デザイン（V2）」時代のパス。V1 撤去（2026-08-23）後は同じフォームへ
    if (rest[1] === 'new' || rest[1] === 'new2') return { kind: 'notif-new' };
    if (rest[2] === 'edit' || rest[2] === 'edit2') return { kind: 'notif-edit', nuuid: rest[1] };
    if (rest[2] === 'grouping-settings') return { kind: 'grouping-settings', nuuid: rest[1] };
    if (rest[2] === 'occurrences' && rest[4] === 'grouping') {
      return { kind: 'grouping', nuuid: rest[1], ouuid: rest[3] };
    }
  }
  if (rest[0] === 'segments' && rest[2] === 'members') return { kind: 'seg-members', suuid: rest[1] };
  return { kind: 'list' };
}

/** ルート種別 → アクティブにすべきサイドナビ（'notif-ops'|'notifications'|'segments'| null=変更不要）。 */
export function sectionForRoute(kind: Route['kind']): string | null {
  if (kind === 'seg-members') return 'segments';
  if (kind === 'notif-new' || kind === 'notif-edit' || kind === 'grouping-settings') return 'notifications';
  if (kind !== 'list') return 'notif-ops'; // grouping
  return null;
}
