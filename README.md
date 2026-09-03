# SubsTracker — Cloudflare Workers 移植到 ARM64 Docker

## 一、项目背景

原项目 **SubsTracker** 是一个基于 **Cloudflare Workers + KV** 的轻量级订阅到期提醒系统，使用 Hono 框架构建。目标是将该项目移植到 **ARM64 系统下用 Docker 部署**，实现自托管运行，无需依赖 Cloudflare 平台。

## 二、原项目技术栈分析

| 组件 | 原方案（Cloudflare） | 说明 |
|------|----------------------|------|
| 运行时 | Cloudflare Workers | 边缘计算运行时 |
| Web 框架 | Hono | 轻量级路由框架 |
| 数据存储 | Cloudflare KV Namespace | 键值存储，支持 TTL、前缀列举 |
| 静态资源 | `[assets]` 指令 | `public/` 目录自动托管 |
| 定时任务 | `[triggers]` cron | 每小时整点触发 `scheduled()` handler |
| 模块加载 | Workers text loader | `.html` 文件作为文本字符串 import |
| 平台 API | `crypto.subtle` / `fetch` / `btoa` / `atob` / `crypto.randomUUID()` | Workers 运行时内置 |

### KV API 使用情况

通过对源码的全面分析，KV Namespace 使用了以下方法：

- `get(key)` — 读取字符串值
- `get(key, { type: 'json' })` — 读取并解析 JSON
- `put(key, value)` — 写入字符串值
- `put(key, value, { expirationTtl: N })` — 写入并设置 TTL（秒）
- `delete(key)` — 删除键
- `list({ prefix, cursor, limit })` — 按前缀列举，返回 `{ keys, list_complete, cursor }`

涉及的 KV 键空间：
- `config` — 应用配置（含 JWT 密钥）
- `sub_index` / `sub:{id}` — 订阅索引与单条订阅
- `reminder_rules:{subId}` — 提醒规则
- `notify_log:*` — 通知发送日志（30 天 TTL）
- `sched_log:*` — 调度执行日志（30 天 TTL）
- `notify_dedupe:*` — 去重标记（48 小时 TTL）
- `notify_lastfire:*` — 上次触发时间（60 天 TTL）
- `login_attempts:*` — 登录限流（5 分钟 TTL）
- `SYSTEM_EXCHANGE_RATES` — 汇率缓存
- `schema_version` / `migrate:*` / `migration_lock` — 数据迁移标记

## 三、移植方案设计

### 核心原则

> **原 `src/` 应用代码完全未改动**——所有 handler、service、data 层、视图模板保持原样。仅通过新增 `src/server/` 适配层实现运行时替换。

### 架构对照

| Cloudflare Workers | Docker 移植 | 实现方式 |
|--------------------|-------------|----------|
| Workers 运行时 | Node.js 20 | `node:20-slim` 基础镜像 |
| Hono 框架 | Hono + `@hono/node-server` | `@hono/node-server` 适配 Node HTTP |
| KV Namespace | 文件系统 KV | `src/server/kv-fs.js`：内存 Map + JSON 文件异步落盘 |
| `[assets]` 静态资源 | fetch 入口拦截 | 静态文件优先于 Hono app 处理 |
| `[triggers]` cron | `node-cron` | 每小时 UTC 整点触发 `checkExpiringSubscriptions` |
| `.html` text import | 自定义 ESM loader hook | `src/server/html-loader.mjs` 拦截 `.html` import |
| `crypto.subtle` / `fetch` / `btoa` | Node.js 20 全局 API | 原生支持，无需 polyfill |

## 四、新增文件详解

### 1. `src/server/kv-fs.js` — 文件系统 KV 实现

**职责**：替代 Cloudflare KV Namespace，提供完全兼容的 API。

**设计**：
- 所有键值对保存在单个 JSON 文件（默认 `/data/kv.json`）
- 启动时一次性加载到内存 `Map`，运行期读写都在内存中（单进程无并发问题）
- 写操作通过 debounce（100ms）异步落盘，避免高频写时 I/O 瓶颈
- 支持 `expirationTtl`：到期条目在读取 / 列举时惰性清理
- 落盘采用原子写入（写 `.tmp` → `rename`），防止进程崩溃导致文件损坏

**数据格式**（`kv.json`）：
```json
{
  "config": { "value": "{...}", "expiresAt": null },
  "notify_log:2026010108:123:rule1:telegram:abc": { "value": "{...}", "expiresAt": 1735689600000 }
}
```

**API 兼容性**：
- `get(key, { type: 'json' })` ✅
- `put(key, value, { expirationTtl })` ✅
- `delete(key)` ✅
- `list({ prefix, cursor, limit })` → `{ keys, list_complete, cursor }` ✅
- `flush()` — 额外方法，进程退出前强制落盘

### 2. `src/server/html-loader.mjs` — ESM Loader Hook

