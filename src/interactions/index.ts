import type { Env } from '../env';
import pkg from '../../package.json';

// ponytail: (d) discord-interactions の verifyKey と enum を Workers ネイティブの Web Crypto + const で置換。
// Cloudflare Workers (workerd) は crypto.subtle.importKey('raw', ..., { name: 'Ed25519' }, ...) と
// crypto.subtle.verify('Ed25519', ...) を 2023 年以降サポート済み。
const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 } as const;
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

const HEX_RE = /^[0-9a-f]+$/i;
function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !HEX_RE.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Discord Interaction 署名（Ed25519）を Web Crypto で検証する。失敗・例外はすべて false 扱い。 */
export async function verifyEd25519(
  rawBody: string,
  signatureHex: string,
  timestamp: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex), data);
  } catch {
    return false;
  }
}

import { ensureMember, updateMemberDisplayName } from '../db/members';
import { getNotification, listNotificationsByChannel } from '../db/notifications';
import { getOccurrence, getOrCreateOccurrence, hasCancelledOccurrenceOnDate, listScheduledOccurrences } from '../db/occurrences';
import { getSegment, addSegmentMember, getSegmentMemberStatus } from '../db/segments';
import { upsertResponse, getResponseStatus, getStatusBuckets } from '../db/responses';
import { API, USER_AGENT, buildStatusMessage, sendChannelMessage, answerLabels } from '../discord/rest';
import { roleGateAllows } from '../discord/syncSegment';
import { formatDate, formatOccurrenceLabel, responseDeadline, getJSTNow } from '../lib/date';
import { nextOccurrenceDates } from '../lib/recurrence';
import { hasSentKind } from '../db/sendLog';
import { isAnnounceOnly, type Notification } from '../db/types';
import { recruitOccurrenceNow } from '../cron/tick';

const EPHEMERAL = 64;

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string;
}

interface DiscordInteraction {
  type: number;
  /** deferred 応答後の PATCH @original（webhook 経路）に使う。全インタラクションに同梱される */
  application_id: string;
  token: string;
  data?: {
    name?: string;
    custom_id?: string;
    /** String Select で選ばれた値（custom_id で部品を判別する） */
    values?: string[];
    options?: { name: string; value: string | number; type: number }[];
    resolved?: {
      users?: Record<string, DiscordUser>;
      members?: Record<string, { nick?: string }>;
    };
  };
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser; nick?: string; roles?: string[] };
  user?: DiscordUser;
}

type InteractionResponse = {
  type: number;
  data?: { content: string; flags?: number; components?: unknown[] };
};

function ephemeral(content: string): InteractionResponse {
  return { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * deferred 応答の後から結果を書き込む（PATCH @original）。
 * webhook 経路のため Bot トークン不要（interaction token が認可を兼ねる）。
 * ephemeral フラグは deferred 応答側で確定済みのため content/components のみ送る。
 */
async function patchOriginal(
  interaction: DiscordInteraction,
  res: InteractionResponse,
): Promise<void> {
  const url = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      content: res.data?.content ?? '',
      components: res.data?.components ?? [],
    }),
  });
  if (!r.ok) {
    console.error('[Interaction] patch @original failed:', r.status, await r.text());
  }
}

const STATUS_MAP: Record<string, string> = {
  participate: '参加',
  absent: '不参加',
  undecided: '未定',
};

/** POST /interactions のエントリ */
export async function handleInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const rawBody = await request.text();

  if (!signature || !timestamp) {
    return json({ error: 'Missing signature headers' }, 401);
  }

  const valid = await verifyEd25519(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!valid) {
    return json({ error: 'Invalid request signature' }, 401);
  }

  const interaction = JSON.parse(rawBody) as DiscordInteraction;
  const origin = new URL(request.url).origin;

  // PING
  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  // スラッシュコマンド
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return json(await handleCommand(interaction, env, origin));
  }

  // ボタン: D1 直列クエリ＋遅延スパイクで Discord の 3 秒制限を超えることがあるため、
  // deferred (type 5・ephemeral) を即返しし、実処理は waitUntil で継続 → 結果を PATCH @original で書き込む。
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    ctx.waitUntil(
      handleButton(interaction, env, ctx)
        .catch((e) => {
          console.error('[Button] unhandled error:', (e as Error).message);
          return ephemeral('❌ 処理に失敗しました。もう一度お試しください。');
        })
        .then((res) => patchOriginal(interaction, res))
        .catch((e) => console.error('[Button] patch @original failed:', (e as Error).message)),
    );
    return json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: EPHEMERAL },
    });
  }

  return json(ephemeral('このインタラクションはサポートされていません'));
}

