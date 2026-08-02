import type { Env } from '../env';
import type { MentionMode, NotificationType } from '../db/types';
import { isAnnounceOnly } from '../db/types';
import { listGuilds, listGuildChannels, listGuildMembers, listGuildRoles, leaveGuild } from '../discord/rest';
import {
  listSegments,
  getSegmentByUuid,
  createSegment,
  updateSegment,
  deleteSegment,
  countNotificationsForSegment,
  listSegmentMembers,
  addSegmentMember,
  setSegmentMemberStatus,
  removeSegmentMember,
  getActiveSegmentMembers,
} from '../db/segments';
import { syncSegmentFromRole, normalizeMentionRoleId } from '../discord/syncSegment';
import { getAllMembers, upsertMember, deleteMember, getMemberGuildName } from '../db/members';
import {
  listNotifications,
  listNotificationsByGuild,
  deactivateNotificationsForGuild,
  getNotification,
  getNotificationByUuid,
  createNotification,
  updateNotification,
  deleteNotification,
  setGroupingChannel,
  decideOccurrence,
  undecideNotification,
  type NotificationInput,
} from '../db/notifications';
import {
  getOccurrenceByUuid,
  getOrCreateOccurrence,
  setOccurrenceNote,
  setOccurrenceStatus,
  updateOccurrenceDate,
  listOccurrencesForNotification,
  syncCandidateOccurrences,
  type CandidateSlot,
} from '../db/occurrences';
import { nextOccurrenceDates } from '../lib/recurrence';
import { getResponsesForOccurrence, getStatusBuckets, listRecentResponses } from '../db/responses';
import {
  getGroupingView,
  getGroupByUuid,
  getConstraintByUuid,
  upsertGrouping,
  setGroupMembers,
  moveMemberToGroup,
  renameGroup,
  setGroupStartNo,
  deleteGrouping,
  listConstraints,
  upsertConstraint,
  deleteConstraint,
  autoAssign,
} from '../db/groupings';
import type { ConstraintDirection, ConstraintStrength, GroupingView } from '../db/types';
import { claimSend, finishSend, listSendLog, reclaimFailedSend, reclaimSentSend } from '../db/sendLog';
import { getAttendanceReport } from '../db/reports';
import { getAllConfig, setConfig, getSendBudget, OCC_ROLLFORWARD_KEY } from '../db/config';
import { sendChannelMessage, createButtonComponents } from '../discord/rest';
import { recruitNotificationNow, sendRecruitment } from '../cron/tick';
import { formatDate, formatTimeRange, getJSTNow } from '../lib/date';
import { getSetupStatus, registerCommandsForEnv } from './setup';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** クエリの数値（不正・非数値・0以下なら既定値）。不正 limit でD1に NaN を渡し 500 になるのを防ぐ。 */
function parseLimit(raw: string | null, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** ボディの数値（''・null・非数値なら既定値）。NaN を .bind に渡して 500 になるのを防ぐ。 */
function num(v: unknown, def: number): number {
  if (v === '' || v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * 単発(oneoff)の候補スロット（日付＋時刻）を正規化する。
 * body.candidate_slots（[{date,time}]・date は 'YYYY-MM-DD'/'YYYY/MM/DD'）を
 * 'YYYY/MM/DD'＋'HH:MM' に統一し、(date,time) で重複除去・昇順ソート。
 * 未指定なら後方互換で単一 (one_off_date, start_time) を 1 スロットとして使う。
 */
function candidateSlotsOf(
  b: Record<string, unknown>,
  fallbackDate: string | null,
  fallbackTime: string,
): CandidateSlot[] {
  const raw = Array.isArray(b.candidate_slots) ? (b.candidate_slots as unknown[]) : [];
  const seen = new Set<string>();
  const out: CandidateSlot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const date = typeof rec.date === 'string' ? rec.date.replace(/-/g, '/').trim() : '';
    const time = typeof rec.time === 'string' ? rec.time.trim() : '';
    if (!date || !time) continue;
    const k = `${date} ${time}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ date, time });
  }
  out.sort((a, z) => (a.date === z.date ? a.time.localeCompare(z.time) : a.date.localeCompare(z.date)));
  if (out.length) return out;
  return fallbackDate ? [{ date: fallbackDate, time: fallbackTime || '21:00' }] : [];
}

/** 定数時間比較（トークン照合） */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get('authorization') || '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  return !!env.ADMIN_TOKEN && timingSafeEqual(token, env.ADMIN_TOKEN);
}

/** URL パスの UUID セグメント（8-4-4-4-12 ハイフン入り 16 進文字列・ADR 0016） */
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** 盤面から送られてくる配置 1 グループ分（label は行頭ラベルの上書き・null=自動連番） */
export interface BoardAssignment {
  group_uuid?: string;
  members?: { user_id?: string; label?: string | null }[];
}

/** 行頭ラベルの末尾区切り（：/:）を除去する。区切りは保存値に持たせず表示時に一律付与する */
export function stripLabelSeparator(label: string): string {
  return label.replace(/[：:]+$/u, '');
}

/** BoardAssignment.members を正規化（user_id 必須・label は空文字を null に・末尾：除去・最大20字） */
export function normalizeBoardMembers(
  members: BoardAssignment['members'],
): { user_id: string; label: string | null }[] {
  return (Array.isArray(members) ? members : [])
    .filter((m) => m && typeof m.user_id === 'string' && m.user_id)
    .map((m) => {
      const raw = typeof m.label === 'string' ? stripLabelSeparator(m.label.trim()).slice(0, 20) : '';
      return { user_id: m.user_id as string, label: raw || null };
    });
}

/**
 * メンバー配置投稿の 1 グループ分の行頭ラベル列（ADR 0015 追補2）。
 * label の上書きはそのまま、残りへ startNo 起点の連番を振る（上書きは連番を消費しない）。
 * 区切りの「：」は自動連番・上書きラベルとも表示時に一律付与する。
 */
export function memberLineLabels(
  members: { label?: string | null }[],
  startNo = 1,
): string[] {
  let n = startNo - 1;
  return members.map((m) => (m.label ? `${stripLabelSeparator(m.label)}：` : `${++n}：`));
}

/**
 * dry-run プレビュー用（ADR 0015 追補）: 盤面の現在状態（未保存の assignments / 未割り当て）を
 * GroupingView へ上書きする。名前は view 内の既知メンバー（未割り当て・保存済み groups）から
 * 解決し、未知の user_id はそのまま表示する。assignments に無い Group は保存済みのまま残す。
 */
export function applyBoardStateToView(
  view: GroupingView,
  assignments: BoardAssignment[],
  poolUserIds: string[],
): void {
  const nameOf = new Map<string, string>();
  for (const p of view.pool) nameOf.set(p.user_id, p.name);
  for (const g of view.groups) for (const m of g.members) nameOf.set(m.user_id, m.name);
  const byUuid = new Map(assignments.map((a) => [a.group_uuid, normalizeBoardMembers(a.members)]));
  for (const g of view.groups) {
    const ms = byUuid.get(g.uuid);
    if (ms) g.members = ms.map((m) => ({ ...m, name: nameOf.get(m.user_id) ?? m.user_id }));
  }
  view.pool = poolUserIds.map((uid) => ({ user_id: uid, name: nameOf.get(uid) ?? uid }));
}

/** Notification の入力ボディを正規化（数値フラグは 0/1） */
function toNotificationInput(b: Record<string, unknown>): NotificationInput | null {
  const guild_id = typeof b.guild_id === 'string' ? b.guild_id : '';
  const segment_id = Number(b.segment_id);
  const name = typeof b.name === 'string' ? b.name : '';
  const channel_id = typeof b.channel_id === 'string' ? b.channel_id : '';
  const type = (b.type === 'oneoff' ? 'oneoff' : 'recurring') as NotificationType;
  if (!guild_id || !segment_id || !name || !channel_id) return null;
  // 回答要否は recurring 専用。oneoff は常に回答あり（1）。回答不要(=通知のみ)は回答依存機能を無効化する。
  const requiresResponse =
    type === 'oneoff' ? 1 : b.requires_response === undefined ? 1 : b.requires_response ? 1 : 0;
  const announceOnly = isAnnounceOnly({ type, requires_response: requiresResponse });
  return {
    guild_id,
    segment_id,
    name,
    channel_id,
    type,
    rrule: b.rrule == null || b.rrule === '' ? null : String(b.rrule),
    one_off_date: b.one_off_date == null || b.one_off_date === '' ? null : String(b.one_off_date),
    anchor_date: b.anchor_date == null || b.anchor_date === '' ? null : String(b.anchor_date),
    start_time: typeof b.start_time === 'string' && b.start_time ? b.start_time : '21:00',
    duration_minutes:
      (typeof b.duration_minutes !== 'number' && typeof b.duration_minutes !== 'string') ||
      b.duration_minutes === '' ||
      !Number.isFinite(Number(b.duration_minutes)) ||
      Number(b.duration_minutes) <= 0
        ? null
        : Math.floor(Number(b.duration_minutes)),
    recruit_days_before: num(b.recruit_days_before, 7),
    remind_start_days: num(b.remind_start_days, 3),
    // 負値は daysUntil と一致せず未定リマインドが無音化するため 0 以上にクランプ（0=当日）。
    remind_undecided_days: Math.max(0, num(b.remind_undecided_days, 1)),
    // ノルマ（参加間隔の督促）は繰り返し開催のための概念。単発(oneoff)では無効に固定し、
    // cron 自動募集を廃止した単発でノルマDMが沈黙する不整合（旧挙動からの回帰）を防ぐ。
    quota_enabled: type === 'oneoff' ? 0 : b.quota_enabled ? 1 : 0,
    quota_interval_days:
      type === 'oneoff' ||
      b.quota_interval_days == null ||
      b.quota_interval_days === '' ||
      !Number.isFinite(Number(b.quota_interval_days))
        ? null
        : Number(b.quota_interval_days),
    // 回答不要は番号割り当ても対象外。UI 表示と永続値を一致させ将来の発火経路追加時の事故も防ぐ。
    assignment_enabled: announceOnly ? 0 : b.assignment_enabled ? 1 : 0,
    // 回答不要はグループ分けも対象外（参加者が集計されないため）。
    grouping_enabled: announceOnly ? 0 : b.grouping_enabled ? 1 : 0,
    // メンション方法（ADR 0010）。不正値は 'role' に倒す。
    mention_mode: (b.mention_mode === 'none' || b.mention_mode === 'members' ? b.mention_mode : 'role') as MentionMode,
    requires_response: requiresResponse,
    // 見出し（必須・1行・最大100字）。改行は空白化。空かどうかは呼び出し側で 400 判定する。
    message_title: String(b.message_title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100),
    // 本文（任意・複数行・最大1500字）。空は null。
    message_body:
      b.message_body == null || String(b.message_body).trim() === ''
        ? null
        : String(b.message_body).trim().slice(0, 1500),
    active: b.active === undefined ? 1 : b.active ? 1 : 0,
    // ① 回答締切（ADR 0014）。announce-only は回答が無いので締切も無効（null）。
    //    開始の N 時間前。空/不正は null（締切なし）。0=開始時刻ちょうど。
    response_deadline_hours:
      announceOnly ||
      b.response_deadline_hours == null ||
      b.response_deadline_hours === '' ||
      !Number.isFinite(Number(b.response_deadline_hours))
        ? null
        : Math.max(0, Math.floor(Number(b.response_deadline_hours))),
    // ① 締切後変更の通知先チャンネル。空は null（投稿チャンネルにフォールバック）。
    change_alert_channel_id:
      typeof b.change_alert_channel_id === 'string' && b.change_alert_channel_id
        ? b.change_alert_channel_id
        : null,
    // ③ 送信時刻（JST 時・0〜23）。既定 21。
    send_hour: Math.min(23, Math.max(0, Math.floor(num(b.send_hour, 21)))),
  };
}

/**
 * 管理 API（/api/admin/*）。すべて ADMIN_TOKEN による Bearer 認証必須。すべて JSON。
 * - GET        /setup/status                  (シークレット有無・Interaction URL)
 * - POST       /setup/register-commands       ({guild_id?} スラッシュコマンド登録)
 * - GET        /guilds, /guilds/:id/channels, /guilds/:id/members, /guilds/:id/roles  (Discord 由来・読み取り専用)
 * - POST       /guilds/:id/leave              (通知を全無効化してから bot を退出＝管理対象から外す)
 * - GET/POST   /segments[?guild_id=],         PUT/DELETE /segments/:id
 * - GET        /segments/:id/members,         POST /segments/:id/members ({user_id,display_name?,user_name?})
 * - PUT/DELETE /segments/:id/members/:userId  ({status} for PUT)
 * - GET/POST   /members,                      DELETE /members/:userId
 * - GET/POST   /notifications[?guild_id=],    GET/PUT/DELETE /notifications/:id
 *              （POST/PUT で type='oneoff' は body.candidate_dates[] を候補回として同期）
 * - GET        /notifications/:id/occurrences
 * - POST       /notifications/:id/occurrences ({date,start_time?,status?} 日付指定で実体化・中止墓石/臨時回)
 * - GET        /notifications/:id/plan        (未実体化の未来開催日を RRULE から導出)
 * - POST       /notifications/:id/decide      ({occurrence_id} 最終確定・他候補を cancel)
 * - POST       /notifications/:id/undecide    (確定解除・落選候補を復活)
 * - POST       /notifications/:id/recruit     (今すぐ募集を投稿)
 * - PUT        /occurrences/:id               ({status|date})
 * - POST       /occurrences/:id/recruit       (単一開催回の即時募集・send_log 記録つき)
 * - GET        /occurrences/:id/responses,    GET /occurrences/:id/status (集計バケット)
 * - GET        /responses?limit=
 * - GET        /reports/attendance?segment_uuid=[&notification_uuid=&from=&to=]  (出勤レポート)
 * - GET        /send-log[?notification_id=&limit=]   (リマインド送信履歴・④可視化)
 * - GET/PUT    /config                                (送信予算など実行時設定・⑦)
 * - GET        /send-estimate[?guild_id=]             (推奨上限の推定・⑦)
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, '') || '/';
  const method = request.method;
  const db = env.DB;

  try {
    // ============ setup ウィザード ============
    if (path === '/setup/status' && method === 'GET') {
      return json(getSetupStatus(env, request));
    }
    if (path === '/setup/register-commands' && method === 'POST') {
      let guildId: string | null = null;
      try {
        const b = (await request.json()) as { guild_id?: string };
        guildId = b.guild_id || null;
      } catch {
        // ボディ無しは全体（グローバル）登録
      }
      try {
        const r = await registerCommandsForEnv(env, guildId);
        return json({ ok: true, ...r });
      } catch (e) {
        return json({ ok: false, error: (e as Error).message }, 400);
      }
    }

    // ============ guilds（Discord API 由来・読み取り専用）============
    if (path === '/guilds' && method === 'GET') {
      return json(await listGuilds(env));
    }
    const guildChannels = path.match(/^\/guilds\/(\d+)\/channels$/);
    if (guildChannels && method === 'GET') {
      return json(await listGuildChannels(env, guildChannels[1]));
    }
    const guildMembers = path.match(/^\/guilds\/(\d+)\/members$/);
    if (guildMembers && method === 'GET') {
      return json(await listGuildMembers(env, guildMembers[1]));
    }
    const guildRoles = path.match(/^\/guilds\/(\d+)\/roles$/);
    if (guildRoles && method === 'GET') {
      return json(await listGuildRoles(env, guildRoles[1]));
    }
    // サーバーからの退出（＝管理対象から外す）。先に通知を無効化してから退出することで、
    // 退出後に cron が居ないサーバーへ送信を試みて Discord API エラーを出し続けるのを防ぐ。
    // データは論理削除（active=0）のみで保持し、再招待時はそのまま復元できる。
    const guildLeave = path.match(/^\/guilds\/(\d+)\/leave$/);
    if (guildLeave && method === 'POST') {
      const guildId = guildLeave[1];
      const deactivated = await deactivateNotificationsForGuild(db, guildId);
      try {
        await leaveGuild(env, guildId);
      } catch (e) {
        // 無効化は済んでいるので、退出失敗は 502 で明示して手動キックを促す。
        return json({ ok: false, deactivated, error: (e as Error).message }, 502);
      }
      return json({ ok: true, deactivated });
    }

    // ============ segments ============
    if (path === '/segments') {
      if (method === 'GET') {
        const guildId = url.searchParams.get('guild_id') ?? undefined;
        return json(await listSegments(db, guildId));
      }
      if (method === 'POST') {
        const b = (await request.json()) as { guild_id?: string; name?: string; mention_role_id?: string | null };
        if (!b.guild_id) return json({ error: 'guild_id required' }, 400);
        if (!b.name) return json({ error: 'name required' }, 400);
        const roleId = normalizeMentionRoleId(b.mention_role_id, b.guild_id);
        if (roleId === undefined) {
          return json({ error: "ロール指定は '@everyone' またはロールID（数字）です。" }, 400);
        }
        return json(
          await createSegment(db, { guild_id: b.guild_id, name: b.name, mention_role_id: roleId }),
          201,
        );
      }
    }
    // /segments/:uuid/members/:userId
    const segMemberItem = path.match(new RegExp(`^/segments/(${UUID_RE})/members/(.+)$`));
    if (segMemberItem) {
      const seg = await getSegmentByUuid(db, segMemberItem[1]);
      if (!seg) return json({ error: 'Not found' }, 404);
      const userId = decodeURIComponent(segMemberItem[2]);
      if (method === 'PUT') {
        const b = (await request.json()) as { status?: string };
        if (b.status === undefined) return json({ error: 'status required' }, 400);
        // status は '' / '休止中' の2値固定。不正値は集計母集団からの静かな脱落を招くため弾く。
        if (b.status !== '' && b.status !== '休止中') {
          return json({ error: "status must be '' or '休止中'" }, 400);
        }
        const ok = await setSegmentMemberStatus(db, seg.id, userId, b.status);
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        const ok = await removeSegmentMember(db, seg.id, userId);
        return json({ ok }, ok ? 200 : 404);
      }
    }
    // /segments/:uuid/members
    const segMembers = path.match(new RegExp(`^/segments/(${UUID_RE})/members$`));
    if (segMembers) {
      const seg = await getSegmentByUuid(db, segMembers[1]);
      if (!seg) return json({ error: 'Not found' }, 404);
      if (method === 'GET') return json(await listSegmentMembers(db, seg.id));
      if (method === 'POST') {
        const b = (await request.json()) as {
          user_id?: string;
          user_name?: string | null;
          display_name?: string | null;
        };
        if (!b.user_id) return json({ error: 'user_id required' }, 400);
        await addSegmentMember(db, seg, b.user_id, {
          user_name: b.user_name ?? null,
          display_name: b.display_name ?? null,
        });
        return json({ ok: true }, 201);
      }
    }
    // /segments/:uuid/sync-from-role （ロール管理区分を Discord ロールから手動同期・ADR 0009）
    const segSync = path.match(new RegExp(`^/segments/(${UUID_RE})/sync-from-role$`));
    if (segSync && method === 'POST') {
      const seg = await getSegmentByUuid(db, segSync[1]);
      if (!seg) return json({ error: 'Not found' }, 404);
      if (!seg.mention_role_id) {
        return json({ error: 'この区分はロール管理ではありません（ロール未設定）。' }, 400);
      }
      // 手動同期は確認ダイアログ経由のため allowEmpty=true（明示的に空にできる）。
      const r = await syncSegmentFromRole(env, seg, { allowEmpty: true });
      return json(r, r.ok ? 200 : 400);
    }
    // /segments/:uuid
    const segId = path.match(new RegExp(`^/segments/(${UUID_RE})$`));
    if (segId) {
      const seg = await getSegmentByUuid(db, segId[1]);
      if (!seg) return json({ error: 'Not found' }, 404);
      if (method === 'PUT') {
        const b = (await request.json()) as { name?: string; mention_role_id?: string | null };
        if (!b.name) return json({ error: 'name required' }, 400);
        const roleId = normalizeMentionRoleId(b.mention_role_id, seg.guild_id);
        if (roleId === undefined) {
          return json({ error: "ロール指定は '@everyone' またはロールID（数字）です。" }, 400);
        }
        const ok = await updateSegment(db, seg.id, {
          name: b.name,
          mention_role_id: roleId,
        });
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        // 対象 Notification がある場合は削除させない（409）
        const count = await countNotificationsForSegment(db, seg.id);
        if (count > 0) {
          return json({ error: 'segment has notifications', count }, 409);
        }
        const ok = await deleteSegment(db, seg.id);
        return json({ ok }, ok ? 200 : 404);
      }
    }

    // ============ members ============
    if (path === '/members') {
      if (method === 'GET') return json(await getAllMembers(db));
      if (method === 'POST') {
        const m = (await request.json()) as {
          user_id?: string;
          user_name?: string | null;
          display_name?: string | null;
        };
        if (!m.user_id) return json({ error: 'user_id required' }, 400);
        await upsertMember(db, {
          user_id: m.user_id,
          user_name: m.user_name ?? null,
          display_name: m.display_name ?? null,
        });
        return json({ ok: true });
      }
    }
    const memberDelete = path.match(/^\/members\/(.+)$/);
    if (memberDelete && method === 'DELETE') {
      const ok = await deleteMember(db, decodeURIComponent(memberDelete[1]));
      return json({ ok }, ok ? 200 : 404);
    }

    // ============ notifications ============
    // body 内の segment_uuid → segment_id 解決（ADR 0016）
    async function resolveSegmentUuid(body: Record<string, unknown>): Promise<string | null> {
      if (typeof body.segment_uuid !== 'string' || !body.segment_uuid) {
        return 'segment_uuid required';
      }
      const seg = await getSegmentByUuid(db, body.segment_uuid);
      if (!seg) return 'segment not found';
      body.segment_id = seg.id;
      return null;
    }
    if (path === '/notifications') {
      if (method === 'GET') {
        const guildId = url.searchParams.get('guild_id');
        return json(guildId ? await listNotificationsByGuild(db, guildId) : await listNotifications(db));
      }
      if (method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        const err = await resolveSegmentUuid(body);
        if (err) return json({ error: err }, 400);
        const input = toNotificationInput(body);
        if (!input) return json({ error: 'Invalid body' }, 400);
        if (!input.message_title) return json({ error: '見出しは必須です。' }, 400);
        if (input.type === 'recurring' && !input.rrule) {
          return json({ error: '繰り返しは曜日/第N曜ルールが必須です。' }, 400);
        }
        if (input.type === 'oneoff') {
          const slots = candidateSlotsOf(body, input.one_off_date, input.start_time);
          if (slots.length === 0) return json({ error: '単発は候補日時が必須です' }, 400);
          input.one_off_date = slots[0].date;
          input.start_time = slots[0].time;
          const created = await createNotification(db, input);
          await syncCandidateOccurrences(db, created.id, slots);
          return json(created, 201);
        }
        const created = await createNotification(db, input);
        // 次ティックの日次ロールフォワードで次回開催回を即時実体化させる（rrule 実体化は 1 日 1 回集約）。
        await setConfig(db, OCC_ROLLFORWARD_KEY, '');
        return json(created, 201);
      }
    }
    // /notifications/:uuid/occurrences
    const notifOccs = path.match(new RegExp(`^/notifications/(${UUID_RE})/occurrences$`));
    if (notifOccs && method === 'GET') {
      const n = await getNotificationByUuid(db, notifOccs[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const limit = parseLimit(url.searchParams.get('limit'), 100);
      return json(await listOccurrencesForNotification(db, n.id, limit));
    }
    // 開催回を日付指定で実体化する（配信予定の「配信しない」＝ cancelled で作成、臨時回=scheduled）。
    // UNIQUE(notification_id, date, start_time) 上の upsert なので二重作成しない。
    if (notifOccs && method === 'POST') {
      const n = await getNotificationByUuid(db, notifOccs[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as {
        date?: string;
        start_time?: string;
        status?: string;
        note?: string;
      };
      if (typeof b.date !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(b.date)) {
        return json({ error: 'date (YYYY/MM/DD) required' }, 400);
      }
      const status = b.status ?? 'scheduled';
      if (status !== 'scheduled' && status !== 'cancelled') {
        return json({ error: 'invalid status' }, 400);
      }
      const time = typeof b.start_time === 'string' ? b.start_time : n.start_time;
      // 補足メッセージ（任意）。空白のみは「なし」に正規化し、message_body と同様に上限を切る。
      const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null;
      const occ = await getOrCreateOccurrence(db, n.id, b.date, time);
      if (occ.status !== status) await setOccurrenceStatus(db, occ.id, status);
      if (note !== null) await setOccurrenceNote(db, occ.id, note);
      return json({ ...occ, status, note: note ?? occ.note }, 201);
    }
    // 配信予定（未実体化の未来開催日）。RRULE から導出し、既に開催回が実体化済みの日付は除く。
    const notifPlan = path.match(new RegExp(`^/notifications/(${UUID_RE})/plan$`));
    if (notifPlan && method === 'GET') {
      const n = await getNotificationByUuid(db, notifPlan[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      if (n.type !== 'recurring') return json([]);
      const count = parseLimit(url.searchParams.get('count'), 8);
      const dates = nextOccurrenceDates(n, count);
      const existing = await listOccurrencesForNotification(db, n.id, 200);
      const taken = new Set(existing.map((o) => o.occurrence_date));
      return json(
        dates.filter((d) => !taken.has(d)).map((d) => ({ occurrence_date: d, start_time: n.start_time })),
      );
    }
    // /notifications/:uuid/decide （複数候補日の最終確定）
    const notifDecide = path.match(new RegExp(`^/notifications/(${UUID_RE})/decide$`));
    if (notifDecide && method === 'POST') {
      const n = await getNotificationByUuid(db, notifDecide[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { occurrence_uuid?: string };
      if (typeof b.occurrence_uuid !== 'string' || !b.occurrence_uuid) {
        return json({ error: 'occurrence_uuid required' }, 400);
      }
      const occ = await getOccurrenceByUuid(db, b.occurrence_uuid);
      if (!occ || occ.notification_id !== n.id) {
        return json({ error: 'occurrence does not belong to notification' }, 400);
      }
      await decideOccurrence(db, n.id, occ.id);
      const announced = await sendChannelMessage(
        env,
        n.channel_id,
        `✅ **開催日が確定しました**\n\n**${occ.occurrence_date}** ${formatTimeRange(occ.start_time || n.start_time, n.duration_minutes)} に開催します！\n\n出欠が変わる場合は下のボタンで回答してください。`,
        createButtonComponents(occ.id, n.type),
      );
      return json({ ok: true, decided_occurrence_uuid: occ.uuid, announced });
    }
    // /notifications/:uuid/undecide
    const notifUndecide = path.match(new RegExp(`^/notifications/(${UUID_RE})/undecide$`));
    if (notifUndecide && method === 'POST') {
      const n = await getNotificationByUuid(db, notifUndecide[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      await undecideNotification(db, n.id);
      return json({ ok: true });
    }
    // /notifications/:uuid/recruit
    const notifRecruit = path.match(new RegExp(`^/notifications/(${UUID_RE})/recruit$`));
    if (notifRecruit && method === 'POST') {
      const n = await getNotificationByUuid(db, notifRecruit[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const r = await recruitNotificationNow(env, n);
      return json(r, r.ok ? 200 : 400);
    }
    // /notifications/:uuid
    const notifId = path.match(new RegExp(`^/notifications/(${UUID_RE})$`));
    if (notifId) {
      const n = await getNotificationByUuid(db, notifId[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      if (method === 'GET') {
        return json(n);
      }
      if (method === 'PUT') {
        const body = (await request.json()) as Record<string, unknown>;
        const err = await resolveSegmentUuid(body);
        if (err) return json({ error: err }, 400);
        const input = toNotificationInput(body);
        if (!input) return json({ error: 'Invalid body' }, 400);
        if (!input.message_title) return json({ error: '見出しは必須です。' }, 400);
        if (input.type === 'recurring' && !input.rrule) {
          return json({ error: '繰り返しは曜日/第N曜ルールが必須です。' }, 400);
        }
        if (input.type === 'oneoff') {
          const slots = candidateSlotsOf(body, input.one_off_date, input.start_time);
          if (slots.length === 0) return json({ error: '単発は候補日時が必須です' }, 400);
          input.one_off_date = slots[0].date;
          input.start_time = slots[0].time;
          const ok = await updateNotification(db, n.id, input);
          if (!ok) return json({ ok }, 404);
          const current = await getNotification(db, n.id);
          if (current && current.decided_occurrence_id == null) {
            await syncCandidateOccurrences(db, n.id, slots);
          }
          return json({ ok });
        }
        const ok = await updateNotification(db, n.id, input);
        // rrule/anchor/start_time 変更で次回日が変わりうるため実体化をやり直させる。
        if (ok) await setConfig(db, OCC_ROLLFORWARD_KEY, '');
        return json({ ok }, ok ? 200 : 404);
      }
      if (method === 'DELETE') {
        const ok = await deleteNotification(db, n.id);
        return json({ ok }, ok ? 200 : 404);
      }
    }

    // ============ occurrences ============
    // /occurrences/:uuid/responses
    const occResponses = path.match(new RegExp(`^/occurrences/(${UUID_RE})/responses$`));
    if (occResponses && method === 'GET') {
      const occ = await getOccurrenceByUuid(db, occResponses[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      return json(await getResponsesForOccurrence(db, occ.id));
    }
    // /occurrences/:uuid/status
    const occStatus = path.match(new RegExp(`^/occurrences/(${UUID_RE})/status$`));
    if (occStatus && method === 'GET') {
      const occ = await getOccurrenceByUuid(db, occStatus[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const n = await getNotification(db, occ.notification_id);
      if (!n) return json({ error: 'Not found' }, 404);
      return json(await getStatusBuckets(db, occ.id, n.segment_id));
    }
    // /occurrences/:uuid/recruit （単一開催回の即時募集・臨時回向け）
    // send_log に claim/finish を記録し、cron の窓内自動募集（hasSentKind 照合）と二重にならないようにする。
    const occRecruit = path.match(new RegExp(`^/occurrences/(${UUID_RE})/recruit$`));
    if (occRecruit && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occRecruit[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      if (occ.status !== 'scheduled') return json({ error: '中止された開催回は募集できません。' }, 400);
      const n = await getNotification(db, occ.notification_id);
      if (!n) return json({ error: 'Not found' }, 404);
      const key = {
        notification_id: n.id,
        occurrence_id: occ.id,
        kind: 'recruit' as const,
        send_date: formatDate(getJSTNow()),
      };
      // body は任意（{force?: true}）。force=送信済みでも再送する（UI の確認ダイアログ了承後のみ）。
      const b = (await request.json().catch(() => ({}))) as { force?: boolean };
      // 新規 claim できなければ、失敗で終わった同日 claim を取り直す（当日中の手動リトライを許す）。
      // force 時は sent も取り直す。sending（送信中）だけはどちらでも不可＝並行実行の二重送信ガード。
      const claimed =
        (await claimSend(db, key)) ||
        (await reclaimFailedSend(db, key)) ||
        (b.force === true && (await reclaimSentSend(db, key)));
      if (!claimed) return json({ error: 'この開催回の募集は既に送信済み（または送信中）です。' }, 409);
      const ok = await sendRecruitment(env, n, occ);
      await finishSend(db, key, ok, ok ? null : 'manual send failed');
      return json({ ok }, ok ? 200 : 400);
    }
    // /occurrences/:uuid ({status|date})
    const occId = path.match(new RegExp(`^/occurrences/(${UUID_RE})$`));
    if (occId && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occId[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { status?: string; date?: string };
      if (b.status !== undefined) {
        if (b.status !== 'scheduled' && b.status !== 'cancelled') {
          return json({ error: 'invalid status' }, 400);
        }
        const ok = await setOccurrenceStatus(db, occ.id, b.status);
        return json({ ok }, ok ? 200 : 404);
      }
      if (b.date !== undefined) {
        if (!b.date) return json({ error: 'date required' }, 400);
        const ok = await updateOccurrenceDate(db, occ.id, b.date);
        return json({ ok }, ok ? 200 : 404);
      }
      return json({ error: 'status or date required' }, 400);
    }

    // ============ grouping（グループ分け・ADR 0015）============
    // /occurrences/:uuid/grouping
    const occGrouping = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping$`));
    if (occGrouping) {
      const occ = await getOccurrenceByUuid(db, occGrouping[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      if (method === 'GET') {
        return json(await getGroupingView(db, occ.id));
      }
      if (method === 'PUT') {
        const b = (await request.json()) as { group_count?: number };
        const gc = Number(b.group_count);
        if (!Number.isInteger(gc) || gc < 1 || gc > 100) {
          return json({ error: 'group_count must be 1..100' }, 400);
        }
        await upsertGrouping(db, occ.id, gc);
        return json(await getGroupingView(db, occ.id));
      }
      if (method === 'DELETE') {
        const ok = await deleteGrouping(db, occ.id);
        return json({ ok }, ok ? 200 : 404);
      }
    }
    // /occurrences/:uuid/grouping/members  PUT
    //   body: { assignments: [{group_uuid, members: [{user_id, label}]}] }（ADR 0015 追補2）
    const occGroupingMembers = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/members$`));
    if (occGroupingMembers && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occGroupingMembers[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { assignments?: BoardAssignment[] };
      const assignments = Array.isArray(b.assignments) ? b.assignments : [];
      const normalized: { group_id: number; members: { user_id: string; label: string | null }[] }[] = [];
      for (const a of assignments) {
        if (typeof a.group_uuid !== 'string') continue;
        const grp = await getGroupByUuid(db, a.group_uuid);
        if (!grp) continue;
        normalized.push({ group_id: grp.id, members: normalizeBoardMembers(a.members) });
      }
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      await setGroupMembers(db, view.grouping.id, normalized);
      return json(await getGroupingView(db, occ.id));
    }
    // /occurrences/:uuid/grouping/move  PUT
    //   body: { user_id, to_group_uuid|null }
    const occGroupingMove = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/move$`));
    if (occGroupingMove && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occGroupingMove[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { user_id?: string; to_group_uuid?: string | null };
      const userId = typeof b.user_id === 'string' ? b.user_id : '';
      if (!userId) return json({ error: 'user_id required' }, 400);
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      let toGroupId: number | null = null;
      if (b.to_group_uuid != null) {
        const grp = await getGroupByUuid(db, b.to_group_uuid);
        if (!grp) return json({ error: 'group not found' }, 400);
        toGroupId = grp.id;
      }
      await moveMemberToGroup(db, view.grouping.id, userId, toGroupId);
      return json(await getGroupingView(db, occ.id));
    }
    // /occurrences/:uuid/grouping/rename  PUT
    //   body: { group_uuid, name }
    const occGroupingRename = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/rename$`));
    if (occGroupingRename && method === 'PUT') {
      const occ = await getOccurrenceByUuid(db, occGroupingRename[1]);
      if (!occ) return json({ error: 'Not found' }, 404);
      const b = (await request.json()) as { group_uuid?: string; name?: string; start_no?: unknown };
      const name = typeof b.name === 'string' ? b.name.trim().slice(0, 50) : '';
      // 自動連番の開始番号（任意・0以上の整数・ADR 0015 追補2拡張）
      const startNo =
        b.start_no === undefined || !Number.isFinite(Number(b.start_no))
          ? null
          : Math.max(0, Math.floor(Number(b.start_no)));
      if (typeof b.group_uuid !== 'string' || !b.group_uuid || (!name && startNo === null)) {
        return json({ error: 'group_uuid and name or start_no required' }, 400);
      }
      const grp = await getGroupByUuid(db, b.group_uuid);
      if (!grp) return json({ error: 'group not found' }, 404);
      let ok = true;
      if (name) ok = (await renameGroup(db, grp.id, name)) && ok;
      if (startNo !== null) ok = (await setGroupStartNo(db, grp.id, startNo)) && ok;
      return json({ ok }, ok ? 200 : 404);
    }
    // /occurrences/:uuid/grouping/auto-assign  POST
    // 追補(ADR 0015): 永続化しない dry-run。盤面の現在状態（未保存 assignments・任意）を
    // 受け取り、未配置の参加者の配置案 {proposals} を返す。クライアントが盤面に反映し
    // 「保存」で確定する。ボディ省略時は保存済み状態を盤面とみなす。
    const occGroupingAuto = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/auto-assign$`));
    if (occGroupingAuto && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occGroupingAuto[1]);
      if (!occ) return json({ error: 'occurrence not found' }, 404);
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      const constraints = await listConstraints(db, occ.notification_id);
      const b = (await request.json().catch(() => ({}))) as { assignments?: BoardAssignment[] };
      const assignedIds = new Set<string>();
      if (Array.isArray(b.assignments)) {
        for (const a of b.assignments) for (const m of normalizeBoardMembers(a.members)) assignedIds.add(m.user_id);
      } else {
        for (const g of view.groups) for (const m of g.members) assignedIds.add(m.user_id);
      }
      // 現在の参加者（保存済みグループ内の不参加化メンバーは除く）のうち、盤面で未配置の者が対象
      const noLonger = new Set(view.diff.no_longer_participating.map((x) => x.user_id));
      const participantIds = [
        ...view.pool.map((m) => m.user_id),
        ...view.groups.flatMap((g) => g.members.map((m) => m.user_id).filter((u) => !noLonger.has(u))),
      ].filter((u) => !assignedIds.has(u));
      const groupIds = view.groups.map((g) => g.id);
      const result = autoAssign(participantIds, groupIds, constraints);
      const uuidOf = new Map(view.groups.map((g) => [g.id, g.uuid]));
      const proposals = Array.from(result.byGroupId.entries()).map(([group_id, user_ids]) => ({
        group_uuid: uuidOf.get(group_id),
        user_ids,
      }));
      return json({ proposals });
    }
    // /occurrences/:uuid/grouping/announce  POST
    const occGroupingAnnounce = path.match(new RegExp(`^/occurrences/(${UUID_RE})/grouping/announce$`));
    if (occGroupingAnnounce && method === 'POST') {
      const occ = await getOccurrenceByUuid(db, occGroupingAnnounce[1]);
      if (!occ) return json({ error: 'occurrence not found' }, 404);
      const n = await getNotification(db, occ.notification_id);
      if (!n) return json({ error: 'notification not found' }, 404);
      const view = await getGroupingView(db, occ.id);
      if (!view.grouping) return json({ error: 'grouping not initialized' }, 400);
      // 追補(ADR 0015): dry_run は盤面の現在状態（未保存）を同送でき、その内容で文面を生成する
      const dryRun = url.searchParams.get('dry_run') === '1';
      const b = (await request.json().catch(() => ({}))) as {
        assignments?: BoardAssignment[];
        pool_user_ids?: string[];
      };
      if (dryRun && Array.isArray(b.assignments)) {
        applyBoardStateToView(view, b.assignments, Array.isArray(b.pool_user_ids) ? b.pool_user_ids : []);
      }
      const lines: string[] = [];
      lines.push(
        `🧩 **メンバー配置** ${occ.occurrence_date} ${formatTimeRange(occ.start_time || n.start_time, n.duration_minutes)}`,
      );
      lines.push('');
      for (const g of view.groups) {
        const labels = memberLineLabels(g.members, g.start_no ?? 1);
        const names = g.members
            .map((m, index) => `　${labels[index]}${m.name}`)
            .join('\n');

        lines.push(`**${g.name}** (${g.members.length}名):`);
        lines.push(names || '　—');
        lines.push(''); // ← グループ間に空行を追加
      }
      if (view.pool.length > 0) {
        lines.push('');
        lines.push(`未割り当て (${view.pool.length}名):\n${view.pool.map((m) => m.name).join('\n')}`);
      }
      const content = lines.join('\n');
      // ?dry_run=1: チャンネル送信せず content だけ返す（プレビュー用途）
      if (dryRun) {
        return json({ ok: true, content, dry_run: true });
      }
      // 投稿先はマスター設定（grouping_channel_id・NULL なら募集チャンネル）に従う
      const announced = await sendChannelMessage(env, n.grouping_channel_id ?? n.channel_id, content);
      return json({ ok: announced, content });
    }

    // /notifications/:nuuid/grouping-channel  PUT  body: { channel_id: string|null }
    // メンバー配置結果の投稿先（マスター設定・即時保存）。null=募集チャンネルにフォールバック。
    const notifGroupingChannel = path.match(
      new RegExp(`^/notifications/(${UUID_RE})/grouping-channel$`),
    );
    if (notifGroupingChannel && method === 'PUT') {
      const n = await getNotificationByUuid(db, notifGroupingChannel[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      const b = (await request.json().catch(() => ({}))) as { channel_id?: string | null };
      const channelId = typeof b.channel_id === 'string' && b.channel_id ? b.channel_id : null;
      const ok = await setGroupingChannel(db, n.id, channelId);
      return json({ ok, channel_id: channelId }, ok ? 200 : 404);
    }

    // ============ constraints（ペア制約・Notification 単位・ADR 0015）============
    // /notifications/:nuuid/constraints
    const notifConstraints = path.match(new RegExp(`^/notifications/(${UUID_RE})/constraints$`));
    if (notifConstraints) {
      const n = await getNotificationByUuid(db, notifConstraints[1]);
      if (!n) return json({ error: 'Not found' }, 404);
      if (method === 'GET') {
        const rows = await listConstraints(db, n.id);
        const cache = new Map<string, string | null>();
        const nameOf = async (uid: string): Promise<string | null> => {
          if (cache.has(uid)) return cache.get(uid) ?? null;
          const name = await getMemberGuildName(db, n.guild_id, uid);
          cache.set(uid, name);
          return name;
        };
        const enriched = await Promise.all(
          rows.map(async (c) => ({
            ...c,
            user_a_name: await nameOf(c.user_id_a),
            user_b_name: await nameOf(c.user_id_b),
          })),
        );
        return json(enriched);
      }
      if (method === 'POST') {
        const b = (await request.json()) as {
          user_id_a?: string;
          user_id_b?: string;
          direction?: string;
          strength?: string;
        };
        const a = typeof b.user_id_a === 'string' ? b.user_id_a : '';
        const c = typeof b.user_id_b === 'string' ? b.user_id_b : '';
        if (!a || !c || a === c) return json({ error: 'distinct user_id_a/b required' }, 400);
        const dir: ConstraintDirection =
          b.direction === 'apart' ? 'apart' : 'together';
        const str: ConstraintStrength =
          b.strength === 'preferred' ? 'preferred' : 'required';
        const created = await upsertConstraint(db, n.id, a, c, dir, str);
        return json(created, 201);
      }
    }
    // /notifications/:nuuid/constraints/:cuuid  DELETE
    const constraintDelete = path.match(
      new RegExp(`^/notifications/(${UUID_RE})/constraints/(${UUID_RE})$`),
    );
    if (constraintDelete && method === 'DELETE') {
      const cst = await getConstraintByUuid(db, constraintDelete[2]);
      if (!cst) return json({ ok: false }, 404);
      const ok = await deleteConstraint(db, cst.id);
      return json({ ok }, ok ? 200 : 404);
    }

    // ============ responses ============
    if (path === '/responses' && method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'), 200);
      const guildId = url.searchParams.get('guild_id') || undefined;
      return json(await listRecentResponses(db, limit, guildId));
    }

    // ============ reports（出勤レポート）============
    if (path === '/reports/attendance' && method === 'GET') {
      const seg = await getSegmentByUuid(db, url.searchParams.get('segment_uuid') || '');
      if (!seg) return json({ error: 'segment not found' }, 404);
      // 通知単位の絞り込み（任意）。母集団は区分のまま、開催回だけをその通知に限定する。
      let notificationId: number | null = null;
      const nuuid = url.searchParams.get('notification_uuid');
      if (nuuid) {
        const n = await getNotificationByUuid(db, nuuid);
        if (!n || n.segment_id !== seg.id) {
          return json({ error: 'notification not found in segment' }, 404);
        }
        notificationId = n.id;
      }
      // 日付は 'YYYY-MM-DD'（UI の date input）/'YYYY/MM/DD' 両対応。不正は未指定扱い。
      const dateParam = (name: string): string | null => {
        const v = url.searchParams.get(name);
        return v && /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(v) ? v.replace(/-/g, '/') : null;
      };
      return json(
        await getAttendanceReport(db, seg.id, {
          from: dateParam('from'),
          to: dateParam('to'),
          today: formatDate(getJSTNow()),
          notificationId,
        }),
      );
    }

    // ============ send-log（リマインド送信履歴・④可視化）============
    if (path === '/send-log' && method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'), 300);
      const nid = url.searchParams.get('notification_id');
      const guildId = url.searchParams.get('guild_id') || undefined;
      return json(
        await listSendLog(db, {
          limit,
          notificationId: nid ? Number(nid) : undefined,
          guildId,
        }),
      );
    }

    // ============ config（送信予算など実行時設定・⑦）============
    if (path === '/config') {
      if (method === 'GET') return json(await getAllConfig(db));
      if (method === 'PUT') {
        const b = (await request.json()) as { key?: string; value?: string };
        if (!b.key || b.value == null) return json({ error: 'key and value required' }, 400);
        await setConfig(db, b.key, String(b.value));
        return json({ ok: true });
      }
    }

    // ============ send-estimate（推奨上限の推定・⑦）============
    if (path === '/send-estimate' && method === 'GET') {
      const guildId = url.searchParams.get('guild_id');
      const notifs = guildId
        ? await listNotificationsByGuild(db, guildId)
        : await listNotifications(db);
      const budget = await getSendBudget(db);
      const memberCache = new Map<number, number>();
      const perHour: Record<string, number> = {};
      for (const n of notifs) {
        if (!n.active) continue;
        let cnt = memberCache.get(n.segment_id);
        if (cnt == null) {
          cnt = (await getActiveSegmentMembers(db, n.segment_id)).length;
          memberCache.set(n.segment_id, cnt);
        }
        // ピーク = その通知が 1 日に投げうる最大送信数（全員未回答で DM）。回答不要(通知のみ)は募集1件。
        const peak = n.requires_response ? cnt : 1;
        perHour[String(n.send_hour)] = (perHour[String(n.send_hour)] ?? 0) + peak;
      }
      const dailyTotal = Object.values(perHour).reduce((a, b) => a + b, 0);
      const maxWindow = Object.values(perHour).reduce((a, b) => Math.max(a, b), 0);
      const hardCeiling = budget * 1440; // 毎分 cron × 予算 = 1 日のハード上限
      const recommendedDaily = Math.round(hardCeiling * 0.15); // 安全マージン込みの推奨日次
      const recommendedPerWindow = budget * 55; // 1 送信時刻を約 55 分以内に流し切れる量
      return json({
        budget,
        perHour,
        dailyTotal,
        maxWindow,
        hardCeiling,
        recommendedDaily,
        recommendedPerWindow,
        overDaily: dailyTotal > recommendedDaily,
        overWindow: maxWindow > recommendedPerWindow,
      });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error('[Admin] error:', (e as Error).message);
    return json({ error: 'Internal error' }, 500);
  }
}
