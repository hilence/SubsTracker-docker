# ─────────────────────────────────────────────
# SubsTracker — Dockerfile (ARM64 / multi-arch)
#
# 从 Cloudflare Workers 移植到 Node.js + Docker 自托管。
# 基础镜像 node:20-slim 原生支持 linux/arm64 和 linux/amd64。
#
# 构建：
#   docker build -t substracker .
#
# 运行（ARM64 宿机或通过 QEMU 模拟）：
#   docker run -d -p 3000:3000 -v substracker-data:/data substracker
#
# 或用 docker-compose：
#   docker compose up -d
# ─────────────────────────────────────────────

# ── 构建阶段：安装依赖 ──
FROM node:20-slim AS builder

WORKDIR /app

# 先拷 package 文件，利用 Docker 层缓存
COPY package.json package-lock.json ./

# 安装生产依赖（含 @hono/node-server、node-cron、hono）
RUN npm ci --omit=dev

# ── 运行阶段：精简镜像 ──
FROM node:20-slim AS runtime

WORKDIR /app

# 安装 tini 作为 init 进程，正确转发信号（SIGTERM 等）
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# 从构建阶段拷贝已安装的 node_modules
COPY --from=builder /app/node_modules ./node_modules

# 拷贝应用代码
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

# 数据持久化目录
RUN mkdir -p /data
VOLUME /data

# 环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV CRON_SCHEDULE="0 * * * *"

# 暴露端口
EXPOSE 3000

# 健康检查：每 60 秒探测一次首页
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 tini 转发信号，--import 注册 .html 文本 loader
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "./src/server/register-loaders.mjs", "src/server/index.js"]
