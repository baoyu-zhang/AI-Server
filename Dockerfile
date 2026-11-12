# 根 Dockerfile —— Railway / 任意容器平台的「一份镜像同时带前端 + 后端」
#
# ===== 为什么放在仓库根目录 =====
# 原来 server/Dockerfile 只打后端，web/dist 又从没进过 git（被 .gitignore 排除），
# 所以哪怕容器跑起来，打开域名也只有 API、没有页面——这正是之前"生成了地址但没用"的原因。
# 现在改成两阶段构建：第一阶段把 Vue 编译成静态文件，第二阶段把它和后端装进同一个镜像，
# 由 Express 单端口托管（index.js 里的 express.static + SPA fallback）。
#
# ===== 为什么用 Debian slim 而不是 alpine =====
# @xenova/transformers 依赖 onnxruntime-node 的预编译二进制，alpine 是 musl，
# 经常加载失败；node:22-bookworm-slim 是 glibc，兼容性稳。node:sqlite 需要 Node 22+。
#
# ===== 数据都写哪 =====
# APP_DATA_DIR=/app/data，SQLite、上传原件、向量索引、图片、备份、模型缓存全在它下面
# （见 server/paths.js）。部署时**必须**把这个目录挂成持久化卷，否则每次部署数据全清空。

# ---------- 阶段 1：构建前端 ----------
FROM node:22-bookworm-slim AS web
WORKDIR /web
# 先只拷依赖清单：代码变了但依赖没变时，这一层命中缓存，构建能快很多
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# 产物落到 /web/dist；vite.config 里 emptyOutDir:false 只覆盖不删，受限环境也能构建
RUN npm run build

# ---------- 阶段 2：运行镜像 ----------
FROM node:22-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production \
    APP_DATA_DIR=/app/data \
    LOG_TO_FILE=0 \
    HF_ENDPOINT=https://huggingface.co/

# ⚠️ 这里刻意【不设 PORT】：Railway 会注入自己的 PORT，应用用 process.env.PORT 监听。
# 镜像里若预设了 3000，万一平台没覆盖，就会出现「容器活着但域名连不上」的经典故障。
# 本地单独跑镜像时自己指定：docker run -e PORT=3000 -p 3000:3000 ...
# 云平台的日志由平台从 stdout 收集，关掉文件落盘省一次 IO；
# Railway 在海外，HF 官方源比国内镜像更快，可用 HF_ENDPOINT 覆盖。

# 后端依赖：同样先拷清单再 npm ci，利用层缓存
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./

# 前端产物放到 index.js 默认查找的位置：__dirname=/app → ../web/dist = /web/dist
COPY --from=web /web/dist /web/dist

# 以 root 运行是这里的明确取舍：Railway 挂载的 Volume 常常是 root 所有，
# 换成非 root 用户会直接写不进 SQLite（表现为启动即崩）。PaaS 的容器隔离已提供边界。
# 不声明 VOLUME：Railway 的卷由控制台挂载，Docker 的匿名卷反而会挡住它。

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