async function handleCommand(
  interaction: DiscordInteraction,
  env: Env,
  origin: string,
): Promise<InteractionResponse> {
  const name = interaction.data?.name;

  try {
    switch (name) {
      case 'notify':
        return await handleNotify(interaction, env);

      case 'help':
        return handleHelp();

      case 'manage':
        return handleManage(origin);

      default:
        return ephemeral('❌ 不明なコマンドです');
    }
  } catch (e) {
    console.error(`[Command] /${name} error:`, (e as Error).message);
    return ephemeral('❌ 処理に失敗しました。管理者に連絡してください。');
  }
}

/** Discord ボタン label の上限(80字)に合わせて長い通知名を省略する。 */
function truncateLabel(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** /notify の開催回選択 String Select の custom_id（選んだ値は data.values に入る）。 */
const NOTIFY_SELECT_ID = 'notifyocc';
/** Discord String Select の options 上限。 */
const NOTIFY_OPTION_LIMIT = 25;
/** 未実体化の予定回をスケジュールごとに何回先まで候補に出すか（直近が投稿済みでもその次を選べるように 2）。 */
const NOTIFY_PLAN_AHEAD = 2;

/**
 * /notify — このチャンネルのスケジュールについて「まだ投稿していない予定回」を日付順に一覧化し、
 * String Select で 1 回選ばせる（ephemeral）。候補＝実体化済みの予定回（status=scheduled・今日以降・未投稿）
 * ＋各スケジュールの次回 NOTIFY_PLAN_AHEAD 件（RRULE 導出・未実体化・中止の墓石は除く）。一覧表示では実体化しない。
 * 選択時は handleNotifyPick が実体化（upsert）→ recruitOccurrenceNow（管理画面の開催回タブ「今すぐ募集」と同じ経路）。
 */
async function handleNotify(
  interaction: DiscordInteraction,
  env: Env,
): Promise<InteractionResponse> {
  const channelId = interaction.channel_id;
  if (!channelId) return ephemeral('❌ チャンネルを特定できません。');
  const db = env.DB;
  const list = await listNotificationsByChannel(db, channelId);
  if (list.length === 0) {
    return ephemeral('❌ このチャンネルに紐づくスケジュールがありません。管理画面で作成してください。');
  }
  const today = formatDate(getJSTNow());
  const opts: { n: Notification; date: string; time: string }[] = [];
  // ponytail: スケジュール数 ×（一覧 1 ＋ 未来回ごとの hasSentKind ＋ 次回ごとの墓石照合）の直列 D1 クエリ。
  // チャンネルあたり数件想定で 3 秒制限に十分収まる。増えたら hasSentKind の一括化か deferred 応答へ。
  for (const n of list) {
    const scheduled = await listScheduledOccurrences(db, n.id);
    const taken = new Set(scheduled.map((o) => o.occurrence_date));
    for (const o of scheduled) {
      if (o.occurrence_date < today) continue;
      if (await hasSentKind(db, n.id, o.id, 'recruit')) continue;
      opts.push({ n, date: o.occurrence_date, time: o.start_time || n.start_time });
    }
    for (const d of nextOccurrenceDates(n, NOTIFY_PLAN_AHEAD)) {
      if (taken.has(d) || (await hasCancelledOccurrenceOnDate(db, n.id, d))) continue;
      opts.push({ n, date: d, time: n.start_time });
    }
  }
  if (opts.length === 0) {
    return ephemeral(
      'ℹ️ このチャンネルのスケジュールに、いま投稿できる予定回がありません（すべて投稿済みか中止です）。再送は管理画面の「開催回」から行えます。',
    );
  }
  opts.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const shown = opts.slice(0, NOTIFY_OPTION_LIMIT);
  const omitted = opts.length - shown.length;
  const note = omitted > 0 ? `\n…ほか ${omitted} 件は表示上限のため省略しています。` : '';
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `📨 **投稿する開催回を選んでください**${note}`,
      flags: EPHEMERAL,
      components: [
        {
          type: 1,
          components: [
            {
              type: 3, // String Select
              custom_id: NOTIFY_SELECT_ID,
              placeholder: '開催回を選ぶ',
              options: shown.map((o) => ({
                label: truncateLabel(formatOccurrenceLabel(o.date, o.time, o.n.duration_minutes), 100),
                description: truncateLabel(`${o.n.name}${isAnnounceOnly(o.n) ? '（告知）' : ''}`, 100),
                value: `${o.n.id}:${o.date}:${o.time}`,
              })),
            },
          ],
        },
      ],
    },
  };
}

