import type { Env } from '../env';
import type { Notification, Occurrence, QuotaAlert, Segment } from '../db/types';
import { isAnnounceOnly, resolveDisplayName } from '../db/types';
import { listActiveNotifications } from '../db/notifications';
import {
  getOccurrence,
  getOrCreateOccurrence,
  hasCancelledOccurrenceOnDate,
  listFutureOccurrencesAll,
  listScheduledOccurrences,
} from '../db/occurrences';
import {
  checkQuotaForNotification,
  remainingUnansweredTargets,
  remainingUndecidedTargets,
} from '../db/responses';
import { getActiveSegmentMembers, getSegment, listSegments } from '../db/segments';
import { claimSend, finishSend, clearStaleClaims, hasSentKind, type SendKey } from '../db/sendLog';
import {
  getAllConfig,
  setConfig,
  parseConfigInt,
  SEND_BUDGET_KEY,
  DEFAULT_SEND_BUDGET,
  OCC_ROLLFORWARD_KEY,
} from '../db/config';
import { syncSegmentFromRole } from '../discord/syncSegment';
import { nextOccurrenceDate } from '../lib/recurrence';
import {
  getDaysUntil,
  getJSTNow,
  formatDate,
  formatOccurrenceLabel,
  responseDeadline,
} from '../lib/date';
import {
  sendChannelMessage,
  sendDirectMessageCached,
  createButtonComponents,
  createStatusAllButton,
  buildMentionPrefix,
  composePost,
  listGuildMembers,
  listGuilds,
  DISCORD_CONTENT_LIMIT,
  type GuildMemberSummary,
} from '../discord/rest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DM_INTERVAL_MS = 300;

// 日次ロールフォワードで 1 ティックに rrule 評価する recurring の最大件数。
// rrule は ~1ms/回（dtstart 巻き寄せ後）× Workers Free の CPU 10ms 律速のため、1 ティックに
// 全件は回せない。kill されても次ティックが同じチャンクから再開する（マーカーで進捗管理）。
// ponytail: 8件/分＝recurring 数百件で実体化完了に約1時間。その規模は Paid 前提で要再設計。
const ROLLFORWARD_CHUNK = 8;

/**
 * 投稿の @メンション接頭辞を mention_mode に従って解決する（ADR 0010）。
 * 'members' のときだけ区分のアクティブメンバーを取得して `<@id>` 列挙の材料にする。
 * budget はバイネーム接頭辞に割ける字数（呼び出し側が本文長から逆算して渡す）。
 */
async function mentionPrefixFor(
  env: Env,
  n: Notification,
  segment: Segment | null,
  budget?: number,
): Promise<string> {
  if (!segment || n.mention_mode === 'none') return '';
  let memberIds: string[] = [];
  if (n.mention_mode === 'members') {
    const members = await getActiveSegmentMembers(env.DB, n.segment_id);
    memberIds = members.map((m) => m.user_id);
  }
  return buildMentionPrefix(segment, n.mention_mode, memberIds, budget);
}

/**
 * Discord 側のメンション解析対象を mention_mode に絞る allowed_mentions を返す（ADR 0010）。
 * 本文(message_body)に書かれた @everyone 等で意図しない一斉メンションが飛ぶのを防ぐ。
 * - none: 何もメンションしない / role: ロール（@everyone は everyone）/ members: ユーザーのみ
 */
function allowedMentionsFor(n: Notification, segment: Segment | null): { parse: string[] } {
  if (n.mention_mode === 'none') return { parse: [] };
  if (n.mention_mode === 'members') return { parse: ['users'] };
  if (segment && segment.mention_role_id === '@everyone') return { parse: ['everyone'] };
  return { parse: ['roles'] };
}

/**
 * チャンネル投稿の本文を合成する（ADR 0010）。見出し/本文/日時(tail)の実長から
 * バイネームに割ける字数を逆算し、合成後が Discord の content 上限を超えないようにする。
 */
async function composeChannelPost(
  env: Env,
  n: Notification,
  segment: Segment | null,
  tail: string,
): Promise<string> {
  const restLen = composePost('', n.message_title, n.message_body, tail).length;
  const budget = Math.max(0, DISCORD_CONTENT_LIMIT - restLen);
  const prefix = await mentionPrefixFor(env, n, segment, budget);
  return composePost(prefix, n.message_title, n.message_body, tail);
}

