# SubsTracker — Docker 自托管部署指南

本文档说明如何将 SubsTracker 从 Cloudflare Workers 移植到 **ARM64 / Docker** 环境自托管。

原项目基于 Cloudflare Workers + KV，移植后使用 **Node.js + Hono + 文件系统 KV**，功能完全一致。

---

## 快速开始

### 方式一：docker compose（推荐）

```bash
docker compose up -d
```

启动后访问 `http://<你的IP>:3000`，用 `admin` / `password` 登录（**请立刻改密码**）。

### 方式二：docker run

```bash
# 构建镜像
docker build -t substracker .

# 运行（数据持久化到 named volume）
docker run -d \
  --name substracker \
  --restart unless-stopped \
  -p 3000:3000 \
  -v substracker-data:/data \
  substracker
```

---

## ARM64 说明

基础镜像 `node:20-slim` 原生支持 `linux/arm64` 和 `linux/amd64`。

- **ARM64 宿机**（树莓派 4/5、Apple Silicon、飞腾、鲲鹏等）：直接 `docker build` 即可
- **在 x86 机器上为 ARM64 交叉构建**：

  ```bash
  docker buildx build --platform linux/arm64 -t substracker:arm64 . --load
  ```

- **多架构构建并推送**：

  ```bash
  docker buildx build --platform linux/arm64,linux/amd64 -t youruser/substracker:latest . --push
  ```

---

## 配置

所有配置通过环境变量传入（也可登录后在「系统配置」页面修改）：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | HTTP 监听端口 |
| `DATA_DIR` | `/data` | KV 数据文件存放目录 |
| `CRON_SCHEDULE` | `0 * * * *` | 定时任务 cron 表达式（UTC），每小时整点检查一次 |
| `NODE_ENV` | `production` | Node.js 环境 |

在 `docker-compose.yml` 的 `environment` 段修改后 `docker compose up -d` 即可生效。

---

## 数据持久化与备份

### 数据存储位置

所有数据（订阅、配置、通知日志、调度日志）保存在单个文件：

```
/data/kv.json
```

### 备份

```bash
# 方式一：从容器外拷贝
docker cp substracker:/data/kv.json ./backup-kv-$(date +%Y%m%d).json

# 方式二：用临时容器从 volume 拷贝
docker run --rm -v substracker-data:/data -v $(pwd):/backup alpine \
  cp /data/kv.json /backup/kv-backup.json
```

### 恢复

```bash
docker cp ./backup-kv-20240101.json substracker:/data/kv.json
docker restart substracker
```

### 也可以用应用内置的导出 / 导入

登录 → 系统配置 → 最下方「导出备份」下载 JSON → 新环境「导入」。

---

## 架构对照

| Cloudflare Workers | Docker 移植 |
|--------------------|-------------|
| Workers 运行时 | Node.js 20 |
| Hono 框架 | Hono + `@hono/node-server` |
| KV Namespace | 文件系统 KV（`/data/kv.json`，内存 Map + 异步落盘） |
| `[assets]` 静态资源 | Node.js 静态文件中间件（`public/` 目录） |
| `[triggers]` cron | `node-cron` 每小时触发 |
| `.html` text import | 自定义 ESM loader hook |
| `crypto.subtle` / `fetch` / `btoa` | Node.js 20 全局 API（原生支持） |

### 新增文件

```
src/server/
├── index.js              # Node.js 服务器入口（HTTP + 静态 + cron）
├── kv-fs.js              # 文件系统 KV 实现（兼容 Cloudflare KV API）
├── html-loader.mjs       # ESM loader hook（.html → 文本字符串）
└── register-loaders.mjs  # loader 注册入口（配合 --import 使用）
Dockerfile                # 多阶段构建，node:20-slim
docker-compose.yml        # 一键部署
.dockerignore
```

> **原 `src/` 应用代码完全未改动**——所有 handler、service、data 层、视图模板保持原样。

---

## 本地开发

```bash
# 安装依赖
npm install

# 启动（数据存到 ./.data/kv.json）
npm run start:dev

# 访问 http://127.0.0.1:3000
```

---

## 常见问题

### 1. 如何修改定时检查频率？

修改 `CRON_SCHEDULE` 环境变量。例如每 30 分钟检查一次：

```yaml
environment:
  - CRON_SCHEDULE=*/30 * * * *
```

### 2. 容器重启后数据会丢失吗？

不会。数据持久化在 Docker volume `substracker-data` 中。即使删除容器，只要不删除 volume，数据就在。

### 3. 如何从 Cloudflare Workers 迁移数据？

1. 在原 Cloudflare 部署上：系统配置 → 导出备份（JSON）
2. 启动 Docker 版本：`docker compose up -d`
3. 登录新实例 → 系统配置 → 导入备份

### 4. 如何查看日志？

```bash
docker compose logs -f          # 实时日志
docker compose logs --tail 100  # 最近 100 行
```

### 5. 忘记密码怎么办？

```bash
# 停止容器，编辑 kv.json 中的 config 键，修改 ADMIN_PASSWORD
docker compose stop
docker run --rm -it -v substracker-data:/data alpine sh -c "apk add jq && jq '.config.value |= (. as \$v | \$v | fromjson | .ADMIN_PASSWORD = \"新密码\" | tostring) | .config.value = \$v' /data/kv.json > /tmp/kv.json && mv /tmp/kv.json /data/kv.json"
docker compose start
```

或更简单：删除 `/data/kv.json` 中的 `config` 键，重启后系统会用默认 `admin` / `password` 重新初始化。

---

## 从源码构建 vs 使用预构建镜像

```bash
# 从源码构建（自动适配当前机器架构）
docker compose up -d --build

# 为 ARM64 交叉构建
docker buildx build --platform linux/arm64 -t substracker:arm64 . --load
docker run -d -p 3000:3000 -v substracker-data:/data substracker:arm64
```
