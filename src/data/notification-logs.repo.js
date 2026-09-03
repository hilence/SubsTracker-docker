// @ts-check
/**
 * 通知日志仓库
 *
 * 用途：每次发送通知（成功 / 失败）都记录一条；用于"通知历史"页和
 * "为什么没收到通知"自助排查。
 *
 * Key 规则：
 *   notify_log:{ymdh}:{subId}:{ruleId}:{channel}
 *     ymdh    = "YYYYMMDDHH"（UTC，方便按时间区间 list）
 *     subId   = 订阅 ID
 *     ruleId  = 触发的规则 ID（手动触发可填 'manual'，第三方 API 可填 'thirdparty'）
 *     channel = 通知渠道（telegram, bark, ...）
 *
 *   一条 KV 同时还存储进 metadata 里 ymdhmsRand，避免同小时内重复 key 覆盖。
 *
 * 默认 TTL：30 天，过期自动清理。失败日志可单独配置更长 TTL（这里统一 30 天即可，
 * 后续如需可改 writeLog 接受 ttl 参数）。
 *
 */

const PREFIX = 'notify_log:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/**
 * @typedef {Object} NotifyLogEntry
 * @property {string} key 完整 KV key
 * @property {string} timestamp ISO 时间
 * @property {string} subId
 * @property {string|null} ruleId 触发规则；手动 / 第三方为占位字符串
 * @property {string} channel
 * @property {'success'|'failed'} status
 * @property {string} [title]
 * @property {string} [content]
 * @property {string} [error] 失败原因
 * @property {any} [raw] 三方原始返回，便于排查
 */

/**
 * 把 Date 转成 'YYYYMMDDHH' UTC 字符串。
 *
 * @param {Date | string | number} date
 * @returns {string}
 */
export function ymdhUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return ymdhUtc(new Date());
  }
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}`;
}

/**
 * 写入一条通知日志。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {{
 *   subId: string,
 *   ruleId?: string|null,
 *   channel: string,
 *   status: 'success'|'failed',
 *   title?: string,
 *   content?: string,
 *   error?: string,
 *   raw?: any,
 *   timestamp?: string|Date|number,
 *   ttlSec?: number
 * }} entry
 * @returns {Promise<NotifyLogEntry>}
 */
export async function writeLog(env, entry) {
  const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
  // 增加随机后缀避免同小时同 sub/rule/channel 多次发送相互覆盖
  const rand = Math.floor(ts.getTime() % 100000)
    .toString(36)
    .padStart(4, '0');
  const ruleId = entry.ruleId || 'none';
  const key = `${PREFIX}${ymdhUtc(ts)}:${entry.subId}:${ruleId}:${entry.channel}:${rand}`;

  const stored = {
    timestamp: ts.toISOString(),
    subId: entry.subId,
    ruleId,
    channel: entry.channel,
    status: entry.status,
    title: entry.title,
    content: entry.content,
    error: entry.error,
    raw: entry.raw
  };

  await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(stored), {
    expirationTtl: Math.max(60, entry.ttlSec || DEFAULT_TTL_SEC)
  });

  return { key, ...stored };
}

/**
 * 查询通知日志。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {{
 *   subId?: string,
 *   channel?: string,
 *   status?: 'success'|'failed',
 *   since?: string|Date|number,
 *   until?: string|Date|number,
 *   limit?: number
 * }} [filter]
 * @returns {Promise<NotifyLogEntry[]>}
 */
export async function query(env, filter = {}) {
  const limit = Math.min(500, Math.max(1, filter.limit || 100));

  // KV.list 仅支持前缀，无法按多字段过滤，全部拉到内存再过滤
  const all = [];
  let cursor;
  do {
    const res = await env.SUBSCRIPTIONS_KV.list({
      prefix: PREFIX,
      cursor,
      limit: 1000
    });
    for (const k of res.keys) all.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && all.length < 5000);

  // 按 key 字典序倒序 = 时间倒序（因为 ymdh 在前缀后）
  all.sort((a, b) => b.localeCompare(a));

  const sinceTs = filter.since ? new Date(filter.since).getTime() : 0;
  const untilTs = filter.until ? new Date(filter.until).getTime() : Number.POSITIVE_INFINITY;

  const out = [];
  for (const key of all) {
    if (out.length >= limit) break;
    const raw = await env.SUBSCRIPTIONS_KV.get(key);
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (filter.subId && obj.subId !== filter.subId) continue;
      if (filter.channel && obj.channel !== filter.channel) continue;
      if (filter.status && obj.status !== filter.status) continue;
      const tsMs = new Date(obj.timestamp).getTime();
      if (tsMs < sinceTs || tsMs > untilTs) continue;
      out.push({ key, ...obj });
    } catch {
      /* skip */
    }
  }

  return out;
}

/**
 * 取某订阅最近 N 条日志（仪表盘 / 详情页用）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} subId
 * @param {number} [limit=20]
 */
export async function recentForSubscription(env, subId, limit = 20) {
  return query(env, { subId, limit });
}