/** スロットの表示時刻（occ.start_time 優先・空なら通知の既定 start_time）。 */
function slotTime(occ: Occurrence, n: Notification): string {
  return occ.start_time || n.start_time;
}
/** 'YYYY/MM/DD (曜) HH:MM〜HH:MM' のスロット表示ラベル（duration 未設定なら開放端「HH:MM〜」）。 */
function slotLabel(occ: Occurrence, n: Notification): string {
  return formatOccurrenceLabel(occ.occurrence_date, slotTime(occ, n), n.duration_minutes);
}

/** 募集（回答締切が設定されていれば日時行に併記する・ADR 0014）。 */
export async function sendRecruitment(env: Env, n: Notification, occ: Occurrence): Promise<boolean> {
  const segment = await getSegment(env.DB, n.segment_id);
  const dl = responseDeadline(occ.occurrence_date, slotTime(occ, n), n.response_deadline_hours);
  const dateLine = dl
    ? `日時: **${slotLabel(occ, n)}**\n回答締切: **${formatDate(dl)} ${String(dl.getHours()).padStart(2, '0')}:${String(dl.getMinutes()).padStart(2, '0')}**`
    : `日時: **${slotLabel(occ, n)}**`;
  // 開催回の補足メッセージ（臨時回のコラボ説明など）は本文と日時行の間に差し込む。
  // tail に含めることで composeChannelPost の字数バジェットに自動で乗る。
  const tail = occ.note?.trim() ? `${occ.note.trim()}\n\n${dateLine}` : dateLine;
  // 見出し（必須）＋本文（任意）＋日時行（自動）。回答不要(announce-only)はボタンを付けない。
  const message = await composeChannelPost(env, n, segment, tail);
  const components = isAnnounceOnly(n) ? null : createButtonComponents(occ.id, n.type);
  const ok = await sendChannelMessage(env, n.channel_id, message, components, allowedMentionsFor(n, segment));
  console.log(ok ? `✅ [Recruitment] sent (n=${n.id})` : `❌ [Recruitment] failed (n=${n.id})`);
  return ok;
}

/**
 * 単発・複数候補日の募集。候補日一覧のヘッダ（メンションはここで1回）に続けて、
 * 候補日ごとに 1 メッセージ（参加/不参加/未定/状況確認ボタン付き）を投稿する。
 * ボタン custom_id は {action}_{occurrenceId} で開催回単位なので回答ハンドラは無改修で機能する。
 * 募集 UI（/notify・管理画面の「今すぐ募集」）からも再利用する。
 */
export async function sendCandidateRecruitment(
  env: Env,
  n: Notification,
  occs: Occurrence[],
): Promise<number> {
  if (occs.length === 0) return 0;
  const segment = await getSegment(env.DB, n.segment_id);
  const list = occs.map((o, i) => `${i + 1}. **${slotLabel(o, n)}**`).join('\n');
  // 見出し/本文（カスタム）に、候補投票の操作ガイド＋候補一覧をシステム後段として続ける。
  const guide =
    `下の各候補について、ボタンで回答してください（都合のつく候補すべてに「可」を選べます）。\n` +
    `全体の状況は下の「📊 全候補の状況」ボタンで確認できます。\n\n${list}`;
  const header = await composeChannelPost(env, n, segment, guide);
  // ヘッダに全候補の状況をまとめて返す集約ボタンを1つ付ける（各候補には状況確認を付けない）。
  const headerOk = await sendChannelMessage(
    env, n.channel_id, header, createStatusAllButton(n.id), allowedMentionsFor(n, segment),
  );
  if (!headerOk) console.error(`❌ [CandidateRecruitment] header failed (n=${n.id})`);
  await sleep(DM_INTERVAL_MS);

  let sent = 0;
  for (const o of occs) {
    const msg = `🗓️ **${slotLabel(o, n)}** の可否`;
    const ok = await sendChannelMessage(env, n.channel_id, msg, createButtonComponents(o.id, n.type, false));
    if (ok) sent++;
    else console.error(`❌ [CandidateRecruitment] failed (n=${n.id}, occ=${o.id})`);
    await sleep(DM_INTERVAL_MS); // チャンネル連投のレート制限対策
  }
  console.log(`✅ [CandidateRecruitment] sent ${sent}/${occs.length} (n=${n.id})`);
  return sent;
}