/**
 * /notify の開催回選択（String Select）: value = notificationId:YYYY/MM/DD:HH:MM。
 * 実体化（upsert・中止の墓石ならそのまま拒否）→ recruitOccurrenceNow。
 * 投稿済みは再送しない（確認ダイアログの無い Discord に force の道は作らない・再送は管理画面から）。
 */
async function handleNotifyPick(
  interaction: DiscordInteraction,
  env: Env,
): Promise<InteractionResponse> {
  const m = (interaction.data?.values?.[0] ?? '').match(/^(\d+):(\d{4}\/\d{2}\/\d{2}):(\d{2}:\d{2})$/);
  if (!m) return ephemeral('❌ 不正なインタラクションです');
  const n = await getNotification(env.DB, Number(m[1]));
  if (!n) return ephemeral('❌ 対象のスケジュールが見つかりません。');
  if (n.channel_id !== interaction.channel_id) {
    return ephemeral('❌ このチャンネル外のスケジュールには投稿できません。');
  }
  // 仮想行（RRULE 導出）の実体化は origin='rule'（既存行ならそのまま返るので manual 行の由来は変わらない）。
  const occ = await getOrCreateOccurrence(env.DB, n.id, m[2], m[3], 'rule');
  const noun = isAnnounceOnly(n) ? '告知' : '募集';
  const label = `**${formatOccurrenceLabel(occ.occurrence_date, occ.start_time || n.start_time, n.duration_minutes)}**（${n.name}）`;
  if (occ.status !== 'scheduled') return ephemeral(`❌ ${label}は中止されているため${noun}できません。`);
  const r = await recruitOccurrenceNow(env, n, occ);
  if (r === 'sent') return ephemeral(`✅ ${label}の${noun}メッセージを投稿しました`);
  if (r === 'already_sent') {
    return ephemeral(`ℹ️ ${label}の${noun}は投稿済み（または送信中）です。再送する場合は管理画面の「開催回」から行ってください。`);
  }
  return ephemeral(`❌ ${noun}メッセージの投稿に失敗しました（文字数超過や Discord エラーの可能性）。`);
}

/** /help — エンドユーザー向けの使い方ガイドを ephemeral で返す */
function handleHelp(): InteractionResponse {
  const content = [
    '📖 **イベント出欠Bot — 使い方ガイド**',
    `_バージョン v${pkg.version}_`,
    '',
    'このサーバーで **イベントの告知と出欠集計** を行う Bot です。',
    'イベントの開催情報をチャンネルに自動で投稿し、あなたは **ボタンを押すだけ** で参加/不参加を伝えられます。',
    '出欠を取らない「告知のみ」の投稿もあり、回答ボタンが無い投稿はそのままお知らせとしてご覧ください。',
    '未回答のまま放置すると、開催日が近づいたタイミングで DM にリマインドが届きます。',
    '',
    '━━━━━━━━━━━━━━━━━',
    '**■ 回答の仕方**',
    '',
    '募集メッセージの下のボタンを押すだけです。',
    '',
    '・**参加** … 参加できる',
    '・**不参加** … 参加できない',
    '・**未定** … まだ分からない（あとで確定する想定）',
    '・**📊 状況確認** … 今みんなの回答状況を一覧表示（自分にだけ見えます）',
    '',
    '単発イベントの日程調整では、ラベルが **可 / 不可 / 未確定** に切り替わります。',
    '複数の候補日が同時に出ているときは、**都合のつく候補すべてに「可」を選べます**。',
    '',
    '━━━━━━━━━━━━━━━━━',
    '**■ よくある質問**',
    '',
    '**Q. 一度押した回答は変えられますか?**',
    '→ はい、何度でも押し直せます。最後に押した内容が記録されます。',
    '',
    '**Q. 自分の回答は他の人に見えますか?**',
    '→ はい。「📊 状況確認」ボタンで誰でも参加/不参加/未定/未回答の一覧を見られます。',
    '押した瞬間の **「✅ 参加 で記録しました!」** などの確認メッセージは自分にしか表示されません。',
    '',
    '**Q. 回答締切ってなんですか?**',
    '→ 募集メッセージに **回答締切: YYYY/MM/DD HH:MM** と書かれていれば、その時刻までの回答が想定されています。',
    '時刻が来るとチャンネルで「⏰ 回答を締め切りました」と告知されます。',
    '締切後も回答や変更はできますが、その場合は **管理者へ自動で通知が飛びます**(記録も残ります)。',
    '締切前に決めておくのが無難です。',
    '',
    '**Q. 「未定」と「不参加」の違いは?**',
    '→ **不参加** は「行かないと決めた」。**未定** は「行けるか分からない」。',
    '「未定」のまま日が近づくと、「そろそろ参加/不参加を確定してください」という DM が届くことがあります。',
    '',
    '**Q. DM が届いたんですが、これは何?**',
    '→ 3 種類のうちのどれかです。いずれも DM 内のボタンでそのまま回答できます。',
    '・**⏰ リマインド: ○日のイベント** … まだ未回答です。回答をお願いします。',
    '・**❓ 未定者へのリマインド** … 「未定」のままなので確定してほしい、という案内です。',
    '・**📊 参加間隔の確認** … 前回参加から間が空いている方への、次回参加検討の案内です。',
    '',
    '**Q. ボタンを押したら「対象ではない」「休止中」と言われました**',
    '→ **対象ではない**: その募集は特定のロール宛てで、あなたがそのロールを持っていません。管理者に相談してください。',
    '**休止中**: 管理者があなたを休止扱いに設定しています。解除も管理者側の操作です。',
    '',
    '**Q. ニックネームを変えたら反映されますか?**',
    '→ 次にボタンを押した時点で自動更新されます。特別な操作は不要です。',
    '',
    '**Q. 事前登録は必要ですか?**',
    '→ 不要です。初めて回答ボタンを押した瞬間に、自動でメンバー登録されます。',
    '',
    '━━━━━━━━━━━━━━━━━',
    '**■ 困ったときは**',
    '',
    '管理者にご相談ください。',
  ].join('\n');
  return ephemeral(content);
}

