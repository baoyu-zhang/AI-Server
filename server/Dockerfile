/**
 * Dockerfile —— M1 的可部署形态
 *
 * 构建要点（都是踩出来的）：
 *   ① 基础镜像用 node:22-alpine：node:sqlite 需要 22+，alpine 体积小；
 *      网络层用完整镜像源安装依赖（alpine 上 native 模块编译需要 python3/make/g++，
 *      本项目依赖全是纯 JS 或带 prebuilt，不需要编译工具链）。
 *   ② 本地 embedding 模型（@xenova/transformers）首次运行会从 HuggingFace 下载 bge-small-zh
 *      到缓存目录，容器内每次重建都要重新下载几百 MB——挂卷缓存，见 compose 的 transformers-cache。
 *   ③ vector-index / uploads / data 是运行时数据，打镜像时不带进去，运行时挂卷。
 *      打进去的话，重建镜像 = 抹掉所有人的知识库。
 */
FROM node:22-alpine AS base
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