/**
 * 募集を即時実行する（スラッシュコマンド /notify と管理画面「今すぐ募集」で共用）。
 * 単発・複数候補日（未確定）は候補回をまとめて募集、それ以外は次回開催回を 1 件募集する。
 */
export async function recruitNotificationNow(
  env: Env,
  n: Notification,
): Promise<{ ok: boolean; message: string }> {
  const db = env.DB;
  const segment = await getSegment(db, n.segment_id);
  if (!segment) return { ok: false, message: `対象の区分 #${n.segment_id} が見つかりません。` };

  // 単発: 確定済みは確定回を、未確定は候補回（複数なら一括／1件ならそれ）を募集する。
  // 確定済みで最早でないスロットを選んだ場合に nextOccurrenceDate(=one_off_date=最早)を掴んで
  // cancelled スロットで失敗する不具合を避けるため、確定回は id で直接対象にする。
  if (n.type === 'oneoff') {
    if (n.decided_occurrence_id != null) {
      const occ = await getOccurrence(db, n.decided_occurrence_id);
      if (!occ || occ.status !== 'scheduled') {
        return { ok: false, message: '確定した開催回が見つかりません（確定解除や削除の可能性）。' };
      }
      const sentOk = await sendRecruitment(env, n, occ);
      return sentOk
        ? { ok: true, message: `**${formatOccurrenceLabel(occ.occurrence_date, slotTime(occ, n), n.duration_minutes)}** の募集メッセージを送信しました!` }
        : { ok: false, message: '募集メッセージの送信に失敗しました（文字数超過や Discord エラーの可能性）。' };
    }
    const candidates = await listScheduledOccurrences(db, n.id);
    // 候補回が未生成の旧データは one_off_date から 1 件だけ補完
    if (candidates.length === 0 && n.one_off_date) {
      candidates.push(await getOrCreateOccurrence(db, n.id, n.one_off_date, n.start_time));
    }
    const live = candidates.filter((o) => o.status === 'scheduled');
    if (live.length === 0) return { ok: false, message: '募集できる候補日がありません。' };
    if (live.length > 1) {
      const sent = await sendCandidateRecruitment(env, n, live);
      return sent > 0
        ? { ok: true, message: `${live.length} 件の候補日について募集メッセージを送信しました!` }
        : { ok: false, message: '募集メッセージの送信に失敗しました。' };
    }
    const liveOk = await sendRecruitment(env, n, live[0]);
    return liveOk
      ? { ok: true, message: `**${formatOccurrenceLabel(live[0].occurrence_date, slotTime(live[0], n), n.duration_minutes)}** の募集メッセージを送信しました!` }
      : { ok: false, message: '募集メッセージの送信に失敗しました（文字数超過や Discord エラーの可能性）。' };
  }

  // recurring: 次回開催回を 1 件募集
  const target = nextOccurrenceDate(n);
  if (!target) {
    return { ok: false, message: '次回の開催日を特定できませんでした（rrule を確認してください）。' };
  }
  // 中止の墓石照合は日付のみ（時刻無視）。start_time 変更後も中止意図を維持する。
  if (await hasCancelledOccurrenceOnDate(db, n.id, target)) {
    return { ok: false, message: `**${target}** の開催回は中止扱いのため募集できません。` };
  }
  const occ = await getOrCreateOccurrence(db, n.id, target, n.start_time);
  const recurOk = await sendRecruitment(env, n, occ);
  return recurOk
    ? { ok: true, message: `**${formatOccurrenceLabel(occ.occurrence_date, slotTime(occ, n), n.duration_minutes)}** の募集メッセージを送信しました!` }
    : { ok: false, message: '募集メッセージの送信に失敗しました（文字数超過や Discord エラーの可能性）。' };
}

// =============================================================================
// ペース配信エンジン（毎分 cron・ADR 0013）
//   送信時刻(send_hour)に達した通知の「今日の未送信分」を、1 ティック予算(send_budget_per_tick)
//   内で送る。残りは次ティックへ。send_log で (通知,開催回,宛先,種別,送信日) ごとに冪等化し、
//   毎分実行でも二重送信しない。subrequest 50/実行（Free）律速に対し予算で構造的に超えない。
// =============================================================================