/** /manage — 管理画面の URL を ephemeral で返す（管理者のみ） */
function handleManage(origin: string): InteractionResponse {
  const content = [
    '🔧 **管理画面**',
    '',
    `${origin}/`,
    '',
    'ブラウザで開いて **ADMIN_TOKEN** でログインしてください。',
  ].join('\n');
  return ephemeral(content);
}

async function handleButton(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<InteractionResponse> {
  const db = env.DB;
  const customId = interaction.data?.custom_id;
  const user = interaction.member?.user || interaction.user;
  if (!customId || !user) return ephemeral('❌ 不正なインタラクションです');

  // /notify の開催回選択（String Select）。custom_id は固定で {action}_{id} 形式ではないため先に分岐する
  if (customId === NOTIFY_SELECT_ID) return handleNotifyPick(interaction, env);

  const userId = user.id;
  const userName = user.username ?? '';
  const displayName = interaction.member?.nick || user.global_name || userName;

  // custom_id 形式: {action}_{occurrenceId}
  const sep = customId.lastIndexOf('_');
  const action = sep >= 0 ? customId.slice(0, sep) : customId;
  const occurrenceId = sep >= 0 ? Number(customId.slice(sep + 1)) : NaN;
  if (!Number.isInteger(occurrenceId)) return ephemeral('❌ 不正なインタラクションです');

  // 旧 oneoff（日程調整）の「全候補の状況」集約ボタン（statusall）は oneoff 廃止（2026-08-23）で撤去。
  // 過去メッセージのボタンは下の「不明なアクション」に落ちる。

  // 状況確認（1スロット）
  if (action === 'status') {
    try {
      const occ = await getOccurrence(db, occurrenceId);
      if (!occ) return ephemeral('❌ 対象の開催回が見つかりません。');
      const n = await getNotification(db, occ.notification_id);
      if (!n) return ephemeral('❌ 対象のスケジュールが見つかりません。');
      const buckets = await getStatusBuckets(db, occ.id, n.segment_id);
      const title = formatOccurrenceLabel(occ.occurrence_date, occ.start_time || n.start_time, n.duration_minutes);
      const mine = await getResponseStatus(db, occ.id, userId);
      return ephemeral(buildStatusMessage(title, buckets, mine));
    } catch (e) {
      console.error('[Button] status error:', (e as Error).message);
      return ephemeral('❌ 状況確認に失敗しました。');
    }
  }

  const status = STATUS_MAP[action];
  if (!status) return ephemeral('❌ 不明なアクションです');

  try {
    const occ = await getOccurrence(db, occurrenceId);
    if (!occ) return ephemeral('❌ 対象の開催回が見つかりません。');
    // 中止（単発の候補落ち含む）の回は回答を受け付けない。
    if (occ.status === 'cancelled') {
      return ephemeral('⛔ この開催回は中止（または候補から除外）されたため、回答できません。');
    }
    const n = await getNotification(db, occ.notification_id);
    if (!n) return ephemeral('❌ 対象のスケジュールが見つかりません。');

    // ロール管理区分はロールゲートで判定（@everyone は全員可・ADR 0009）。
    // ギルド内ボタンは member.roles が同梱される（追加API不要）。DM のリマインド回答は member 不在の
    // ためロール判定をスキップし、後段の所属/休止チェックに委ねる（roleGateAllows）。
    const segment = await getSegment(db, n.segment_id);
    const memberRoles = interaction.member ? (interaction.member.roles ?? []) : undefined;
    if (segment && !roleGateAllows(segment.mention_role_id, memberRoles)) {
      return ephemeral('🚫 この募集の対象（指定ロールの保有者）ではないため、回答できません。');
    }

    // メンバーマスタへ自動登録（無ければ）
    await ensureMember(db, userId, userName, displayName).catch((e) =>
      console.error('[Button] ensureMember failed:', (e as Error).message),
    );

    // 区分への自動所属（既存なら no-op、status は維持）。ロール管理区分でも保有者なら整合する。
    await addSegmentMember(db, { id: n.segment_id, guild_id: n.guild_id }, userId);

    // 休止中なら回答拒否（全員一覧ではなく自分の 1 行だけ引く）
    const myStatus = await getSegmentMemberStatus(db, n.segment_id, userId);
    if (myStatus) {
      return ephemeral(
        `⏸️ あなたは現在「${myStatus}」に設定されているため、回答できません。\n解除はサーバーの管理者に依頼してください。`,
      );
    }

    // 回答締切（ADR 0014）: 締切後の変更（未回答→回答の初回を含む）を検知し、印を残して管理者へ通知。
    const L = answerLabels();
    const shown = (s: string) =>
      ({ 参加: L.participate, 不参加: L.absent, 未定: L.undecided })[s] ?? s;
    const oldStatus = await getResponseStatus(db, occ.id, userId);
    const dl = responseDeadline(occ.occurrence_date, occ.start_time || n.start_time, n.response_deadline_hours);
    // 回答不要(announce-only)は締切対象外（response_deadline_hours も null だが二重で守る）。
    const postDeadlineChange =
      !!n.requires_response && dl != null && getJSTNow().getTime() >= dl.getTime() && status !== oldStatus;

    await upsertResponse(db, occ.id, userId, userName, status, postDeadlineChange);

    if (postDeadlineChange) {
      // 変更通知（メンションなし・change_alert_channel_id / 未指定は投稿チャンネル）。
      // 応答を遅らせないよう投げっぱなし（ctx.waitUntil）。
      const alertChannel = n.change_alert_channel_id || n.channel_id;
      const occLabel = formatOccurrenceLabel(
        occ.occurrence_date,
        occ.start_time || n.start_time,
        n.duration_minutes,
      );
      const verb = oldStatus ? `**${shown(oldStatus)}** → **${shown(status)}** に変更` : `**${shown(status)}** で新規回答`;
      const alert = `⚠️ **締切後の回答変更**\n${displayName} さんが ${verb}しました（開催: ${occLabel}）。`;
      ctx.waitUntil(
        sendChannelMessage(env, alertChannel, alert, null, { parse: [] }).catch((e) =>
          console.error('[Button] change alert failed:', (e as Error).message),
        ),
      );
    }

    // 表示名の自動更新は返答に不要なので投げっぱなし。
    // ギルド内ボタンは interaction.guild_id 付き＝そのギルドの nick を最新化（DM 応答は guild 無し）。
    ctx.waitUntil(
      updateMemberDisplayName(db, userId, displayName, userName, interaction.guild_id ?? null).catch(
        (e) => console.error('[Button] update display name failed:', (e as Error).message),
      ),
    );
    return ephemeral(`✅ **${shown(status)}** で記録しました!`);
  } catch (e) {
    console.error('[Button] record failed:', (e as Error).message);
    return ephemeral('❌ 記録に失敗しました。管理者に連絡してください。');
  }
}
