import type { Env } from '../env';
import type { Notification, Occurrence, QuotaAlert, Segment } from '../db/types';
import { isAnnounceOnly, resolveDisplayName } from '../db/types';
import { listActiveNotifications } from '../db/notifications';
import { getOrCreateOccurrence, listFutureOccurrencesAll } from '../db/occurrences';
import {
  checkQuotaForNotification,
  remainingUnansweredTargets,
  remainingUndecidedTargets,
} from '../db/responses';
import { getActiveSegmentMembers, getSegment, listSegments } from '../db/segments';
import {
  claimSend,
  finishSend,
  clearStaleClaims,
  hasSentKind,
  reclaimFailedSend,
  reclaimSentSend,
  type SendKey,
} from '../db/sendLog';
import {
  getAllConfig,
  setConfig,
  parseConfigInt,
  SEND_BUDGET_KEY,
  DEFAULT_SEND_BUDGET,
  OCC_ROLLFORWARD_KEY,
} from '../db/config';
import { syncSegmentFromRole } from '../discord/syncSegment';
import { occurrenceDatesBetween } from '../lib/recurrence';
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
  buildMentionPrefix,
  composePost,
  listGuildMembers,
  listGuilds,
  answerLabels,
  DISCORD_CONTENT_LIMIT,
  type GuildMemberSummary,
} from '../discord/rest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DM_INTERVAL_MS = 300;

// 日次ロールフォワードで 1 ティックに rrule 評価する定期スケジュール（rrule あり）の最大件数。
// rrule は ~1ms/回（dtstart 整列後）× Workers Free の CPU 10ms 律速のため、1 ティックに
// 全件は回せない。kill されても次ティックが同じチャンクから再開する（マーカーで進捗管理）。
// ponytail: 8件/分＝定期 数百件で実体化完了に約1時間。その規模は Paid 前提で要再設計。
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
  const components = isAnnounceOnly(n) ? null : createButtonComponents(occ.id);
  const ok = await sendChannelMessage(env, n.channel_id, message, components, allowedMentionsFor(n, segment));
  console.log(ok ? `✅ [Recruitment] sent (n=${n.id})` : `❌ [Recruitment] failed (n=${n.id})`);
  return ok;
}

/** 「今すぐ募集/告知」の結果。already_sent = その開催回は送信済み（または送信中）で claim できなかった。 */
export type RecruitNowResult = 'sent' | 'already_sent' | 'failed';

/**
 * 開催回 1 件を今すぐ募集/告知する。管理画面「今すぐ募集」（POST /occurrences/:id/recruit）と
 * Discord の /notify が共用する唯一の経路（2026-08-23 集約。旧 recruitNotificationNow は
 * 「次回」を暗黙に選び send_log も書かなかったため、開催回タブの表示や cron の自動募集と食い違っていた）。
 * send_log に claim/finish を記録し、cron の窓内自動募集（hasSentKind 照合）・開催回タブの「投稿済み」と同じ真実を持つ。
 * - 新規 claim できなければ、失敗で終わった同日 claim を取り直す（当日中の手動リトライを許す）
 * - force=true は sent も取り直して再送する（UI の確認ダイアログ了承後のみ。/notify は使わない）
 * - sending（送信中）だけはどちらでも取り直せない＝並行実行の二重送信ガード
 */
