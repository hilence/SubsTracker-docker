// @ts-check
/**
 * Node.js 服务器入口 —— 替代 Cloudflare Workers 运行时
 *
 * 职责：
 * 1. 创建文件系统 KV 实例，组装 env 绑定（与 Workers env 结构一致）
 * 2. 用 @hono/node-server 把 Hono app 跑在 Node.js HTTP 服务器上
 * 3. 在 Hono 之前拦截 public/ 静态资源（替代 Workers [assets] 指令）
 * 4. 用 node-cron 每小时触发一次 scheduled handler（替代 Workers [triggers]）
 *
 * 环境变量：
 *   PORT            监听端口（默认 3000）
 *   DATA_DIR        数据目录（默认 /data，KV 文件存放在此）
 *   CRON_SCHEDULE   cron 表达式（默认 "0 * * * *"，每小时整点）
 *
 * 用法：
 *   node --import ./src/server/register-loaders.mjs src/server/index.js
 */

import { serve } from '@hono/node-server';
import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileKVNamespace } from './kv-fs.js';
import app from '../app.js';
import { ensureMigrations } from '../data/migrate.js';
import { checkExpiringSubscriptions } from '../services/scheduler.js';

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

// ─────────────────────────────────────────────
// KV + env 绑定
// ─────────────────────────────────────────────

const kvFilePath = path.join(DATA_DIR, 'kv.json');
const kv = new FileKVNamespace(kvFilePath);

/** 与 Cloudflare Workers env 结构保持一致 */
const env = {
  SUBSCRIPTIONS_KV: kv,
  ENVIRONMENT: process.env.NODE_ENV || 'production'
};

// ─────────────────────────────────────────────
// 静态资源服务（替代 Workers [assets] 指令）
// ─────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

/**
 * 尝试从 public/ 目录返回静态文件。
 * @param {string} pathname URL pathname
 * @returns {Promise<Response|null>}
 */
async function serveStatic(pathname) {
  // 安全：阻止路径穿越
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  // 确保解析后的路径仍在 PUBLIC_DIR 内
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await fs.readFile(filePath);
    return new Response(data, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// 定时任务（替代 Workers [triggers] cron）
// ─────────────────────────────────────────────

async function runScheduled() {
  const startedAt = new Date().toISOString();
  console.log(`[Cron] 定时任务触发 UTC: ${startedAt}`);
  try {
    await ensureMigrations(env);
  } catch (err) {
    console.error('[Cron] 迁移失败:', err);
  }
  try {
    await checkExpiringSubscriptions(env);
  } catch (err) {
    console.error('[Cron] 调度执行失败:', err);
  }
}

let cronTask = null;
if (cron.validate(CRON_SCHEDULE)) {
  cronTask = cron.schedule(CRON_SCHEDULE, runScheduled, {
    timezone: 'UTC'
  });
  console.log(`[Cron] 已注册定时任务: "${CRON_SCHEDULE}" (UTC)`);
} else {
  console.warn(`[Cron] 表达式无效 "${CRON_SCHEDULE}"，定时任务未启用`);
}

// ─────────────────────────────────────────────
// 启动 HTTP 服务器
// ─────────────────────────────────────────────

console.log(`[Server] 静态资源目录: ${PUBLIC_DIR}`);
console.log(`[Server] KV 数据文件: ${kvFilePath}`);
console.log(`[Server] 监听端口: ${PORT}`);

serve(
  {
    // 静态资源优先（替代 Workers [assets] 指令），未命中再交给 Hono app
    // @hono/node-server 不会自动注入 env，这里手动把 KV 绑定传给 Hono app
    fetch: async (req) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const staticRes = await serveStatic(new URL(req.url).pathname);
        if (staticRes) return staticRes;
      }
      return app.fetch(req, env);
    },
    port: PORT
  },
  (info) => {
    console.log(`[Server] SubsTracker 已启动 → http://0.0.0.0:${info.port}`);
    console.log(`[Server] 默认登录: admin / password（请尽快修改）`);
  }
);

// ─────────────────────────────────────────────
// 优雅关闭
// ─────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[Server] 收到 ${signal}，正在关闭...`);
  if (cronTask) cronTask.stop();
  try {
    await kv.flush();
    console.log('[Server] KV 数据已落盘');
  } catch (err) {
    console.error('[Server] KV 落盘失败:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