**职责**：让 Node.js 能 `import xxx from './xxx.html'`，将 HTML 文件内容作为字符串默认导出。

**原理**：Cloudflare Workers / Wrangler 内置 text loader，把 `.html` import 当字符串用。Node.js 原生不支持，这里通过 `load` hook 拦截 `.html` 请求，返回 `export default "<文件内容>"` 的虚拟模块。

```javascript
export async function load(url, context, nextLoad) {
  if (url.endsWith('.html')) {
    const content = await fs.readFile(new URL(url), 'utf8');
    return {
      format: 'module',
      source: `export default ${JSON.stringify(content)};\n`,
      shortCircuit: true
    };
  }
  return nextLoad(url, context);
}
```

### 3. `src/server/register-loaders.mjs` — Loader 注册入口

**职责**：在任何应用模块加载之前注册 `.html` 文本 loader。

**用法**：配合 `--import` 标志使用：
```bash
node --import ./src/server/register-loaders.mjs src/server/index.js
```

### 4. `src/server/index.js` — Node.js 服务器入口

**职责**：替代 Cloudflare Workers 运行时，组装完整的 HTTP 服务。

**功能模块**：

1. **KV + env 绑定**：创建 `FileKVNamespace` 实例，组装 `env = { SUBSCRIPTIONS_KV: kv }`（与 Workers env 结构一致）
2. **静态资源服务**：在 Hono app 之前拦截 `public/` 目录的 GET/HEAD 请求，按扩展名设置 Content-Type，包含路径穿越防护
3. **HTTP 服务器**：用 `@hono/node-server` 的 `serve()` 启动，通过 `fetch: async (req) => { ... app.fetch(req, env) }` 注入 env 绑定
4. **定时任务**：用 `node-cron` 注册 cron 表达式（默认 `0 * * * *` UTC），触发 `ensureMigrations` + `checkExpiringSubscriptions`
5. **优雅关闭**：监听 `SIGTERM` / `SIGINT`，停止 cron、强制 KV 落盘后退出

**环境变量**：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | HTTP 监听端口 |
| `DATA_DIR` | `/data` | KV 数据文件目录 |
| `CRON_SCHEDULE` | `0 * * * *` | cron 表达式（UTC） |
| `NODE_ENV` | `production` | Node.js 环境 |

### 5. `Dockerfile` — 多阶段构建

**设计**：
- **构建阶段**：`node:20-slim`，`npm ci --omit=dev` 安装生产依赖
- **运行阶段**：`node:20-slim`，拷贝 `node_modules` + `src/` + `public/`，安装 `tini` 作为 init 进程
- 基础镜像 `node:20-slim` **原生支持 `linux/arm64` 和 `linux/amd64`**
- 内置 `HEALTHCHECK`：每 60 秒探测首页
- `ENTRYPOINT ["tini", "--"]` 确保信号正确转发

### 6. `docker-compose.yml` — 一键部署

- 服务名 `substracker`，`restart: unless-stopped`
- 端口映射 `${PORT:-3000}:3000`
- 数据卷 `substracker-data:/data`
- 环境变量配置区
- 健康检查配置

### 7. `.dockerignore`

排除 `node_modules`、`.wrangler`、`tests`、`.github`、`wrangler.toml`、`scripts` 等不需要的文件。

### 8. `DOCKER.md` — Docker 部署文档

包含快速开始、ARM64 说明、配置、数据持久化与备份、架构对照、本地开发、常见问题等完整文档。

### 9. `OLD_DOCKER.md` — 原项目 部署文档

已采取“双轨兼容”模式，保留所有 Cloudflare 文件，仓库同时支持 Cloudflare Workers 和 Docker 两种部署方式。

## 五、修改文件

### `package.json`

新增依赖：
- `@hono/node-server` — Hono 的 Node.js HTTP 适配器
- `node-cron` — 纯 JavaScript cron 调度器

新增脚本：
- `start` — 生产启动：`node --import ./src/server/register-loaders.mjs src/server/index.js`
- `start:dev` — 本地开发：`DATA_DIR=./.data PORT=3000 node --import ...`

## 六、文件结构

```
SubsTracker-master/
├── src/
│   ├── server/                    # ★ 新增：Node.js 适配层
│   │   ├── index.js               # 服务器入口（HTTP + 静态 + cron）
│   │   ├── kv-fs.js               # 文件系统 KV 实现
│   │   ├── html-loader.mjs        # ESM loader hook（.html → 文本）
│   │   └── register-loaders.mjs   # loader 注册入口
│   ├── app.js                     # 未改动
│   ├── index.js                   # 未改动（原 Workers 入口）
│   ├── api/                       # 未改动
│   ├── core/                      # 未改动
│   ├── data/                      # 未改动
│   ├── services/                  # 未改动
│   └── views/                     # 未改动
├── public/                        # 未改动
├── Dockerfile                     # ★ 新增
├── docker-compose.yml             # ★ 新增
├── .dockerignore                  # ★ 新增
├── DOCKER.md                      # ★ 新增
├── package.json                   # ★ 修改（新增依赖和脚本）
└── ...其余文件未改动
```