/**
 * DM 見出しへのサーバー名付記。同じ Bot を複数サーバーで使うと同一メンバーへの DM が
 * 1 つのスレッドに混在してどのサーバーのイベントか判別できないため、見出しに付ける。
 * 名前未解決（同期前・不参加 guild）は付記を省略して従来表示に落とす。
 */
const guildSuffix = (guildName: string) => (guildName ? `（${guildName}）` : '');

/** ノルマ DM 文面 */
function quotaMessage(n: Notification, member: QuotaAlert, guildName: string): string {
  const daysText = `${member.daysSinceLast}日前`;
  return (
    `📊 **参加間隔の確認**${guildSuffix(guildName)}\n\n` +
    `こんにちは、**${resolveDisplayName(member)}** さん！\n` +
    `前回のイベント参加から少し時間が空いているようです（目安: ${n.quota_interval_days}日に1回）。\n\n` +
    `- 最終参加: **${member.lastDateStr}** (${daysText})\n\n` +
    `次回のイベントへの参加をぜひご検討ください！お待ちしています✨`
  );
}

/** 未回答リマインド DM 文面 */
function unansweredMessage(n: Notification, occ: Occurrence, daysUntil: number, guildName: string): string {
  const dayText = daysUntil === 0 ? '今日' : `あと${daysUntil}日`;
  return (
    `⏰ **リマインド: ${dayText}のイベント**${guildSuffix(guildName)}\n\n` +
    `日時: **${slotLabel(occ, n)}**\n\n` +
    `まだ回答されていません。下のボタンで参加状況を回答してください!`
  );
}

/** 未定者リマインド DM 文面 */
function undecidedMessage(n: Notification, occ: Occurrence, guildName: string): string {
  return (
    `❓ **未定者へのリマインド**${guildSuffix(guildName)}\n\n` +
    `日時: **${slotLabel(occ, n)}**\n\n` +
    `現在「未定」で回答されています。下のボタンで参加/不参加を確定してください!`
  );
}

/** 回答締切の到来告知（メンバー向け・募集チャンネルへ追従投稿・ADR 0014） */
function deadlineNoticeMessage(n: Notification, occ: Occurrence): string {
  return (
    `⏰ **回答を締め切りました**（${slotLabel(occ, n)}）\n` +
    `以降に回答を変更すると、主催者に記録・通知されます。`
  );
}

interface TickCtx {
  env: Env;
  db: D1Database;
  now: Date; // getJSTNow()
  today: string; // 'YYYY/MM/DD'(JST)
  hour: number; // JST 時(0-23)
  budget: { n: number }; // 1 ティックの残り送信予算（subrequest 50 律速）
  config: Record<string, string>; // ティック冒頭で一括読みした config（毎分の細切れ照会を避ける）
}

interface SendTask {
  key: SendKey;
  run: () => Promise<boolean>;
}

/**
 * タスク群を予算内でドレインする。claim → 送信 → finish。
 * 既送信(claim=false)は予算を消費せずスキップ。予算切れで残りは次ティックへ繰り越す。
 */
async function drainTasks(ctx: TickCtx, tasks: SendTask[]): Promise<void> {
  for (const t of tasks) {
    if (ctx.budget.n <= 0) return;
    const claimed = await claimSend(ctx.db, t.key);
    if (!claimed) continue; // 他ティックが処理済み/処理中
    ctx.budget.n--;
    let ok = false;
    try {
      ok = await t.run();
    } catch (e) {
      console.error(`[Send] ${t.key.kind} threw: ${(e as Error).message}`);
      ok = false;
    }
    await finishSend(ctx.db, t.key, ok, ok ? null : 'send failed');
    await sleep(DM_INTERVAL_MS);
  }
}

/**
 * ロール管理区分を Discord ロールから同期する（1 日 1 回/ギルド・config マーカーで冪等・ADR 0009）。
 * 取得失敗時は同期せず既存維持（マーカーを立てず次ティックで再試行）。
 */