export async function recruitOccurrenceNow(
  env: Env,
  n: Notification,
  occ: Occurrence,
  opts: { force?: boolean } = {},
): Promise<RecruitNowResult> {
  const db = env.DB;
  const key: SendKey = { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit', send_date: formatDate(getJSTNow()) };
  const claimed =
    (await claimSend(db, key)) ||
    (await reclaimFailedSend(db, key)) ||
    (opts.force === true && (await reclaimSentSend(db, key)));
  if (!claimed) return 'already_sent';
  const ok = await sendRecruitment(env, n, occ);
  await finishSend(db, key, ok, ok ? null : 'manual send failed');
  return ok ? 'sent' : 'failed';
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
  const L = answerLabels();
  return (
    `⏰ **リマインド: ${dayText}のイベント**${guildSuffix(guildName)}\n\n` +
    `日時: **${slotLabel(occ, n)}**\n\n` +
    `まだ回答されていません。下のボタンで${L.participate}/${L.absent}を回答してください!`
  );
}

/** 未定者リマインド DM 文面 */
function undecidedMessage(n: Notification, occ: Occurrence, guildName: string): string {
  const L = answerLabels();
  return (
    `❓ **未定者へのリマインド**${guildSuffix(guildName)}\n\n` +
    `日時: **${slotLabel(occ, n)}**\n\n` +
    `現在「${L.undecided}」で回答されています。下のボタンで${L.participate}/${L.absent}を確定してください!`
  );
}

/** 回答締切の到来告知（メンバー向け・募集チャンネルへ追従投稿・ADR 0014） */
function deadlineNoticeMessage(n: Notification, occ: Occurrence): string {
  return (
    `⏰ **回答を締め切りました**（${slotLabel(occ, n)}）\n` +
    `以降に回答を変更すると、管理者に記録・通知されます。`
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

// 締切告知の跨日デデュープは募集と同じ hasSentKind（send_date 無視・「開催回につき 1 回」）で行う。
// 旧方式（send_date=開催日で固定するキー・2026-07-04 事故対応）は撤去済み。hasSentKind は
// 旧キーで記録済みの行にもヒットするため、方式変更を跨いでも再送しない。send_date には実送信日を記録する。

/**
 * 通知が daysUntil 日後の開催回に対して何か送りうるか（安価な事前判定）。
 * ルール回の実体化判定と開催回ループの cheap-skip に使う（毎分実行の負荷を抑える）。
 * 募集は窓の途中で作られた臨時回にも出すため範囲判定（0..recruit_days_before）。
 */
export function inSendWindow(n: Notification, daysUntil: number): boolean {
  if (daysUntil < 0) return false;
  const announceOnly = isAnnounceOnly(n);
  const inRecruit = !!n.recruit_enabled && daysUntil <= n.recruit_days_before;
  const inUnanswered = !announceOnly && !!n.remind_unanswered_enabled && daysUntil <= n.remind_start_days;
  const inUndecided = !announceOnly && !!n.remind_undecided_enabled && daysUntil === n.remind_undecided_days;
  // 締切あり ⇒ 定期 ⇒ 募集自動（recruit_enabled=1）が DB の不変条件（migration 0025・admin 正規化）。
  // 締切告知の監視窓は募集窓に含まれる（E3 で締切は募集より後に限定済み）。
  const mayDeadline = !announceOnly && n.response_deadline_hours != null && daysUntil <= n.recruit_days_before;
  return inRecruit || inUnanswered || inUndecided || mayDeadline;
}

/** 送信窓の最遠日数（何日先の開催回まで何か送りうるか）。窓内実体化の範囲。OFF の工程は数えない。 */
export function maxWindowDays(n: Notification): number {
  const announceOnly = isAnnounceOnly(n);
  const recruit = n.recruit_enabled ? n.recruit_days_before : 0;
  const unanswered = !announceOnly && n.remind_unanswered_enabled ? n.remind_start_days : 0;
  const undecided = !announceOnly && n.remind_undecided_enabled ? n.remind_undecided_days : 0;
  return Math.max(0, recruit, unanswered, undecided);
}

/**
 * 日次ロールフォワードで実体化すべきルール日付（pure）。送信窓内の全ルール回のうち、同日付に行が
 * 1 つも無い（scheduled でも cancelled の墓石でもない）日付だけ。ADR 0023 追補の「未来分の事前作成は
 * しない」は「送信窓の外は作らない」と読み替える（docs/dev/schedule-recurrence-redesign.md §5.3）。
 */
export function ruleDatesToMaterialize(
  n: Notification,
  existingDates: Iterable<string>,
  now: Date = getJSTNow(),
): string[] {
  const taken = new Set(existingDates);
  return occurrenceDatesBetween(n, maxWindowDays(n), now).filter(
    (d) => !taken.has(d) && inSendWindow(n, getDaysUntil(d, now)),
  );
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
 * 未来の scheduled 開催回（ルール由来・臨時回・不定期の手動回）を列挙して窓内のものを送る。
 * ルール回の実体化は runTick の日次ロールフォワードで済ませてある（rrule 評価が重く毎ティック
 * 走らせられないため）。ここは実体化済みの行を処理する。cancelled の墓石は対象外＝配信停止として働く。
 */
async function drainNotification(
  ctx: TickCtx,
  n: Notification,
  futureOccs: Occurrence[],
): Promise<void> {
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

/** 1 開催回の「今日の未送信分」をペース配信で処理する（送信本体）。 */
async function drainOccurrence(ctx: TickCtx, n: Notification, occ: Occurrence): Promise<void> {
  const { env, db, today, hour } = ctx;
  const announceOnly = isAnnounceOnly(n);
  const daysUntil = getDaysUntil(occ.occurrence_date);

  // --- (1) 締切告知（メンバー向け・締切時刻ゲート。send_hour に依存せず時刻ベースで独立発火・ADR 0014）---
  // 文面は固定（@メンションなし）だが、念のため allowed_mentions={parse:[]} で一切ピングしないことを保証。
  // deadlinePassed は締切〜開催日まで毎ティック true のため、hasSentKind で「開催回につき 1 回」に抑える。
  // send_date=実送信日で記録。失敗（failed）は hasSentKind が数えないが、当日中は failed 行が
  // claim の UNIQUE キーを塞ぐため、再送は翌日以降（募集と同じ。開催日当日の失敗はリトライされない）。
  if (
    !announceOnly &&
    deadlinePassed(n, occ, ctx.now) &&
    !(await hasSentKind(db, n.id, occ.id, 'deadline_notice'))
  ) {
    await drainTasks(ctx, [
      {
        key: { notification_id: n.id, occurrence_id: occ.id, kind: 'deadline_notice', send_date: today },
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
  // 窓判定（0..recruit_days_before）＋「開催回につき 1 回」（hasSentKind・send_date 無視）。
  // 窓の途中で作られた臨時回にも募集が出る。送信失敗（failed）は翌日以降に自然リトライされる。
  // recruit_enabled=0（手動投稿・ADR 0026）は自動では出さない（📣 今すぐ募集／/notify は sendRecruitNow 経由で別）。
  if (n.recruit_enabled && daysUntil <= n.recruit_days_before && !(await hasSentKind(db, n.id, occ.id, 'recruit'))) {
    await drainTasks(ctx, [
      {
        key: { notification_id: n.id, occurrence_id: occ.id, kind: 'recruit', send_date: today },
        run: () => sendRecruitment(env, n, occ),
      },
    ]);
  }

  if (announceOnly) return; // 回答不要は以降（回答依存）対象外。

  // --- (3) ノルマ（recruit 当日・未送信分のみ。募集が手動なら「募集当日」が無いので送らない・UI で案内）---
  if (n.recruit_enabled && n.quota_enabled && n.quota_interval_days && daysUntil === n.recruit_days_before && ctx.budget.n > 0) {
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

  // --- (4) 未回答リマインド（0<=daysUntil<=remind_start_days・当日は開始時刻前のみ。OFF なら送らない）---
  // 締切が来たら催促も止める（B1・flow-settings-spec §4）。回答ボタン自体は締切後も押せる（ソフトロック・ADR 0014）。
  if (
    n.remind_unanswered_enabled &&
    daysUntil >= 0 &&
    daysUntil <= n.remind_start_days &&
    !deadlinePassed(n, occ, ctx.now) &&
    ctx.budget.n > 0
  ) {
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
          run: () => sendDirectMessageCached(env, db, member, unansweredMessage(n, occ, daysUntil, guildName), createButtonComponents(occ.id)),
        })),
      );
    }
  }

  // --- (5) 未定リマインド（daysUntil===remind_undecided_days。OFF なら送らない。締切後は送らない＝B1）---
  if (n.remind_undecided_enabled && daysUntil === n.remind_undecided_days && !deadlinePassed(n, occ, ctx.now) && ctx.budget.n > 0) {
    const targets = await remainingUndecidedTargets(db, n.segment_id, occ.id, n.id, today, ctx.budget.n);
    const guildName = await resolveGuildName(ctx, n.guild_id);
    await drainTasks(
      ctx,
      targets.map((member) => ({
        key: { notification_id: n.id, occurrence_id: occ.id, user_id: member.user_id, kind: 'remind_undecided' as const, send_date: today },
        run: () => sendDirectMessageCached(env, db, member, undecidedMessage(n, occ, guildName), createButtonComponents(occ.id)),
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

  // 日次ロールフォワード: 定期スケジュール（rrule あり）の送信窓内の全ルール回を origin='rule' で実体化する
  // （1 日 1 巡）。rrule 評価は重く毎ティック全件は回せないため、1 ティック最大 ROLLFORWARD_CHUNK 件ずつ
  // 進め、マーカーに進捗を持たせる（kill・transient 失敗でも次ティックが続きから再開＝
  // 「マーカー未達で毎ティック全量リトライ→恒常超過」のスパイラルを構造的に防ぐ）。
  // 完了後のティックは実体化済み行を futureByNotif 経由で読むだけ＝rrule 評価ゼロ。
  // 通知の作成/編集時は admin 側がマーカーを '' にクリアし、次ティックから先頭をやり直す。
  // 不定期（rrule NULL）は評価対象外＝運用者が追加した行だけが futureByNotif に載る。
  const ruled = notifications.filter((n) => n.rrule);
  const rf = rollforwardWindow(ctx.config[OCC_ROLLFORWARD_KEY], ctx.today, ruled.length, ROLLFORWARD_CHUNK);
  if (rf) {
    ruled.sort((a, b) => a.id - b.id); // チャンクの跨ティック整合のため順序を固定
    for (const n of ruled.slice(rf.start, rf.end)) {
      try {
        const existing = futureByNotif.get(n.id) ?? [];
        // 同日付に行がある（scheduled でも cancelled の墓石でも）日付は実体化しない。
        for (const d of ruleDatesToMaterialize(n, existing.map((o) => o.occurrence_date), now)) {
          existing.push(await getOrCreateOccurrence(env.DB, n.id, d, n.start_time, 'rule'));
        }
        futureByNotif.set(n.id, existing); // 同ティックの送信ループでも拾えるよう反映
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