## 七、本地验证结果

在 Node.js v24.19.0 环境下启动服务器并进行了全面测试：

| 测试项 | 结果 | 说明 |
|--------|------|------|
| 服务器启动 | ✅ | 端口 3000，cron 注册成功 |
| `GET /` 登录页 | ✅ | 返回 12624 字符 HTML（含主题注入） |
| `GET /js/lib/api-client.js` 静态资源 | ✅ | 返回 2159 字节，Content-Type 正确 |
| `POST /api/login` 登录 | ✅ | success: true，返回 JWT（3 段格式正确） |
| `GET /api/config` 配置 | ✅ | TIMEZONE: Asia/Shanghai，ADMIN: admin |
| `GET /api/dashboard/stats` 仪表盘 | ✅ | 返回月度/年度支出统计 |
| `POST /api/subscriptions` 添加订阅 | ✅ | 201 Created，success: true |
| `GET /api/subscriptions` 订阅列表 | ✅ | 返回 1 条订阅（Netflix, 68 CNY） |
| `GET /admin` 管理页面 | ✅ | 返回 186405 字符 HTML |
| `GET /debug` 调试页 | ✅ | 返回 2721 字节诊断信息 |
| `GET /api/notification-logs` 通知日志 | ✅ | 200，空数组 |
| `GET /api/scheduler-logs` 调度日志 | ✅ | 200，空数组 |
| `GET /api/backup` 备份导出 | ✅ | 200，3549 字节 JSON |
| KV 数据持久化 | ✅ | `kv.json` 包含全部 10 个键，2838 字节 |

### KV 文件验证

持久化后的 `kv.json` 包含以下键：
- `sub_index` — 订阅索引
- `sub:1788388115149` — 单条订阅数据
- `reminder_rules:1788388115149` — 提醒规则
- `config` — 应用配置（含 JWT 密钥）
- `categories` — 分类
- `SYSTEM_EXCHANGE_RATES` — 汇率缓存
- `schema_version` — 数据版本（v3）
- `migrate:subscriptions_v3` / `migrate:reminder_rules_v3` / `migrate:scheduler_logs_v3` — 迁移标记

## 八、部署方式

### 方式一：docker compose（推荐）

```bash
docker compose up -d
```

访问 `http://<IP>:3000`，用 `admin` / `password` 登录。

### 方式二：docker run

```bash
docker build -t substracker .
docker run -d --name substracker --restart unless-stopped \
  -p 3000:3000 -v substracker-data:/data substracker
```

### ARM64 交叉构建

```bash
# 在 x86 机器上为 ARM64 构建
docker buildx build --platform linux/arm64 -t substracker:arm64 . --load

# 多架构构建并推送
docker buildx build --platform linux/arm64,linux/amd64 -t youruser/substracker:latest . --push
```

## 九、数据迁移（从 Cloudflare Workers）

1. 在原 Cloudflare 部署上：系统配置 → 导出备份（JSON）
2. 启动 Docker 版本：`docker compose up -d`
3. 登录新实例 → 系统配置 → 导入备份

## 十、数据备份与恢复

### 备份

```bash
docker cp substracker:/data/kv.json ./backup-kv-$(date +%Y%m%d).json
```

### 恢复

```bash
docker cp ./backup-kv.json substracker:/data/kv.json
docker restart substracker
```

## 十一、关键技术决策

1. **不改动原代码**：通过新增 `src/server/` 适配层实现运行时替换，原 Cloudflare 部署仍可正常使用（双轨兼容）
2. **文件系统 KV 而非 SQLite**：单 JSON 文件 + 内存 Map 方案最简单，单进程无并发问题，完全兼容 KV API 语义（TTL、前缀列举）
3. **ESM loader hook 而非构建步骤**：用 `--import` 注册自定义 loader，运行时拦截 `.html` import，无需预构建步骤
4. **静态资源在 fetch 入口拦截**：在 Hono app 之前处理静态文件，与 Cloudflare `[assets]` 指令行为一致（静态资源优先于 Worker handler）
5. **env 注入方式**：`@hono/node-server` 不自动注入 env，通过 `fetch: (req) => app.fetch(req, env)` 手动传递 KV 绑定
6. **tini 作为 init 进程**：确保容器内信号正确转发，优雅关闭时 KV 数据能落盘
7. **原子写入**：KV 落盘采用写 `.tmp` → `rename` 模式，防止进程崩溃导致数据文件损坏

---

## 致谢

本项目基于 [wangwangit/SubsTracker](https://github.com/wangwangit/SubsTracker/) 迁移而来，感谢原作者的开源贡献。

## 许可证

MIT License
