// @ts-check
/**
 * 调度器执行日志仓库
 *
 * 用途：每次 Cron `scheduled` 触发都写一条聚合日志，包含本次执行的：
 *   - 起止时间、用户时区、是否在通知时段
 *   - 检查的订阅总数 / 命中提醒规则数 / 去重跳过数
 *   - 自动续订条数 / 通知发送统计
 *   - 错误（如有）
 *
 * 配合 notification-logs（细粒度）形成"链路日志"：
 *   sched_log:{isoUtc}                  ← 一次调度的总览
 *   notify_log:{ymdh}:{sub}:{rule}:{ch} ← 该调度发出的每条通知
 *
 * Key 规则：sched_log:{ISO_UTC}（如 sched_log:2026-05-24T17:00:00.000Z）
 *   ISO 字典序 == 时间序，便于 list 倒序读取。
 *
 * 默认 TTL：30 天。
 *
 */

const PREFIX = 'sched_log:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/**
 * @typedef {Object} SchedulerLogEntry
 * @property {string} key 完整 KV key
 * @property {string} startedAt ISO
 * @property {string} finishedAt ISO
 * @property {string} timezone 调度生效时区
 * @property {string} currentHour 用户 TZ 下的当前小时（"HH"）
 * @property {string[]} configuredHours 通知时段配置（用户 TZ 小时）
 * @property {boolean} inWindow 是否在通知时段内
 * @property {number} checkedCount 检查订阅数
 * @property {number} matchedCount 命中规则的（订阅×规则）对数
 * @property {number} dedupedCount 因去重跳过数
 * @property {number} sentCount 实际发送通知数
 * @property {number} autoRenewedCount 自动续订订阅数
 * @property {string} status 'ok' | 'skipped' | 'error'
 * @property {string} [reason] 跳过原因或错误摘要
 * @property {any} [extra] 附加信息（可选）
 */

/**
 * 写入一条调度日志。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Omit<SchedulerLogEntry, 'key'>} entry
 * @param {{ ttlSec?: number }} [opts]
 * @returns {Promise<SchedulerLogEntry>}
 */
export async function writeLog(env, entry, opts = {}) {
  const key = PREFIX + (entry.startedAt || new Date().toISOString());
  const stored = {
    startedAt: entry.startedAt || new Date().toISOString(),
    finishedAt: entry.finishedAt || new Date().toISOString(),
    timezone: entry.timezone || 'UTC',
    currentHour: entry.currentHour || '00',
    configuredHours: entry.configuredHours || [],
    inWindow: !!entry.inWindow,
    checkedCount: entry.checkedCount || 0,
    matchedCount: entry.matchedCount || 0,
    dedupedCount: entry.dedupedCount || 0,
    sentCount: entry.sentCount || 0,
    autoRenewedCount: entry.autoRenewedCount || 0,
    status: entry.status || 'ok',
    reason: entry.reason,
    extra: entry.extra
  };
  await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(stored), {
    expirationTtl: Math.max(60, opts.ttlSec || DEFAULT_TTL_SEC)
  });
  return { key, ...stored };
}

/**
 * 取最近 N 条调度日志（按时间倒序）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {number} [limit=20]
 * @returns {Promise<SchedulerLogEntry[]>}
 */
export async function getRecent(env, limit = 20) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 20));

  // KV.list 默认升序；想要倒序需要拉全后排序
  const allKeys = [];
  let cursor;
  do {
    const res = await env.SUBSCRIPTIONS_KV.list({
      prefix: PREFIX,
      cursor,
      limit: 1000
    });
    for (const k of res.keys) allKeys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && allKeys.length < 5000);

  allKeys.sort((a, b) => b.localeCompare(a));
  const top = allKeys.slice(0, safeLimit);
  const items = await Promise.all(
    top.map(async (key) => {
      const raw = await env.SUBSCRIPTIONS_KV.get(key);
      if (!raw) return null;
      try {
        return { key, ...JSON.parse(raw) };
      } catch {
        return null;
      }
    })
  );
  // @ts-ignore - 过滤 null
  return items.filter((x) => x != null);
}