async function ensureRoleSync(ctx: TickCtx, guildId: string): Promise<void> {
  const markerKey = `rolesync:${guildId}`;
  // マーカーはティック冒頭の config スナップショットで判定（開催回ごとに呼ばれても照会を打たない）。
  if (ctx.config[markerKey] === ctx.today) return;
  let members: GuildMemberSummary[];
  try {
    members = await listGuildMembers(ctx.env, guildId);
  } catch (e) {
    console.error(`[SegmentSync] members fetch failed (guild=${guildId}): ${(e as Error).message}`);
    return;
  }
  const segs = await listSegments(ctx.db, guildId);
  for (const seg of segs) {
    if (!seg.mention_role_id) continue;
    try {
      const r = await syncSegmentFromRole(ctx.env, seg, { allowEmpty: false, members });
      console.log(`[SegmentSync] seg=${seg.id} ${r.ok ? `+${r.added}/-${r.removed}` : 'skip: ' + r.message}`);
    } catch (e) {
      console.error(`[SegmentSync] seg=${seg.id} failed: ${(e as Error).message}`);
    }
  }
  await setConfig(ctx.db, markerKey, ctx.today);
  ctx.config[markerKey] = ctx.today; // 同ティック内の後続呼び出しもスキップさせる
  // メンバー取得（ページング）の subrequest を保守的に予算から控除（大規模は Paid 前提）。
  ctx.budget.n = Math.max(0, ctx.budget.n - 5);
}

/**
 * DM 付記用のサーバー名を解決する（1 日 1 回 listGuilds → config 永続化・rolesync と同型）。
 * 毎ティック Discord API を叩かないよう、名前一覧は config の 1 キーに日付付き JSON で持ち、
 * 日付が変わった最初の DM 送信時だけ再同期する。取得失敗時は前回同期の名前を使い続ける
 * （day 未更新のため次ティックで自然リトライ）。未解決の guild は '' を返す。
 */
export const GUILD_NAMES_KEY = 'guild_names';
export async function resolveGuildName(ctx: TickCtx, guildId: string): Promise<string> {
  let cached: { day?: string; names?: Record<string, string> } = {};
  try {
    cached = JSON.parse(ctx.config[GUILD_NAMES_KEY] || '{}');
  } catch {}
  if (cached.day !== ctx.today) {
    try {
      const guilds = await listGuilds(ctx.env);
      const names: Record<string, string> = {};
      for (const g of guilds) names[g.id] = g.name;
      cached = { day: ctx.today, names };
      const json = JSON.stringify(cached);
      await setConfig(ctx.db, GUILD_NAMES_KEY, json);
      ctx.config[GUILD_NAMES_KEY] = json; // 同ティック内の後続解決はスナップショットから読む
      ctx.budget.n = Math.max(0, ctx.budget.n - 1); // listGuilds の subrequest を予算から控除
    } catch (e) {
      console.error(`[GuildNames] fetch failed: ${(e as Error).message}`);
    }
  }
  return cached.names?.[guildId] || '';
}

/** 開催回の回答締切が到来しているか（ADR 0014）。 */
function deadlinePassed(n: Notification, occ: Occurrence, now: Date): boolean {
  const dl = responseDeadline(occ.occurrence_date, slotTime(occ, n), n.response_deadline_hours);
  return dl != null && now.getTime() >= dl.getTime();
}

/**
 * 締切告知の send_log キー。deadlinePassed は締切〜開催日まで毎ティック true になるため、
 * send_date に実行日(today)を使うと日付が変わるたび別キーになり再送される（2026-07-04 本番事故）。
 * 開催回の日付で固定し「開催回につき 1 回」を保証する。
 */
export function deadlineNoticeKey(n: Notification, occ: Occurrence): SendKey {
  return {
    notification_id: n.id,
    occurrence_id: occ.id,
    kind: 'deadline_notice',
    send_date: occ.occurrence_date,
  };
}

/**
 * 通知が daysUntil 日後の開催回に対して何か送りうるか（安価な事前判定）。
 * recurring の実体化判定と開催回ループの cheap-skip に使う（毎分実行の負荷を抑える）。
 * 募集は窓の途中で作られた臨時回にも出すため範囲判定（0..recruit_days_before）。
 */
export function inSendWindow(n: Notification, daysUntil: number): boolean {
  if (daysUntil < 0) return false;
  const announceOnly = isAnnounceOnly(n);
  const inRecruit = daysUntil <= n.recruit_days_before;
  const inUnanswered = !announceOnly && daysUntil <= n.remind_start_days;
  const inUndecided = !announceOnly && daysUntil === n.remind_undecided_days;
  const mayDeadline =
    !announceOnly && n.response_deadline_hours != null && daysUntil <= n.recruit_days_before;
  return inRecruit || inUnanswered || inUndecided || mayDeadline;
}

