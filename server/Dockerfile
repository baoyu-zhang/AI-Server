# server/Dockerfile —— 历史遗留的「仅后端」镜像，保留给本地单独跑 API 用。
#
# ⚠️ 部署到 Railway / 对外提供页面请一律用仓库根目录的 Dockerfile：
#    那一份会在构建阶段编译 web/ 并一起打进镜像，Express 单端口同时托管页面和 API。
#    这一份只有后端，打开域名会看到 404，不是可用的线上形态。
#
# 构建要点（都是踩出来的）：
#   ① 基础镜像用 node:22：node:sqlite 需要 22+。
#      注意 alpine 是 musl，onnxruntime-node 的预编译二进制常加载失败，
#      根 Dockerfile 已换成 Debian slim，这里同步改掉。
#   ② 本地 embedding 模型首次运行会从 HuggingFace 下载 bge-small-zh 到缓存目录，
#      容器内每次重建都要重下几百 MB——挂卷缓存，见 compose 的 transformers-cache。
#   ③ vector-index / uploads / data 是运行时数据，打镜像时不带进去，运行时挂卷。
#      打进去的话，重建镜像 = 抹掉所有人的知识库。
#
# 之前的版本错误地用 JS 的 /* ... */ 写注释，Dockerfile 只认 #，会直接构建失败。
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# 先拷依赖清单再 npm ci：只有依赖变化才会使这一层缓存失效，代码改动直接走后面几层
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# 容器内不以 root 跑：uploads / data / vector-index 由 compose 挂卷，权限在挂载时处理
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "index.js"]