/**
 * 日次ロールフォワードの今ティックの処理範囲を決める（pure・マーカー形式の単一の解釈点）。
 * マーカー: 'YYYY/MM/DD'＝その日は完了 / 'YYYY/MM/DD:N'＝進行中（次は index N から）/
 * それ以外（別日・''・未設定）＝先頭から。完了済みなら null、未了なら [start,end) と
 * 処理後に書き戻す次マーカー（末尾まで達したら完了形）を返す。
 */
export function rollforwardWindow(
  marker: string | null | undefined,
  today: string,
  total: number,
  chunk: number,
): { start: number; end: number; next: string } | null {
  const [day, offset] = (marker ?? '').split(':');
  if (day === today && offset === undefined) return null; // 今日は完了済み
  const start = day === today ? Math.max(0, Math.min(Number(offset) || 0, total)) : 0;
  const end = Math.min(start + chunk, total);
  return { start, end, next: end >= total ? today : `${today}:${end}` };
}

/**
 * 1 通知の「今日の未送信分」をペース配信で処理する。
 * - oneoff: 従来どおり確定回 or 単一候補のみ対象（複数候補の募集は手動）。
 * - recurring: 未来の scheduled 開催回（臨時回を含む）を列挙し、RRULE の次回日は
 *   「その日付に行が 1 つも無い場合のみ」送信窓内で実体化して加える。
 *   同日付に行があるときは実体化しない: cancelled の墓石は配信停止として働き、
 *   時刻違いの scheduled 行（中止＋臨時追加による開催し直し）はそのまま対象になる。
 */
async function drainNotification(
  ctx: TickCtx,
  n: Notification,
  futureOccs: Occurrence[],
): Promise<void> {
  const { db } = ctx;
  if (n.type === 'oneoff') {
    // 単発: 確定回 or 単一候補のみリマインド対象（募集は手動・cron では送らない）。
    let occ: Occurrence | null = null;
    if (n.decided_occurrence_id != null) {
      const o = await getOccurrence(db, n.decided_occurrence_id);
      occ = o && o.status === 'scheduled' ? o : null;
    } else {
      const scheduled = await listScheduledOccurrences(db, n.id);
      if (scheduled.length === 1) occ = scheduled[0];
      else if (scheduled.length === 0 && n.one_off_date)
        occ = await getOrCreateOccurrence(db, n.id, n.one_off_date, n.start_time);
    }
    if (!occ || occ.status !== 'scheduled') return;
    await drainOccurrence(ctx, n, occ);
    return;
  }

  // recurring: 対象開催回の列挙。次回開催回の実体化は runTick の日次ロールフォワードで
  // 済ませてある（rrule 評価が重く毎ティック走らせられないため）。ここは実体化済みの行を処理する。
  const targets = futureOccs.filter((o) => o.status === 'scheduled');
  // 直近の回を優先して予算を使う（日付・時刻昇順）
  targets.sort((a, b) =>
    (a.occurrence_date + (a.start_time || '')).localeCompare(b.occurrence_date + (b.start_time || '')),
  );
  for (const occ of targets) {
    if (ctx.budget.n <= 0) return;
    if (!inSendWindow(n, getDaysUntil(occ.occurrence_date))) continue;
    await drainOccurrence(ctx, n, occ);
  }
}

/** 1 開催回の「今日の未送信分」をペース配信で処理する（recurring / oneoff 共通の送信本体）。 */
async function drainOccurrence(ctx: TickCtx, n: Notification, occ: Occurrence): Promise<void> {
  const { env, db, today, hour } = ctx;
  const announceOnly = isAnnounceOnly(n);
  const daysUntil = getDaysUntil(occ.occurrence_date);

  // --- (1) 締切告知（メンバー向け・締切時刻ゲート。send_hour に依存せず時刻ベースで独立発火・ADR 0014）---
  // 文面は固定（@メンションなし）だが、念のため allowed_mentions={parse:[]} で一切ピングしないことを保証。
  if (!announceOnly && deadlinePassed(n, occ, ctx.now)) {
    await drainTasks(ctx, [
      {
        key: deadlineNoticeKey(n, occ),
        run: () => sendChannelMessage(env, n.channel_id, deadlineNoticeMessage(n, occ), null, { parse: [] }),
      },
    ]);
  }

  // 以降（募集・ノルマ・リマインド）は送信時刻ゲート。時刻未到達なら今ティックは送らない。
  if (hour < n.send_hour) return;

  // メンバー基準の送信（募集の 'members' メンション含む）の前にロール同期する（1 日 1 回/ギルドで冪等）。
  // announce-only のみのギルドでもロール管理区分が同期されるよう、announce-only 判定の前に呼ぶ。
  await ensureRoleSync(ctx, n.guild_id);

  // --- (2) 募集（チャンネル投稿）---
  // recurring は窓判定（0..recruit_days_before）＋「開催回につき 1 回」（hasSentKind・send_date 無視）。
  // 窓の途中で作られた臨時回にも募集が出る。送信失敗（failed）は翌日以降に自然リトライされる。
  // oneoff は従来どおり当日一致のみ（複数候補の募集は手動運用）。
  const wantRecruit =
    n.type === 'recurring'
      ? daysUntil <= n.recruit_days_before && !(await hasSentKind(db, n.id, occ.id, 'recruit'))
      : daysUntil === n.recruit_days_before;
  if (wantRecruit) {
    await drainTasks(ctx, [
      {
        key: { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit', send_date: today },
        run: () => sendRecruitment(env, n, occ),
      },
    ]);
  }

  if (announceOnly) return; // 回答不要は以降（回答依存）対象外。

  // --- (3) ノルマ（recruit 当日・未送信分のみ）---
  if (n.quota_enabled && n.quota_interval_days && daysUntil === n.recruit_days_before && ctx.budget.n > 0) {
    const alerts = await checkQuotaForNotification(db, n);
    const guildName = await resolveGuildName(ctx, n.guild_id);
    await drainTasks(
      ctx,
      alerts.map((member) => ({
        key: { notification_id: n.id, user_id: member.user_id, kind: 'quota' as const, send_date: today },
        run: () => sendDirectMessageCached(env, db, member, quotaMessage(n, member, guildName)),
      })),
    );
  }

  // --- (4) 未回答リマインド（0<=daysUntil<=remind_start_days・当日は開始時刻前のみ）---
  if (daysUntil >= 0 && daysUntil <= n.remind_start_days && ctx.budget.n > 0) {
    let proceed = true;
    if (daysUntil === 0) {
      const [h, m] = slotTime(occ, n).split(':').map(Number);
      proceed = ctx.now.getHours() * 60 + ctx.now.getMinutes() < (h || 0) * 60 + (m || 0);
    }
    if (proceed) {
      const targets = await remainingUnansweredTargets(db, n.segment_id, occ.id, n.id, today, ctx.budget.n);
      const guildName = await resolveGuildName(ctx, n.guild_id);
      await drainTasks(
        ctx,
        targets.map((member) => ({
          key: { notification_id: n.id, occurrence_id: occ.id, user_id: member.user_id, kind: 'remind_unanswered' as const, send_date: today },
          run: () => sendDirectMessageCached(env, db, member, unansweredMessage(n, occ, daysUntil, guildName), createButtonComponents(occ.id, n.type)),
        })),
      );
    }
  }

  // --- (5) 未定リマインド（daysUntil===remind_undecided_days）---
  if (daysUntil === n.remind_undecided_days && ctx.budget.n > 0) {
    const targets = await remainingUndecidedTargets(db, n.segment_id, occ.id, n.id, today, ctx.budget.n);
    const guildName = await resolveGuildName(ctx, n.guild_id);
    await drainTasks(
      ctx,
      targets.map((member) => ({
        key: { notification_id: n.id, occurrence_id: occ.id, user_id: member.user_id, kind: 'remind_undecided' as const, send_date: today },
        run: () => sendDirectMessageCached(env, db, member, undecidedMessage(n, occ, guildName), createButtonComponents(occ.id, n.type)),
      })),
    );
  }
}

/**
 * cron ティック（毎分・ADR 0013 ペース配信）。送信時刻に達した通知の今日の未送信分を予算内で送る。
 * index.ts の scheduled ハンドラから毎分呼ばれる。
 */
export async function runTick(env: Env): Promise<void> {
  const now = getJSTNow();
  // config（数行の key/value）はティック冒頭に一括読みし、送信予算・ロールフォワード・
  // ロール同期マーカーの細切れ照会を 1 クエリに畳む。
  const config = await getAllConfig(env.DB);
  const ctx: TickCtx = {
    env,
    db: env.DB,
    now,
    today: formatDate(now),
    hour: now.getHours(),
    budget: { n: parseConfigInt(config[SEND_BUDGET_KEY], DEFAULT_SEND_BUDGET) },
    config,
  };
  // クラッシュ等で status='sending' のまま残った claim を回収（5分以上前）→ 再送可能にする。
  // 回収対象がそもそも「5分以上前」なので回収も 5 分粒度で足りる（毎分 DELETE を打たない）。
  if (now.getMinutes() % 5 === 0) {
    await clearStaleClaims(env.DB, new Date(Date.now() - 5 * 60_000).toISOString());
  }

  const notifications = await listActiveNotifications(env.DB);
  if (notifications.length === 0) return;

  // 未来の開催回（臨時回・中止の墓石を含む）を 1 クエリで一括取得して通知ごとに配る。
  // 通知ごとの個別照会を避け、毎分実行のクエリ数を通知数に比例させない。
  const futureByNotif = new Map<number, Occurrence[]>();
  for (const o of await listFutureOccurrencesAll(env.DB, ctx.today)) {
    const arr = futureByNotif.get(o.notification_id);
    if (arr) arr.push(o);
    else futureByNotif.set(o.notification_id, [o]);
  }

  // 日次ロールフォワード: recurring の次回開催回を rrule から実体化する（1 日 1 巡）。
  // rrule 評価は重く毎ティック全件は回せないため、1 ティック最大 ROLLFORWARD_CHUNK 件ずつ
  // 進め、マーカーに進捗を持たせる（kill・transient 失敗でも次ティックが続きから再開＝
  // 「マーカー未達で毎ティック全量リトライ→恒常超過」のスパイラルを構造的に防ぐ）。
  // 完了後のティックは実体化済み行を futureByNotif 経由で読むだけ＝rrule 評価ゼロ。
  // 通知の作成/編集時は admin 側がマーカーを '' にクリアし、次ティックから先頭をやり直す。
  const recurrings = notifications.filter((n) => n.type === 'recurring');
  const rf = rollforwardWindow(ctx.config[OCC_ROLLFORWARD_KEY], ctx.today, recurrings.length, ROLLFORWARD_CHUNK);
  if (rf) {
    recurrings.sort((a, b) => a.id - b.id); // チャンクの跨ティック整合のため順序を固定
    for (const n of recurrings.slice(rf.start, rf.end)) {
      try {
        const existing = futureByNotif.get(n.id) ?? [];
        const ruleDate = nextOccurrenceDate(n);
        // 同日付に行がある（scheduled でも cancelled の墓石でも）場合は実体化しない。
        if (ruleDate && !existing.some((o) => o.occurrence_date === ruleDate) && inSendWindow(n, getDaysUntil(ruleDate))) {
          existing.push(await getOrCreateOccurrence(env.DB, n.id, ruleDate, n.start_time));
          futureByNotif.set(n.id, existing); // 同ティックの送信ループでも拾えるよう反映
        }
      } catch (e) {
        // 1 件の失敗（D1 transient 等）で巡回全体を止めない。翌日/マーカークリアで自己回復。
        console.error(`[Rollforward] n=${n.id} failed: ${(e as Error).message}`);
      }
    }
    await setConfig(env.DB, OCC_ROLLFORWARD_KEY, rf.next);
  }

  // 予算切れ時の公平性: ティック番号で開始位置をローテートし、特定通知の優先固定を避ける
  //（通知数 > 60 でも全件が順に先頭へ回る）。
  const start = Math.floor(now.getTime() / 60000) % notifications.length;
  const ordered = [...notifications.slice(start), ...notifications.slice(0, start)];

  for (const n of ordered) {
    if (ctx.budget.n <= 0) break;
    try {
      await drainNotification(ctx, n, futureByNotif.get(n.id) ?? []);
    } catch (e) {
      console.error(`[Tick] n=${n.id} failed: ${(e as Error).message}`);
    }
  }
}
