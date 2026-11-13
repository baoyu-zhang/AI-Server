# AI-Server 产品化交付清单（第一阶段 · 能装）

> 版本：Stage 1 / 2026-11-13
> 适用对象：交付工程师、对接方开发、客户系统管理员
> 一句话：**这一阶段解决的是「装得上、数据不丢、能恢复、能对接」**，不是做 SaaS 平台。

---

## 0. 怎么读这份文档

| 你想知道 | 看哪一章 |
| --- | --- |
| 这一阶段到底改了什么、验证到什么程度 | 第 1 章 |
| 用了哪些新技术、有没有别的选择、为什么选它 | 第 2 章 |
| 我们的 OA / 自研系统 / 门户怎么接进来 | 第 3 章（含可直接复制的 curl 与代码） |
| 接进来之后，业务人员每天怎么用 | 第 4 章 |
| 怎么建管理员、怎么管其他账号 | 第 5 章 |
| 装、备、升级、排错 | 第 6 章 |
| 还有哪些没做 | 第 7 章 |

**命令约定**：下文所有 `cd "$ROOT"` 里的 `ROOT` 指仓库根目录；示例服务器地址统一写作 `http://<host>:3000`（离线交付固定 3000 端口）。尖括号占位符如 `<TOKEN>` 需要替换成实际值，**示例里没有任何真实密钥**。

```bash
export ROOT="/opt/ai-server"     # 换成实际部署目录；本机开发是 ~/Desktop/ai智能体练习/AI-Server
cd "$ROOT"
```

---

## 1. 第一阶段做完了什么

### 1.1 改动清单

| # | 改动 | 涉及文件 | 解决的问题 |
| --- | --- | --- | --- |
| 1 | 会话文档附件持久化 | 新增 `server/session-files-store.js`；改 `server/session-files.js`、`server/index.js` | 以前用户上传的 PDF/Word 解析出的文本块和 512 维向量只在内存里，**重启 / 重新部署就没了**。现在元数据入 SQLite、内容落磁盘 JSON，重启后按会话惰性回填 |
| 2 | 数据库版本化迁移 | `server/db.js` | 原来 4 个散落的 `ALTER TABLE` 块看不出「库跑到第几版」。现在用 `PRAGMA user_version` + 有序 `MIGRATIONS` 数组，当前版本 **v5**，升级日志可追溯 |
| 3 | 整卷备份 | `server/backup.js` | 原来 `VACUUM INTO` 只导 `app.db`，恢复后「聊天记录还在、图片全裂、知识库全空」。现在每次备份额外产出 `.tar.gz`，含 db + `images/` + `uploads/` + `vector-index/` |
| 4 | 整卷恢复 | `server/restore.js` | 支持 `--verify` / `--restore` 直接吃 `.tar.gz`；`--force` 时连三个数据目录一起还原，且原目录改名留底、解包前挡路径穿越 |
| 5 | 离线模型预置 | 新增 `scripts/prefetch-model.mjs`、`Dockerfile.offline` | 客户内网无外网时，embedding 模型不会再去 HuggingFace 拉几百 MB 导致 RAG 起不来 |
| 6 | 交付编排 | 新增 `deploy/docker-compose.yml`、`deploy/.env.example` | 原 `server/docker-compose.yml` 只打后端且自认「未经本机验证」，不能拿去客户现场 |
| 7 | 一键初始化向导 | 新增 `scripts/setup.mjs` | 不用手改环境变量建管理员；自动生成强随机管理员密码与图片签名密钥 |
| 8 | 离线安装包 | 新增 `scripts/build-offline-bundle.sh` | 产出镜像 tar.gz + 配置模板 + 校验和，供无外网客户导入 |
| 9 | 小修 | `server/logger.js`、`server/eval/verify-p0.mjs` | 日志启动提示改走 stderr（避免污染 CLI 的 stdout 管道）；验收脚本认得新的 `.tar.gz` 备份 |

> 主 `Dockerfile`、`railway.json`、`server/docker-compose.yml`、`web/**` **一律没动**，线上 Railway 服务不受影响。

### 1.2 真实跑过的验证

| 验证项 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 10 个改动文件的语法 | `node --check` 逐个 | 全部通过 |
| 新库迁移 | 临时库 `require('./db')` | `user_version = 5`，`session_files` 表与两个索引建成，v1→v5 日志齐全 |
| 向量序列化 | 写入 `Float32Array` → 读回 | 读回是普通数组 `[0.1, 0.2, 0.3]`，点积不会变 `NaN` |
| 附件回填 / 裁剪 / 按用户删除 | store 层直调 | 回填 1 条、裁剪掉 1 条、按用户删 1 条，结果均符合预期 |
| 整卷备份 | `backupNow('manual')` | 产出成对 `.db`(120KB) + `.tar.gz`；归档内 `images/a.png`、`uploads/session-files/f-test.json`、`vector-index/index.json` 齐全 |
| 整卷体检 | `node restore.js --verify <archive>` | `integrity_check=ok`，关键表齐全，报告带的数据目录 `images/uploads/vector-index` |
| 演练恢复（不动正式库） | `node restore.js --restore <archive>` | 恢复到临时库成功，正式库附件仍可读 |
| 强制恢复（临时数据目录） | `node restore.js --restore <archive> --force` | 三个目录全部还原，各自生成 `*.pre-restore-<时间戳>` 留底，库版本仍为 5 |
| 初始化向导 | `node scripts/setup.mjs --non-interactive ...` | `.env` 权限 600、自动生成 32 位密码与 64 位 hex 密钥、覆盖保护与备份生效 |
| 离线包脚本（无 docker 时） | `bash scripts/build-offline-bundle.sh` | 中文报错并退出，未生成假产物 |

### 1.3 未验证项 —— 交付前必须在构建机补做

**本机（macOS 14.8.1 / Apple Silicon arm64）没有安装 docker，也没有实际下载模型，以下四步如实标注为「未验证」，不要当成已完成。安装方法见 6.0：**

```bash
cd "$ROOT"
npm run model:prefetch          # 1. 联网机器预下载 embedding 模型到 model-cache/（几百 MB）
npm run bundle:offline          # 2. 需要 docker daemon；产出 output/offline-bundle-<日期>/
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build   # 3. 真机起服务
curl --noproxy '*' http://127.0.0.1:3000/api/health                              # 4. 期望 {"ok":true,"ready":true}
```

另外两件也没跑：`SKIP_MODEL=1 bash scripts/verify-all.sh`（全套验收，需服务在 3000 端口）、交互模式的 `npm run setup`（需要 TTY）。

> **更新（2026-11-13 第二阶段）**：先前记的「服务启动冒烟未跑通，日志停在 dotenv，属沙箱限制」**已定位为误判**。真实原因是本机 `NODE_OPTIONS` 被 IDE 注入了 `--require=.../node-language-shim.cjs`，导致 `node index.js` 与 `vite build` 在启动早期被中断；日志停在 dotenv 就是它的特征。**清空该变量即可**：
>
> ```bash
> NODE_OPTIONS= PORT=3199 APP_DB_FILE=/tmp/smoke/app.db APP_DATA_DIR=/tmp/smoke \
>   DEEPSEEK_API_KEY=sk-smoke-dummy ADMIN_USERNAME=smokeadmin ADMIN_PASSWORD=<强随机串> \
>   LOG_TO_FILE=0 node server/index.js
> # 另一个终端：curl --noproxy '*' http://127.0.0.1:3199/api/health
> ```
>
> 现已真实跑通：`/api/health` 200 `ready:true`、`/api/branding` 200、未登录访问 `/api/models` 返回 401（鉴权边界未被新公开路由破坏）、管理员引导建号成功、管理员登录 200、静态登录页 200；带自定义 `branding.json` + 有效 `license.json` 时，接口返回客户品牌与 `license.status: valid`，且不泄露 `signature`。`curl` 一律加 `--noproxy '*'`，否则本机代理会把它变成 502。`docker` 相关的第 1–3 步仍待构建机补验。

### 1.4 数据都落在哪

```
$APP_DATA_DIR/                     # 离线交付固定 /app/data，对应 compose 里的具名卷 app-data
├── app.db                        # 用户 / 会话 / 审计 / 用量 / 图片元数据 / 附件元数据
├── branding.json                 # 可选：运行时品牌配置（改完重启，见 3.7）
├── license.json                  # 可选：客户许可文件（由交付方签发，见 3.7）
├── images/                       # 聊天图片原件
├── uploads/
│   └── session-files/<fileId>.json   # 新增：文档附件的切块文本 + 向量
├── vector-index/                 # 知识库向量索引
├── backups/                      # 成对的 .db 与 .tar.gz（异地备份请把 .tar.gz 拷走）
├── logs/                         # 文件日志（Docker 交付时 LOG_TO_FILE=0，走 stdout）
└── transformers-cache/           # 本机开发用；离线镜像里模型在 /app/model-cache，不进卷
```

---

## 2. 技术清单：用了什么、还能用什么、为什么选它

### 2.0 三条贯穿全局的取舍原则

1. **单实例优先**：目标形态是「每客户独立部署一套」，不是多租户 SaaS。所有选型都按「一个容器、一个卷、一个人的运维能力」来定。
2. **离线优先**：HR 简历是个人敏感信息，客户最在意「数据不出机房」。因此 embedding 用本地模型、向量用本地文件、身份用本地账号，不依赖任何外部服务才能启动。
3. **零依赖优先**：能在 Node 内置或系统自带工具里解决的，不引第三方包。少一个依赖，客户内网就少一个装不上的理由。

### 2.1 选型总表

| 技术（项目里的位置） | 可选替代方案 | 为什么选它（含取舍） | 什么信号出现时该换 |
| --- | --- | --- | --- |
| **Node 22 内置 `node:sqlite`**（`server/db.js`，同步 API） | `better-sqlite3`、`sqlite3`、Postgres/MySQL、Prisma/Drizzle | 随 Node 内置，**没有原生编译**，客户机器换个 Node 小版本也不会起不来；零数据库服务、单文件随卷备份。代价是同步 API、单写者、不能多实例 | 要跑 2 个以上实例 / 并发写。注意切 PG 不是改一个文件：实测 `db.prepare(` 分布在 **12 个文件 64+ 处**，全部要改 `await`（详见 7.2） |
| **Express 5 单端口托管 Vue 构建产物**（`server/index.js`） | NestJS / Fastify / Koa；或 Nginx + 前后端两个容器 | 一个端口、一个容器、一个卷，客户现场部署步骤最少；`app.use(requireAuth)` 一道总闸门保护所有 API。代价是 `index.js` 偏大、无依赖注入 | 团队多人协作、需要模块拆分时 |
| **Vercel AI SDK v7 `ai` + `@ai-sdk/deepseek` / `@ai-sdk/openai`**（`server/chat-core.js`） | 直接 fetch OpenAI 兼容 API、LangChain.js、自研 SSE 解析 | `streamText` / `tool()` / `instructions` 统一抽象，换供应商只改 provider 一行；工具调用与流式输出不用自己拼协议。坑：`system` 不能塞进 `messages`，要用 `instructions` | 需要复杂编排（多 Agent、状态机）时可考虑 LangGraph，但当前单链路够用 |
| **AG-UI + `@ag-ui/encoder` SSE**（`POST /agui`） | 自研 WebSocket、tRPC 订阅、REST 轮询 | 前端状态、工具调用、**中断审批**都有标准事件，前端不用自己设计协议；SSE 比 WebSocket 更容易穿透企业代理。代价是前端要跟协议走 | 需要双向实时协同编辑时才上 WebSocket |
| **MCP Client**（`server/mcp-client.js`、`server/mcp.json`） | 写死工具函数、OpenAPI 插件、自研插件系统 | 外部系统接入**不改主链路**：在 `mcp.json` 加一项就能让 Agent 调你们的 API。stdio / http / sse 三种传输都支持。坑：stdio 的 `stderr` 必须 `ignore`，否则子进程写日志会堵死握手 | 无。这是当前最省的扩展点 |
| **本地 RAG：vectra 文件索引 + `@xenova/transformers` 的 `bge-small-zh-v1.5`**（`server/rag-vector.js`） | pgvector / Milvus / Qdrant；OpenAI 或国内厂商的 embedding API | 完全离线、简历文本不出网、零额外服务、中文检索效果好、512 维足够。代价：常驻几百 MB 内存（Railway 免费档 0.5GB 会 OOM）、首次要下模型、索引是单文件不能多实例共享 | 语料超百万 chunk / 要多实例共享 / 要实时增量重建 → 换 pgvector |
| **Vue 3 + TypeScript + TDesign**（`web/`） | React + Ant Design、纯 HTML | TDesign 中文场景组件齐、TS 能在编译期挡住协议字段拼错；学习/维护成本低 | 客户已有 React 技术栈且要求统一时可换 |
| **HMAC 签名图片 URL + 磁盘落盘**（`server/image-store.js`） | base64 塞进消息、对象存储预签名 URL、鉴权接口流式返回图片 | `<img src>` 发不出 `Authorization` 头；签名 URL 可缓存、刷新不重下、重启后仍能展示。密钥存 `.image-secret`，重启不变 | 上对象存储后换成预签名 URL |
| **opaque session token 入库 + `user_memory` 长期记忆**（`server/auth.js`、`memory-store.js`） | JWT、Redis session、mem0 类向量记忆 | 库里的 token **可立即撤销**（登出、封号、改密码立即生效），JWT 签发后拦不住；记忆只存离散事实而非对话摘要，注入 system 时省 token。代价：每次鉴权查一次库 | 多实例时 session/限流要搬 Redis |
| **scrypt 密码哈希、RBAC、日配额、滑动窗口限流、prompt 注入扫描、模型降级**（`auth.js`/`quota.js`/`rate-limit.js`/`prompt-guard.js`/`model-fallback.js`） | Auth0 / OIDC、Redis 限流、LLM Guard 服务 | 内网交付不依赖外部身份服务；配额按用户日 token 硬闸，防泄漏的 API Key 烧钱 | 要 SSO / 多实例时 |
| **Docker 多阶段构建 + 系统 tar + WAL + `VACUUM INTO`**（`Dockerfile.offline`、`backup.js`） | Kubernetes、systemd、restic/borg、pg_dump | 一条 `docker compose up` 就能交付；tar 是系统自带，客户内网不用装包；`VACUUM INTO` 保证 WAL 模式下导出的是一致快照，直接 `cp app.db` 会丢已提交事务 | 上 K8s / 需要增量备份与去重时 |
| **卷内 JSON 运行时配置 + 公开白名单接口**（`server/branding.js`、`web/src/config/branding.ts`） | Vite 构建期环境变量、每客户重打镜像、配置中心（Nacos/Apollo）、数据库存配置 | 同一份镜像发多家客户，改一个 JSON + 重启就换品牌，镜像校验和不变，升级不覆盖客户配置；不引配置中心这种额外服务。代价：配置无版本管理与灰度，靠文件备份 | 客户数上到几十家、需要配置审计与灰度发布时 |
| **Node 内置 `crypto` 的 HMAC-SHA256 许可文件**（`server/license.js`） | 在线授权服务器、JWT License、商业加密狗 / DRM、纯人工台账 | 离线环境不依赖联网激活；签发与验签共用同一个 `signPayload` 函数，不会两套规则对不上；**明确不假装是防破解**，只做防误改与交付留痕。代价：客户能接触源码，商业控制靠合同 | 要做按量计费、在线续期、防篡改硬件绑定时（那属于另一套产品） |

### 2.2 几个已经踩过、写进代码注释的坑

- **WAL + 直接 cp = 半个库**：备份必须 `VACUUM INTO`；恢复必须先删 `-wal` / `-shm`，否则旧事务会被重放回新库，恢复等于没做。
- **Float32Array 直接 `JSON.stringify` 会得到对象而不是数组**，读回后点积全是 `NaN`。`session-files-store.js` 里统一 `Array.from()`。
- **AI SDK 的 system 提示要放 `instructions`**，塞进 `messages` 会被拒绝。
- **MCP stdio 子进程 `stderr` 不 ignore 会堵死握手**。
- **容器缺 `libgomp1` 会启动即崩**（`onnxruntime-node` 链接了 OpenMP 运行时），`Dockerfile.offline` 已装。
- **`APP_DATA_DIR` 是单卷布局开关**：不设时本机沿用 `server/data` 等旧路径；设了才收敛到一个卷。两者混用会出现「数据看起来全没了」的假故障。
- **本机 `NODE_OPTIONS` 注入的 shim 会打断 `node index.js` 与 `vite build`**：现象是日志只停在 `injected env`、健康检查连不上，极易误判成「代码坏了 / 沙箱限制」。`NODE_OPTIONS= ` 清空即可，`curl` 还要加 `--noproxy '*'` 绕开本机代理（详见 1.3）。
- **公开端点不能直接 `res.json(配置文件)`**：`/api/branding` 未登录可读，必须逐字段白名单 + URL 伪协议过滤 + 长度截断，否则品牌文件就是一处注入面。
- **前端异步拿品牌要「先加载再 mount」**：先挂载再改文案会出现「默认品牌闪一下」；且加载必须自带超时与降级，品牌接口挂了不能让整个页面白屏。
- **离线包里没有 `scripts/` / `server/` 目录**：客户机执行 `node scripts/setup.mjs`、`node server/backup.js` 必然失败，手册里的命令要写成 `docker compose exec app ...`。

### 2.3 什么时候该重新选型

| 触发条件 | 该动的地方 |
| --- | --- |
| 要跑第 2 个实例 | 内存态（限流、`sessionOwners`、待审批）搬 Redis；DB 换 Postgres；图片/附件/向量换对象存储 |
| 客户要求 SSO / 对接企业微信钉钉 | 引入 OIDC/SAML，替换 `auth.js` 的本地注册登录 |
| 语料量上去、RAG 变慢 | vectra → pgvector，embedding 挪到独立 worker + 队列 |
| 要给几十家客户共用一套 | 加 `tenant_id`（9 张表 60+ 处 SQL）、向量索引按租户分片、全局 admin 拆成平台/企业管理员 |

以上都属于 **P3 / 多租户范畴，本阶段明确不做**。

---

## 3. 外部系统怎么接入

### 3.1 先记住一条：鉴权边界

`server/index.js:199` 的 `app.use(requireAuth)` 是**全局总闸门**，其后所有接口自动受保护。只有 4 类例外：

| 例外 | 为什么 |
| --- | --- |
| `/api/auth/*`（注册、登录、登出、me 的鉴权由自己处理） | 登录接口本身不能要求已登录 |
| `/api/health` | 容器探针不带 token |
| 静态页面 / 前端资源 | 登录页要给未登录的人看 |
| `/api/chat-images/:fileId?sig=...` | `<img src>` 发不出 Authorization 头，改由 HMAC 签名保证 |

**两类凭证，别混用：**

| 凭证 | 形态 | 给谁用 | 权限 |
| --- | --- | --- | --- |
| session token | 登录后返回的不透明字符串，`Bearer <token>` | 浏览器里的人 | 全部功能，**包括管理接口** |
| API Key | `sk-` + 64 位 hex，`Authorization: Bearer sk-...` | 程序 / 外部系统 | 能调 `/v1`、`/agui` 与业务接口；**不能管理 Key、Webhook、用户配额**（`authType !== 'session'` 一律 403） |

> 结论：**外部系统一律用 API Key**；管理动作必须在网页登录后用 session token 做。

### 3.2 通道一：OpenAI 兼容端点 `/v1/chat/completions`（最常用、改动最小）

适合：你们系统里已经有调大模型的代码（任何语言、任何 SDK），只要把 `base_url` 指过来。

**第 1 步：管理员登录拿 session token**（只需一次，用于签发 Key）

```bash
curl -s -X POST 'http://<host>:3000/api/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"<管理员用户名>","password":"<管理员密码>"}'
```

返回：

```json
{"ok":true,"token":"<SESSION_TOKEN>","user":{"userId":"...","username":"admin","role":"admin"}}
```

**第 2 步：签发一把 API Key**（必须在网页登录后操作，用 session token）

```bash
curl -s -X POST 'http://<host>:3000/api/keys' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SESSION_TOKEN>' \
  -d '{"name":"oa-prod"}'
```

返回里的 `key` 是**唯一一次明文**（`sk-` 开头 67 位），立刻存进你们的密钥管理；列表接口只显示前 12 位。

**第 3 步：调用（和调 OpenAI 一模一样）**

```bash
curl -s -X POST 'http://<host>:3000/v1/chat/completions' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <API_KEY>' \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role":"user","content":"用一句话说明什么是 RAG"}
    ],
    "stream": false
  }'
```

`model` 传客户端原来的名字（如 `gpt-4o`）也没关系：兼容端点**认识就用、不认识静默回落默认模型**，绝不报错——这是有意设计，保证「改个 base_url 就能跑」。响应里的 `model` 始终是真实使用的模型名，便于对账。

**在现有代码里怎么改（三例）**

```python
# Python openai SDK
from openai import OpenAI
client = OpenAI(api_key="<API_KEY>", base_url="http://<host>:3000/v1")
resp = client.chat.completions.create(model="deepseek-chat",
    messages=[{"role":"user","content":"帮我总结这份简历"}])
print(resp.choices[0].message.content)
```

```javascript
// Node openai SDK
import OpenAI from 'openai'
const client = new OpenAI({ apiKey: '<API_KEY>', baseURL: 'http://<host>:3000/v1' })
const r = await client.chat.completions.create({
  model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }]
})
```

```bash
# 纯 HTTP，stream=true 时按 SSE 逐行读 data:
curl -N -X POST 'http://<host>:3000/v1/chat/completions' \
  -H 'Authorization: Bearer <API_KEY>' -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

**错误码速查**

| HTTP | 含义 | 处理 |
| --- | --- | --- |
| 401 | 没带 / 带错凭证 | 检查 `Authorization: Bearer` 前缀有没有漏空格 |
| 403 | 账号被停用 | 找管理员在后台启用 |
| 429 `quota_exceeded` | 今日 token 配额用尽 | 明日 0 点自动恢复，或让管理员调 `quotaDaily` |
| 429（无 type） | 触发滑动窗口限流（默认 20 次/分钟） | 客户端退避重试 |

> 可用模型：`deepseek-reasoner`（深度思考，默认）、`deepseek-chat`（快速）、`deepseek-flash`（视觉）。实时列表：`GET /api/models`（需带凭证）。

### 3.3 通道二：Webhook 事件回推（把结果推回你们系统）

适合：不想轮询、希望「一轮对话结束 / 需要人工审批」时主动通知业务系统。

**注册**（必须用 session token）

```bash
curl -s -X POST 'http://<host>:3000/api/webhooks' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SESSION_TOKEN>' \
  -d '{"url":"https://oa.example.com/hooks/ai-server","events":["run.finished","approval.pending"]}'
```

返回 `{ok:true, id, url, events, secret}` —— **`secret` 只返回这一次**，用来验签。

支持的事件：`run.finished`（一轮结束）、`approval.pending`（有工具调用等待人工确认）。URL 只允许 http/https，且**拒绝 localhost / 内网地址**（防 SSRF）。

**你们系统收到的请求**

```
POST /hooks/ai-server
Content-Type: application/json
X-Event: run.finished
X-Signature: sha256=<hex>
X-Delivery-Id: <webhook id>

{"event":"run.finished","payload":{...},"timestamp":1731470000000}
```

**验签（Node，收下之前必做）**

```javascript
const crypto = require('node:crypto')
function verify(rawBody, signatureHeader, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected), b = Buffer.from(signatureHeader || '')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
// 注意：必须用「原始请求体字符串」验签，先 JSON.parse 再 stringify 会因键顺序/空格导致签名不一致
```

```python
# Python 版
import hmac, hashlib
def verify(raw_body: bytes, sig_header: str, secret: str) -> bool:
    expected = 'sha256=' + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig_header or '')
```

> 投递是 fire-and-forget：5 秒超时、失败只写审计、不重试。**需要可靠投递请在你们侧落队列表**，这是当前明确的能力边界。

### 3.4 通道三：MCP —— 让 Agent 反过来调你们系统的 API

适合：希望 AI 在对话中直接查 CRM / OA / 工单数据，而不想改 Agent 主链路。

**交付镜像里 `server/mcp.json` 默认是空数组 `[]`**（第二阶段已清掉 demo 工具与指向 example.com 的假配置），客户开箱看不到任何玩具工具。接你们的工具按部署形态二选一：

| 形态 | 做法 |
| --- | --- |
| 容器 / 离线交付（推荐） | 在 `deploy/.env` 加一行 `MCP_SERVERS=<把下面 JSON 压成一行>`，由 compose 注入容器。镜像层只读，改容器内文件不持久也难审计；环境变量随 `.env` 走，升级镜像不丢 |
| 本地 / 裸机部署 | 把 `deploy/mcp.example.json` 复制成 `server/mcp.json`，改地址与令牌、把 `enabled` 改成 `true`，重启服务；也可用 `MCP_CONFIG_FILE` 指向任意路径 |

配置示例（完整字段模板与中文说明见 `deploy/mcp.example.json`）：

```json
[
  {
    "name": "our-oa",
    "transport": "http",
    "url": "https://oa.yourcompany.com/mcp",
    "headers": { "Authorization": "Bearer <你们系统的服务令牌>" },
    "enabled": true,
    "requireApproval": true,
    "allowTools": ["queryEmployee", "listOpenTickets"]
  }
]
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `transport` | `stdio`（本地子进程）/ `http` / `sse` |
| `enabled` | 关掉的配置不连接，方便留模板 |
| `requireApproval` | `true` = 每次调用前弹出人工确认；`false`/`"auto"` = 直接执行；写操作建议 `true` |
| `allowTools` | 白名单，不填表示放开该 server 的全部工具；**生产环境务必填** |

改完重启服务，`GET /api/mcp` 可看已连接的工具清单（该接口刻意不返回 `headers`，避免泄漏令牌）。

**你们侧最小 MCP server 示例**（Node + Express，`/mcp` 用 JSON-RPC 暴露 `tools/list` 与 `tools/call`）：

```javascript
app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body
  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'queryEmployee', description: '按姓名查员工信息',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
    ] } })
  }
  if (method === 'tools/call') {
    const row = await db.query('SELECT * FROM employee WHERE name = ?', [params.arguments.name])
    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(row) }] } })
  }
  res.status(400).json({ error: 'unsupported method' })
})
```

> 若你们的 MCP server 是 stdio 方式，注意子进程 **stderr 必须忽略**，否则握手会被日志堵死（项目里已经这么处理）。

### 3.5 通道四：AG-UI / SSE（把聊天界面嵌进你们门户）

适合：不用我们自带前端，自己写界面但要复用中断审批、工具调用、引用来源等能力。

```bash
curl -N -X POST 'http://<host>:3000/agui' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <API_KEY>' \
  -d '{
    "threadId": "<线程ID>",
    "runId": "<本次运行ID>",
    "messages": [{"id":"m1","role":"user","content":"帮我总结这份简历"}],
    "forwardedProps": { "sessionId": "<会话ID>", "model": "deepseek-chat", "thinking": false },
    "state": {}
  }'
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `messages` | 是 | AG-UI 格式的消息数组，不能为空 |
| `threadId` / `runId` | 否 | 不传服务端生成；多轮对话要复用同一个 `threadId` |
| `forwardedProps.sessionId` | 否 | 会话附件检索用；也可用 `state.sessionId`，都不传则等于 `threadId` |
| `model` | 否 | 传了必须是注册表里的 id，**拼错直接 400**（自家协议，不静默回落） |
| `thinking` | 否 | 布尔；关 = `deepseek-chat`，开 = `deepseek-reasoner` |

响应是 SSE 事件流，用 `@ag-ui/encoder` 编码，包含文本增量、工具调用、`interrupt`（人工审批）等事件。

> 如果直接用我们自带的前端，**不需要调这个接口**，浏览器已经封装好了。

### 3.6 接口速查表

| 方法 | 路径 | 用途 | 凭证 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 自助注册 `{username,password}` | 无（有 IP 限流） |
| POST | `/api/auth/login` | 登录拿 token | 无 |
| POST | `/api/auth/logout` | 注销当前 session | session |
| GET | `/api/auth/me` | 当前身份 | 任一 |
| GET | `/api/health` | 健康检查 | 无 |
| GET | `/api/branding` | **品牌 + 脱敏许可状态**（登录页用，见 3.7） | 无 |
| POST | `/v1/chat/completions` | **OpenAI 兼容聊天** | 任一（推荐 API Key） |
| POST | `/agui` | AG-UI / SSE 聊天 | 任一 |
| GET | `/api/models` | 可用模型列表 | 任一 |
| POST/GET | `/api/keys` | 签发 / 列出 API Key | **session only** |
| POST | `/api/keys/:id/revoke` | 吊销 Key | **session only** |
| POST/GET | `/api/webhooks` | 注册 / 列出 Webhook | **session only** |
| POST | `/api/webhooks/:id/delete` | 删除 Webhook | **session only** |
| GET | `/api/mcp` | MCP 连接与工具清单 | 任一 |
| POST | `/api/upload-doc`、`/api/session-files/upload` | 上传知识库文档 / 会话附件 | 任一 |
| GET/POST | `/api/documents`、`/api/documents/delete`、`/api/documents/context` | 知识库文档管理 | 任一 |
| GET | `/api/candidates`、`/api/jobs` | 候选人 / 岗位数据 | 任一 |
| GET | `/api/threads`、`/api/threads/:id/messages` | 会话历史 | 任一 |
| GET | `/api/audit`、`/api/usage` | 自己的审计 / 用量 | 任一 |
| GET | `/api/admin/users` | 用户列表（含用量、停用状态） | **admin + session** |
| PATCH | `/api/admin/users/:id/quota` | 改每日配额 | **admin + session** |
| PATCH | `/api/admin/users/:id/status` | 停用 / 启用 | **admin + session** |
| GET | `/api/admin/audit`、`/api/admin/usage` | 全局审计 / 用量 | **admin + session** |
| POST | `/api/account/password` | 改自己密码 | session |
| GET | `/api/account/export` | 导出自己全部数据 | session |
| GET/DELETE | `/api/memory`、`/api/memory/:id` | 长期记忆 | session |
| DELETE | `/api/threads/:id` | 删除会话 | session |

### 3.7 通道五：品牌与许可配置（无需鉴权，换客户不用重建镜像）

前四条通道是「业务系统怎么接进来」；这一条是「同一套系统怎么发给不同客户」。品牌与许可都放在**数据卷**里，镜像只读且全客户通用。

**① 品牌：`GET /api/branding`**

```bash
curl --noproxy '*' http://<host>:3000/api/branding
# 返回：productName / loginTitle / logoUrl / termsUrl / terminology / panels / license ...
```

这是**唯一一个不需要登录、且返回业务文案的公开接口**（登录页必须能显示客户名）。所以它只返回白名单字段：URL 只接受 `http(s)` 或站内路径（`javascript:` 等伪协议会被丢弃），文本有长度上限，配置文件里多写的字段一律不转发。**不要把任何密钥或内部信息写进 `branding.json`。**

配置来源优先级：`BRANDING_FILE` 环境变量 > `$APP_DATA_DIR/branding.json` > 内置默认值。模板见 `deploy/branding.example.json`，复制到卷里改完重启即生效：

```bash
cp deploy/branding.example.json ./branding.json      # 按需改字段，只写要覆盖的即可
docker compose -f docker-compose.yml --env-file .env cp ./branding.json app:/app/data/branding.json
docker compose -f docker-compose.yml --env-file .env restart app
```

| 字段组 | 能改什么 | 前端落点 |
| --- | --- | --- |
| `productName` / `shortName` / `tagline` | 标签页标题、窄屏短名、description | `document.title`、App 顶栏 |
| `loginTitle` / `loginSubtitle` / `registerSubtitle` | 登录卡片文案 | `LoginGate.vue` |
| `companyName` / `footer` / `logoUrl` / `faviconUrl` | 客户名、Logo、图标 | 登录页 |
| `termsUrl` / `privacyUrl` / `supportUrl` | 协议与帮助链接（填了才显示） | 登录页底栏 |
| `terminology` | 行业术语：`candidate` / `resume` / `job` / `knowledge` | 候选人页签、上传区文档类型标签 |
| `panels.candidates` | `false` 可整块隐藏候选人页签 | `SidePanel.vue` |

> **术语字典只换「显示文字」**：后端 `resume` / `jd` / `policy` 是数据模型枚举，工具描述与检索 filter 都依赖它，不能跟着改。主对话链本身行业中立，HR 只是默认皮肤 —— 换成「项目 / 制度文档 / 适用部门」并隐藏候选人页签，就是一套企业制度检索系统。

**② 许可：签发 → 放置 → 前端展示**

```bash
export LICENSE_SIGN_SECRET="$(openssl rand -hex 32)"   # 交付方保管，客户 .env 里配同一个值
npm run license:generate -- --customer '某某科技有限公司' --seats 30 --expires 2027-11-13
# 产出 output/license.json，拷到客户卷 /app/data/license.json，重启
```

`license.json` 含客户名、版本、坐席数、签发/到期日与 HMAC-SHA256 签名；服务端校验签名、到期与启用账号数，把**脱敏状态**（不含签名与 licenseId）合并进 `/api/branding` 给登录页显示。

> **默认只提示、不阻断**：没装许可文件、签名不匹配、已到期或超坐席，都只是登录页一行提示，登录照常可用。只有部署侧设 `LICENSE_ENFORCE=1` 时，到期 / 超额 / 签名异常才拒绝**新登录**（已登录会话不受影响，管理员仍有窗口处理续期）。是否启用由合同口径决定。
>
> HMAC 用于防误改与交付留痕，**不是防破解 DRM** —— 私有化交付下客户能接触镜像与源码，商业控制靠合同与交付关系。别在销售材料里说成加密授权。

### 3.8 接入方式怎么选

| 你们的情况 | 建议通道 | 大概工作量 |
| --- | --- | --- |
| 已有调大模型的代码，只想换个供应商 | 3.2 `/v1`，改 base_url | 半小时 |
| 要把 AI 结果写回业务表 / 触发流程 | 3.2 + 3.3 Webhook | 2–3 天 |
| 要 AI 在对话里查你们的数据 | 3.2 + 3.4 MCP | 2–5 天（取决于你们侧 MCP 实现） |
| 要把聊天 UI 嵌进现有门户，保留统一登录 | 3.5 AG-UI（+ 后续 SSO） | 1–2 周 |
| 只想先让人用起来 | 直接开我们自带的网页 | 半天 |

---

## 4. 接入之后，用户怎么用

### 4.1 第一次登录

浏览器打开 `http://<host>:3000` → 用管理员给的账号密码登录。界面左侧是功能页签（对话、知识库、候选人、记忆、账号、管理），右侧是工作区。**只有 `role=admin` 才看得到「管理」页签**（由 `/api/auth/me` 返回的 role 决定）。

### 4.2 一次完整的简历场景操作

1. **新建会话**：点「新对话」，服务端生成 `threadId`，后续多轮都复用它。
2. **上传资料**：在输入框附近上传简历 PDF / JD Word（会话级附件），或直接发一张图片。
   - 文档会被解析、切块、算向量并**落盘**（这一阶段新增），刷新页面、重启服务后仍在。
   - 图片落 `images/` 并生成带签名的 URL，刷新/换设备照样能显示。
3. **提问**：例如「这位候选人和 JD 匹配吗？给出证据」。模型会检索附件与知识库，回答里带引用来源。
4. **追问**：「第三点具体在哪一页？」——多轮上下文由前端带全量历史、服务端按 `threadId` 保存快照，跨轮引用可定位到原文邻域。
5. **看引用**：点回答里的来源可展开上下文片段。
6. **导出 / 打印**：生成的面试题、评估报告可导出 Markdown 或直接打印，不用手动复制。
7. **切换模型 / 深度思考**：下拉选 `DeepSeek Chat`（快）或 `Reasoner`（先推理再答）；开关由服务端翻译成选哪个模型，不是塞一个未必被支持的参数。上传图片时自动切到视觉模型。
8. **恢复历史**：左侧历史列表点开任意会话，消息快照与共享状态一起还原。

### 4.3 中断审批（人工确认）

删除附件、修改候选人状态、以及 `requireApproval: true` 的 MCP 工具，执行前会**先暂停并弹出确认框**，写清楚即将做什么、参数是什么。用户点「同意」才真正执行，所有动作写审计表。这是 HR 场景「AI 只做辅助建议、不自动淘汰」的产品落点。

### 4.4 用户自助能力

| 能做什么 | 入口 |
| --- | --- |
| 改自己密码（≥8 位，改完其它 session 全部失效） | 账号页 / `POST /api/account/password` |
| 导出自己全部数据 | 账号页 / `GET /api/account/export` |
| 查看、删除长期记忆 | 记忆页 / `GET|DELETE /api/memory` |
| 删除某段会话 | 会话列表 / `DELETE /api/threads/:id` |
| 查看自己的审计与用量 | `/api/audit`、`/api/usage` |
| 管理自己的 API Key | 账号页（签发后只显示前缀，可吊销） |

### 4.5 常见疑问

- **刷新后图片没了？** 已修复：图片落盘 + 签名 URL，刷新不重下。
- **重启后上传的简历还能问吗？** 本阶段已修复：文档切块与向量落盘，重启后按会话惰性回填（保留 30 天，可用 `SESSION_FILE_RETENTION_DAYS` 调整）。
- **问很久以前说过的事？** 稳定事实（称呼、偏好）由「长期记忆」跨会话注入；三年前的随口一句不在记忆里，属于设计取舍，不是 bug。
- **回答到一半关掉页面？** 服务端每轮 run 结束落 `thread_runs` 快照，重开会话可恢复。

---

## 5. 创建管理员账号 & 管理其他账号

### 5.1 方式 A（推荐）：初始化向导 + 首次启动自动引导

```bash
cd "$ROOT"
npm run setup                 # 交互模式：问用户名、密码、API Key
# 或无人值守：
node scripts/setup.mjs --non-interactive \
  --username admin --api-key 'sk-你的真实Key' --force
```

向导会：

1. 以 `deploy/.env.example` 为模板生成 `deploy/.env`（权限 `600`，已被 `.gitignore` 忽略）；
2. 未给密码时自动生成 **≥16 位强随机串**（生产环境 `security.js` 拒绝弱口令，最低 12 位）；
3. 自动生成 `IMAGE_SIGN_SECRET`（32 字节 / 64 位 hex）；
4. 已有 `.env` 时默认拒绝覆盖，`--force` 才覆盖且先备份成 `.env.bak-<时间戳>`；
5. **只在终端打印一次初始管理员账号密码**，不写日志文件。

然后启动服务：

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

`server/index.js` 在启动时会读 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，若用户不存在则创建、存在则把密码同步成 env 值，并把 `role` 置为 `admin`。**不需要手工建号。**

### 5.2 方式 B：直接写环境变量（不用向导）

在 `deploy/.env` 里填齐：

```dotenv
DEEPSEEK_API_KEY=sk-你的真实Key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=至少12位随机串
APP_DATA_DIR=/app/data
IMAGE_SIGN_SECRET=随机32字节hex
NODE_ENV=production
LOG_TO_FILE=0
```

启动服务即可。本机开发则写在 `server/.env`（`dotenv` 会自动加载），**改完必须重启服务**。

### 5.3 方式 C：已有系统里把一个普通账号提成管理员

注册接口建出来的是 `role='user'`，没有「管理员代建账号」的接口。提权用 `scripts/db.mjs`：

```bash
cd "$ROOT"
node scripts/db.mjs users                         # 先看清用户 id
node scripts/db.mjs sql "UPDATE users SET role='admin' WHERE username='zhangsan'" --write
```

> 该命令会写库，执行前请先 `npm run backup` 或 `cd server && npm run backup`。

### 5.4 ⚠️ 一个必须知道的坑：环境变量是唯一事实源

`index.js` 每次启动都会把 `ADMIN_USERNAME` 对应的账号密码**重置成 `ADMIN_PASSWORD` 的值**。所以：

- 在管理后台改了管理员密码后，**必须同步修改 `deploy/.env` 里的 `ADMIN_PASSWORD` 并重启**，否则下次重启新密码会被覆盖回去；
- 反之，忘了 `.env` 里的初始密码也没关系：改掉它再重启即可重置；
- 不要把 `deploy/.env` 提交到 git 或转发给无关人员。

### 5.5 管理后台能做什么

用管理员在**网页**登录后（管理接口强制 `authType === 'session'`，API Key 即使是 admin 签发的也做不了管理动作）：

| 能力 | 界面 | 接口 |
| --- | --- | --- |
| 查看所有用户、注册时间、角色、会话数、累计 token、停用状态 | 管理页 | `GET /api/admin/users` |
| 停用 / 启用账号（停用后该用户所有 session 与 API Key 立即失效；不能操作自己） | 管理页 | `PATCH /api/admin/users/:id/status` |
| 设置单个用户每日 token 配额（`null` = 跟全局默认） | 管理页 | `PATCH /api/admin/users/:id/quota` |
| 查看全局审计、全局用量 | 管理页 | `GET /api/admin/audit`、`/api/admin/usage` |

### 5.6 完整 REST 示例（登录 → 管人）

```bash
# 1) 管理员登录
TOKEN=$(curl -s -X POST 'http://<host>:3000/api/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<密码>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
echo "已拿到 token"

# 2) 用户列表（含 id / role / disabled / quotaDaily / runs / totalTokens）
curl -s 'http://<host>:3000/api/admin/users' -H "Authorization: Bearer $TOKEN"

# 3) 停用某用户（body 必须是布尔值，不能是字符串）
curl -s -X PATCH "http://<host>:3000/api/admin/users/<USER_ID>/status" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"disabled":true}'

# 4) 把该用户每日配额设为 200000 token（null 表示恢复跟全局默认）
curl -s -X PATCH "http://<host>:3000/api/admin/users/<USER_ID>/quota" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"quotaDaily":200000}'

# 5) 创建一把给外部系统用的 API Key（注意：用 session token 创建）
curl -s -X POST 'http://<host>:3000/api/keys' \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"oa-prod"}'

# 6) 吊销一把 Key（列表里拿 id，列表不返回明文）
curl -s 'http://<host>:3000/api/keys' -H "Authorization: Bearer $TOKEN"
curl -s -X POST "http://<host>:3000/api/keys/<KEY_ID>/revoke" -H "Authorization: Bearer $TOKEN"

# 7) 用完注销
curl -s -X POST 'http://<host>:3000/api/auth/logout' -H "Authorization: Bearer $TOKEN"
```

**普通用户怎么来**：目前是**开放自助注册**（`POST /api/auth/register`，用户名 3–32 位字母数字 `_` `-`、密码 ≥6 位、按 IP 每小时限流）。管理员不能代建账号，只能注册后停用 / 调配额。

### 5.7 账号体系还缺什么（第二阶段待办）

- 没有「管理员代建账号 / 重置他人密码 / 删除用户」接口；合规删除目前要靠 `scripts/db.mjs` 手工执行，且需连带清理 `model_usage`、`audit_log` 与磁盘文件。
- 没有 SSO / OIDC / 企业微信钉钉登录、没有组织架构同步。
- 没有试用期、License 到期停用、按客户/坐席计费——目前只有按用户每日 token 配额。
- 用户名是**全局唯一**（没有租户维度），这是「一套系统只服务一家公司」的前提。

---

## 6. 部署与运维速查

### 6.0 先把 Docker 装上（开发机与客户机是两套东西）

> 先分清楚：Docker 是「运行容器的引擎」。macOS 不能直接跑 Linux 容器，所以 Mac 上装的是**带一个 Linux 虚拟机的 Docker Desktop（或 Colima）**；客户 Linux 服务器装的是**原生 Docker Engine**。两者命令一样，安装包和许可完全不同。

#### 6.0.0 为什么是 Docker，以及什么时候可以不装

**先说结论：Docker 不是运行本项目的必需品。** 开发时本机用 `npm start` / `npm run dev`，守护用 pm2（`scripts/deploy.sh`），云上由 Railway 在平台侧构建镜像，全程不需要你在本地装 Docker。它是**「把软件连同运行环境一起打包交给别人」的交付工具**，只在打离线安装包做私有化交付这一步才需要，而且构建机上装一次就够。

它解决的是那句经典抱怨：**「在我这儿能跑，怎么到你那儿就不行了」**。不用 Docker 时，客户机要手工装齐下面这些，任何一项版本不一致或漏装，表现都是「服务起不来」：

1. Node ≥ 22（根 `package.json` 的 `engines`，因为用了内置 `node:sqlite`）
2. 前后端两份 npm 依赖，其中 `@xenova/transformers` → `onnxruntime-node` 是**原生二进制**，不是纯 JS
3. Linux 上的 `libgomp1`（缺了容器/进程一启动就 `dlopen` 失败，macOS 用 dylib 不会暴露）
4. `web/dist` 前端构建产物（源码里没有，`web/dist` 被 gitignore 排除）
5. 几百 MB 的 embedding 模型（默认首次启动联网下载，客户内网没外网就废）
6. 进程守护（pm2 / systemd）、健康检查、数据目录与备份策略

Docker 把 1–5 固化成一个**只读镜像**，把会变的数据放**可写卷**（`/app/data`），再用 compose 把 6 一并声明。于是客户现场只剩 `docker load` + `docker compose up -d` 两步，且升级时换镜像即可、卷里的数据不动。

**什么时候真的可以不装：**

| 目标 | 要不要 Docker |
| --- | --- |
| 继续开发、本地演示、作品展示 | **不用**，现状就能跑 |
| 维护 Railway 线上服务 | **不用**，平台在云端构建 |
| 打离线包给客户私有化部署 | **要**：构建机装一次，客户机装 Engine |
| 客户明令禁止容器（部分政企） | 改用裸机部署脚本或虚拟机镜像，见下表 |

**替代方案与取舍（不是只有 Docker 一条路）：**

| 方式 | 好处 | 代价 / 适用边界 |
| --- | --- | --- |
| 裸机 npm + pm2（现有 `scripts/deploy.sh`） | 零额外依赖、你已熟悉、排查直观 | 每台客户机手工装齐上面 6 项；环境漂移难复现；内网要另做依赖与模型的离线包；升级靠脚本，回滚靠备份 |
| 直接给源码让客户自己跑 | 交付动作最少 | 客户 IT 接不住，原生模块与模型下载必踩坑，**不可作为商业交付** |
| 虚拟机镜像（OVA / qcow2） | 客户只导入虚机；禁容器场景可用 | 几个 GB、启动慢、资源开销大、升级要重发整镜像 |
| SaaS 托管（现成 Railway 方案） | 客户零部署、你统一运维 | 简历数据出客户机房，「私有化 / 数据不出内网」这个卖点没了，且回到多租户难题 |
| **Docker 镜像（当前选择）** | 环境固化、包体几百 MB、升级换镜像、compose 自带健康检查与自动重启、离线 `docker save/load` | 客户机需装 Engine；多一层抽象要学；开发机用 Docker Desktop 有商用许可边界 |

一句话取舍：**自用别装，卖的时候才装**。如果第一个客户就明确「我们不用容器」，把第一阶段的成果改造成裸机离线包并不算返工——附件落盘、整卷备份、迁移版本号、初始化向导这些改动与部署形态无关，只有 `Dockerfile.offline` / compose 那一层需要换成部署脚本。

#### 6.0.1 开发 / 构建机：macOS（Apple Silicon 与 Intel 通用）

本项目当前开发机是 macOS 14.8.1 / `arm64`，Homebrew 已装、Docker 未装。二选一：

**方式 A · Docker Desktop（图形界面，最省心，推荐新手）**

```bash
brew install --cask docker        # Apple Silicon 与 Intel 用同一条命令
open -a Docker                    # 首次启动：同意条款 → 输入 Mac 密码授权 → 等鲸鱼图标静止
```

首次启动需要 GUI 交互（授权、条款），**无法在无人值守终端里完成**，请在你自己的终端执行。装完建议在 Settings → Resources 把内存调到 8 GB、磁盘调到 100 GB（本项目镜像含几百 MB 模型 + 前端构建，默认 2–4 GB 容易在 `npm ci` 阶段 OOM）。

**方式 B · Colima（纯命令行、免费、无商用授权顾虑）**

```bash
brew install colima docker docker-compose
colima start --cpu 4 --memory 8 --disk 100     # 起一个 Linux VM，约 10 秒
docker context use colima                      # 把 docker CLI 指向它（通常自动完成）
```

适合：要对外卖产品、不想碰 Docker Desktop 商业许可，或只想要一个能跑 `docker build` 的后台引擎。没有 GUI，用 `colima status` / `colima stop` 管理。

**两种装法都要过的验证**（四条都有输出才算装好）：

```bash
docker --version                 # CLI
docker compose version           # Compose V2 插件，注意是空格不是 docker-compose
docker info | head -20           # 能连上 Server/daemon，不是 "Cannot connect"
docker run --rm hello-world      # 拉镜像 → 建容器 → 运行，全链路打通
```

**国内拉基础镜像慢 / 超时**：`docker build` 第一步要拉 `node:22-bookworm-slim`。若报 `i/o timeout` / `connection reset`，在 Docker Desktop 的 **Settings → Docker Engine** 编辑框里加（Colima 用 `colima ssh` 进 VM 改 `/etc/docker/daemon.json`，Linux 直接改 `/etc/docker/daemon.json` 后 `sudo systemctl restart docker`）：

```json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run"
  ]
}
```

> 公共加速源的可用性**按月变化、且不保证同步最新版本**，只用于开发机提速，不要写进给客户的交付承诺。生产环境正确做法是把 `image.tar.gz` 提前 `docker save` 带走（本项目离线包已经这么做了），或客户内网自建 Harbor。

#### 6.0.2 客户机房：Ubuntu 22.04 / 24.04（典型 x86_64 服务器）

用 Docker **官方 apt 仓库**，别用发行版自带的 `docker.io`（版本滞后、无 Compose V2 插件）：

```bash
# 1) 卸掉可能冲突的旧包（不存在会提示，属正常，不删已有镜像/卷）
sudo apt remove $(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc | cut -f1)

# 2) 添加官方 GPG key 与仓库（deb822 格式，自动适配当前系统代号与 CPU 架构）
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update

# 3) 装引擎 + CLI + Compose V2 + Buildx
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker

# 4) 免 sudo（重新登录后生效；docker 组等同 root，只给可信运维账号）
sudo usermod -aG docker "$USER"

# 5) 验证
docker --version && docker compose version && sudo docker run --rm hello-world

# 6) 放行端口（Docker 发布端口会绕过 ufw 规则，生产建议只绑内网网卡 / 前置反向代理）
sudo ufw allow 3000/tcp
```

**客户机房完全无外网时**：`docker load -i image.tar.gz` 导入业务镜像**不需要联网**，但**安装 Docker 引擎本体仍需联网**。提前在有网机器下载上述五个 `.deb`（或客户内网软件源已内置），拷进去 `sudo dpkg -i *.deb` 即可。内网机器不要配指向公网的 `registry-mirrors`，只会拖慢并报错。

#### 6.0.3 许可口径（对外卖产品必须能答上来）

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| Docker Engine（Linux 服务器） | Apache-2.0，免费 | 客户机房装这个，商用无订阅要求 |
| Docker Desktop（Mac / Windows） | 个人、开源、教育、小企业免费 | 员工 250 人以上或年收入超 1000 万美元的组织需付费订阅；超阈值改用 Colima |
| 本项目镜像 | 项目自有 | 内含 Node、npm 依赖与 embedding 模型，分发前请自行核对各依赖的许可证与模型许可 |

**不要把 Docker Desktop 装到客户 Linux 生产服务器上**，那是桌面产品；服务器一律用 Engine。

#### 6.0.4 ⚠️ 架构对齐：交付时最容易翻车的一处

镜像架构在 `docker build` 时固化，`docker load`、`docker run`、改 compose 都改不了。本项目开发机是 **arm64 (Apple Silicon)**，而客户机房通常是 **x86_64**：直接 `docker build` 打出来的 arm64 包，客户导入后容器反复重启、日志报 `exec /usr/local/bin/node: exec format error`。

打包脚本已加 `--platform`，默认打 **linux/amd64**（对应 x86_64），并在包内生成 `BUILD-INFO.txt` 记录架构。客户机先核对：

```bash
uname -m                                        # x86_64 → 默认包可用；aarch64/arm64 → 见下
docker image inspect ai-server-offline:latest --format '{{.Architecture}}'   # 期望 amd64
cat BUILD-INFO.txt                              # 包内已写明目标架构与构建机架构
```

| 客户机 `uname -m` | 打包命令 |
| --- | --- |
| `x86_64` | `npm run bundle:offline`（默认） |
| `aarch64` / `arm64` | `TARGET_PLATFORM=linux/arm64 npm run bundle:offline` |

在 arm64 Mac 上打 amd64 属于**交叉构建**，靠 QEMU 指令模拟执行 `npm ci` / `apt-get` / 前端构建，首次可能 15–30 分钟，偶尔原生依赖会在模拟环境下安装失败。脚本检测到架构不一致会打印中文警告。**要给客户的生产包，优先在 x86_64 Linux 构建机（或云上临时按量付费的 x86 机器）上打包**，本机只用来做功能验证。

装好 Docker 后回到 **1.3 节**补跑那四条验证命令，其中第 3、4 步（真机起服务 + 健康检查）是第一阶段的最终验收。

### 6.1 首次部署五步

```bash
cd "$ROOT"
npm run setup                                     # 1 生成 deploy/.env，记下打印的初始密码
npm run model:prefetch                            # 2 联网机器预下载模型（离线交付必做）
npm run bundle:offline                            # 3 可选：产出离线包；在线部署可跳过
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build   # 4 启动
curl --noproxy '*' http://127.0.0.1:3000/api/health                                # 5 期望 ok/ready 均为 true
```

浏览器打开 `http://<host>:3000`，用第 1 步打印的账号登录。

### 6.2 客户机房（无外网）导入离线包

把 `output/offline-bundle-<日期>/` 整目录拷到客户机：

```bash
uname -m && cat BUILD-INFO.txt                    # 0 先核对镜像架构（见 6.0.4），不匹配就别往下走
sha256sum -c SHA256SUMS                           # 1 核对完整性
docker load -i image.tar.gz                       # 2 导入镜像（tag 已与 compose 对齐）
cp .env.example .env                              # 3 填真实 Key 与强随机密码，或把构建机生成的 .env 安全带过去
docker compose -f docker-compose.yml --env-file .env up -d    # 4 启动；不要加 --build
curl --noproxy '*' http://127.0.0.1:3000/api/health          # 5 期望 ok/ready 均为 true
```

> 镜像里已内置 `/app/model-cache`，**不要**给它挂空卷，否则会盖住内置模型、启动时又去联网下载。
>
> **包内还有这些文件，别只拷一个 `image.tar.gz`**：`LICENSE`（商业权属声明）、`CHANGELOG.md`（已知限制）、`docs/操作手册.md`、`docs/legal/`（协议四件套模板，**需法务审核后才能签署**）、`templates/`（品牌 / 许可 / MCP 三份配置示例）。`SHA256SUMS` 现在动态枚举包内所有文件，新增文档不会漏校验。
>
> **离线包里没有源码目录**：客户机上不要执行 `node scripts/setup.mjs` 或 `node server/backup.js`（脚本在镜像里）。初始化用 `cp .env.example .env` 手工编辑；备份恢复改用 `docker compose -f docker-compose.yml --env-file .env exec app node backup.js`，详见 `docs/操作手册.md` 第 4 节。

### 6.3 备份与恢复（整卷）

```bash
cd "$ROOT/server"
npm run backup                    # 立刻备一份，产出成对的 .db 与 .tar.gz
npm run restore:list              # 列出备份（标注「整卷（推荐）」/「仅数据库」）
npm run restore:verify <文件名.tar.gz>      # 只读体检，不解到生产目录
npm run restore -- <文件名.tar.gz>          # 演练：恢复到 /tmp 临时库，正式库分毫不动
npm run restore -- <文件名.tar.gz> --force # 真恢复：停服务后再执行，完成后重启服务
```

**恢复正式库的标准动作**：先停服务 → `backupNow('pre-restore')` 由脚本自动留底 → 执行 `--force` → 重启服务。数据目录不会直接删除，而是改名成 `images.pre-restore-<时间戳>` 等留底，发现恢复错了可人工改回来。

**异地备份**：把 `backups/*.tar.gz` 定期拷到对象存储或另一台机器，**不要只拷 `.db`**。可用 `BACKUP_INCLUDE_DIRS`（默认 `images,uploads,vector-index`）、`BACKUP_KEEP`（默认 7 组）、`BACKUP_INTERVAL_HOURS`（默认 24）调整。

### 6.4 升级与回滚

1. 停服务 → `cd server && npm run backup`；
2. 确认生成了 `.tar.gz`（`--verify` 通过）；
3. 换新镜像 / 新代码，启动时 `db.js` 自动跑未执行过的迁移并打印 `schema 版本：x → 5`；
4. `curl /api/health` 与登录页验证；
5. 有问题：停服务 → `npm run restore -- <升级前的.tar.gz> --force` → 用旧镜像启动。

### 6.5 环境变量全表

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | 无 | 缺失服务直接退出 |
| `ADMIN_USERNAME` | 是 | 无 | 首次启动引导的管理员名 |
| `ADMIN_PASSWORD` | 是 | 无 | ≥12 位；生产环境拒绝弱口令；**重启会把该账号密码同步成此值** |
| `APP_DATA_DIR` | 云上/容器必填 | `server/data` | 单卷布局开关，容器内固定 `/app/data` |
| `IMAGE_SIGN_SECRET` | 建议 | 自动生成 | 换掉会让历史图片链接全部 403 |
| `NODE_ENV` | 建议 | — | `production` 开启安全基线自检 |
| `LOG_TO_FILE` | 建议 | 1 | 容器交付设 `0`，日志交给 docker 收集 |
| `PORT` | 否 | 3000（离线镜像） | Railway 由平台注入，**不要在主 Dockerfile 里预设** |
| `DAILY_TOKEN_LIMIT` | 否 | 500000 | 全局每用户每日 token 上限，0 = 不限制 |
| `CHAT_RATE_MAX` / `COMPAT_RATE_MAX` | 否 | 30 / 20 | 每分钟 /agui、/v1 请求上限 |
| `BACKUP_KEEP` / `BACKUP_INTERVAL_HOURS` / `BACKUP_DISABLED` | 否 | 7 / 24 / 0 | 备份策略 |
| `BACKUP_INCLUDE_DIRS` | 否 | `images,uploads,vector-index` | 整卷快照包含的目录 |
| `SESSION_FILE_RETENTION_DAYS` | 否 | 30 | 会话文档附件保留天数 |
| `MODEL_REASONING` / `MODEL_FAST` / `MODEL_VISION` | 否 | `deepseek-reasoner` / `deepseek-chat` / `deepseek-flash` | 换供应商模型名不用改代码 |
| `HF_ENDPOINT` | 否 | `https://hf-mirror.com/` | 预下载模型时的镜像源 |
| `TRANSFORMERS_CACHE` | 否 | 镜像内 `/app/model-cache` | 离线交付**不要覆盖** |
| `BRANDING_FILE` | 否 | `$APP_DATA_DIR/branding.json` | 品牌配置路径，见 3.7；文件不存在用内置默认值 |
| `LICENSE_FILE` | 否 | `$APP_DATA_DIR/license.json` | 许可文件路径，见 3.7 |
| `LICENSE_SIGN_SECRET` | 否 | 空（不验签） | 必须与签发许可时用的密钥一致；不配时状态为 `unsigned`，不阻断 |
| `LICENSE_ENFORCE` | 否 | `0` | `1` 才在到期 / 超额 / 签名异常时拒绝新登录；**没放许可文件前别开** |

### 6.6 故障速查

| 现象 | 先看哪里 |
| --- | --- |
| 打开是 `{"error":"未登录，请先登录"}` 或中文诊断页 | 镜像里没有 `web/dist`；检查构建用的是**根** Dockerfile / `Dockerfile.offline`，且 Root Directory = `/` |
| 容器启动即崩 | 缺 `libgomp1`；或缺 `DEEPSEEK_API_KEY`；或 Volume 权限写不进 `/app/data` |
| 图片 403 | `IMAGE_SIGN_SECRET` 被换过，或链接带了 `exp` 已过期 |
| 上传附件重启后仍找不到 | 检查 `uploads/session-files/<fileId>.json` 是否在卷内；卷是不是被重建了 |
| 恢复后图片全裂 | 用了 `.db` 而不是 `.tar.gz` 恢复；改用整卷快照重做 |
| 服务启动日志只停在 `injected env`、健康检查 502 | IDE 注入的 `NODE_OPTIONS` shim 干扰；用 `NODE_OPTIONS= node server/index.js` 启动，`curl` 加 `--noproxy '*'`（详见 1.3） |
| 改了品牌但页面没变 | 确认文件在容器卷内（`docker compose exec app cat /app/data/branding.json`）、已 `restart app`、浏览器强刷；`/api/branding` 返回 `no-store` |
| 登录页提示「许可签名不匹配」 | `LICENSE_SIGN_SECRET` 与签发时不一致，或把 `license.example.json` 当正式许可用了；用 `npm run license:generate` 重新签发 |
| `/api/branding` 返回 401 | 该端点必须挂在 `requireAuth` **之前**；若改动过 `server/index.js` 路由顺序，检查它是否被挪到鉴权闸门后面 |
| RAG 在客户内网起不来 | 模型没预置进镜像；跑 `npm run model:prefetch` 后重新构建 |
| 改了 `.env` 不生效 | 必须重启服务；`ADMIN_PASSWORD` 尤其如此 |
| 401 | 漏了 `Authorization: Bearer ` 前缀，或用了 API Key 去调管理接口 |
| `/api/mcp` 返回空列表、Agent 没有外部工具 | **这是交付默认行为**：`server/mcp.json` 是 `[]`。按 3.4 节用 `MCP_SERVERS` 或 `MCP_CONFIG_FILE` 注入，别去改容器里的 `/app/mcp.json`（镜像层只读） |
| 本地前端构建被信号中断（退出 137 / SIGTERM） | 检查 `NODE_OPTIONS` 是否被 IDE 注入了 shim；用 `NODE_OPTIONS= npm --prefix web run build` 清空后重跑。本项目 `vite.config.ts` 已设 `emptyOutDir: false`，属同一类环境干扰 |

---

## 7. 遗留待办

### 7.1 第二阶段「能签」（四个工作包已落地）

**目标不是加功能，是让销售和法务敢把这套东西写进合同。** 原估 3–4 周，代码部分已在 2026-11-13 做完；剩下的**法务审核、真机演练、种子客户**属于外部依赖，不因代码完成而消失。以下清单逐项核查过代码，不是泛泛而谈。

> **进度（2026-11-13）**：四个工作包**已全部落地**（第一包见 7.1.1，第二包见 7.1.2–7.1.4 各自的「本期已落地」）。主 `Dockerfile` / `railway.json` 一行未动，线上 Railway 服务不受影响。
>
> **仍需外部配合 / 真机验证的**：协议四件套目前是**模板草案**，含 `{{占位符}}`，必须由执业律师结合实际运营主体审核后才能签署；离线镜像构建 / `docker compose up` / 客户机健康检查仍未在有 Docker 的机器上跑过；CI 配置已写好但没在 GitHub 上实跑。这三项不因本轮代码完成而自动消失。

#### 7.1.1 去 demo 痕迹（已确认：下面这些都会进交付镜像）

`Dockerfile.offline` 用 `COPY server/ ./` 把整个 server 目录塞进镜像，而 `.dockerignore` 目前只排除了运行时数据，没有排除测试与内部文档。

| 位置 | 现状 | 处理 |
| --- | --- | --- |
| `server/mcp.json` 的 `demo` 条目 | **`enabled: true`**（不是关闭） | 客户在工具列表里能看到 `echo` / `add` / `server_time` 三个玩具工具，`add` 还会弹审批。改为默认关闭或删除 |
| `server/mcp.json` 的 `remote-example` | `https://example.com/mcp` + `Bearer <token>` 占位 | 删掉或改成带注释的空白模板；离线镜像里留假地址不专业 |
| `server/mcp-demo-server.js` | 2.5 KB，随镜像分发 | 加进 `.dockerignore`，只保留给开发/测试 |
| `server/eval/fixtures/sample-resume.docx`、`server/eval/` | 评测脚本与样例简历随镜像分发 | 同上；验收脚本留在仓库，不进交付镜像 |
| `server/HR-SCENARIO-PLAN.md`（写着「我做了个 RAG demo」）、`server/PROJECT-MAP.md` | 共 37 KB 内部设计文档随镜像分发 | 移到 `docs/` 或排除 |
| `web/index.html` | `<title>web</title>`、`lang="en"`、Vite 默认 favicon | 换成产品名、中文 `lang`、客户 Logo；这是客户打开浏览器第一眼看到的东西 |

> ⚠️ **删 demo server 前先看依赖**：`server/eval/verify-mcp.mjs` 全程用 `mcp__demo__*` 做连接、审批、审计验收。直接删文件会把唯一一套 MCP 回归测试一起弄坏。正确做法是把 demo 配置挪到测试专用的 fixture 配置文件，让 `verify-mcp.mjs` 显式加载它。

> ✅ **已核查为「当前不泄露」但要复核**：`server/uploads/` 有 193 个文件 / 55 MB，含真实姓名的简历、发票、内部组件规范。它已被 `.dockerignore` 和 `.gitignore` 排除，`git ls-files server/uploads` 为 0，**目前不会进镜像也不会进仓库**。但必须从**干净 clone** 构建交付镜像，并在构建前复核 `.dockerignore` 规则仍在；一旦规则被误删，这些个人数据会被打包送到客户手上。

**本期已落地（2026-11-13）**

| 改动 | 文件 |
| --- | --- |
| 交付配置清空，去掉 `enabled: true` 的 demo 与 `example.com` 假地址 | `server/mcp.json` → `[]` |
| 测试配置独立成 fixture，验收脚本头部写明启动命令 | 新增 `server/eval/fixtures/mcp-demo.json`；改 `verify-mcp.mjs` 与 `mcp-client.js` 注释 |
| 客户可用的 MCP 模板（HTTP / stdio 两种，默认 `enabled: false`） | 新增 `deploy/mcp.example.json`；同步改 3.4 节与 `命令清单.md` |
| 镜像排除 eval / samples / demo server / 内部 md / 早期 Dockerfile 与 pm2 配置 | `.dockerignore` |
| 前端标题、语言、描述、Vite 默认图标全部换掉 | `web/index.html`、`web/public/favicon.svg` |

> 关键取舍：**没有删掉 `mcp-demo-server.js` 和 `verify-mcp.mjs`**——它们是唯一一套 MCP 回归测试，`verify-mcp.mjs` 的 B 段查 `/api/mcp`、E 段触发 `mcp__demo__add` 审批，都依赖服务侧挂着 demo server。做法是「交付默认空 + 验收时用 `MCP_CONFIG_FILE` 显式挂载 fixture」，客户看不到玩具工具，测试也一行没废。

验收（本机真实跑过）：默认 `initMcp()` 得到 0 个 server；挂 fixture 后连上 3 个工具；前端构建产物标题为中文产品名且自带新图标；`.dockerignore` 规则逐条核对生效。

#### 7.1.2 品牌与皮肤（本期已落地）

原目标：客户名、Logo、登录页、产品术语；把 HR 词汇做成可配置项（主对话链行业中立，HR 只是皮肤）。验收标准：从登录页到工具列表，全程看不到 `demo` / `AI-Server` / `web` / `example.com` 字样。

| 改动 | 文件 |
| --- | --- |
| 运行时品牌配置：读卷内 `branding.json`，公开端点 `GET /api/branding`（白名单字段 + URL 伪协议过滤 + 长度上限） | 新增 `server/branding.js`；`server/index.js` 挂在 `requireAuth` 之前 |
| 前端品牌单例：启动先拉取再 mount，失败降级默认值；应用 title / description / favicon | 新增 `web/src/config/branding.ts`；改 `web/src/main.ts` |
| 登录页产品名 / 副标题 / Logo / 协议链接 / 页脚 / 授权状态 | `LoginGate.vue` |
| 窄屏顶栏短名、候选人页签标签与开关、文档类型标签、面板标题走术语字典 | `App.vue`、`SidePanel.vue`、`DocPanel.vue`、`CandidatePanel.vue` |
| 可复制的配置模板与环境变量说明 | 新增 `deploy/branding.example.json`；改 `deploy/.env.example` |

**关键取舍**：术语字典只换界面文字，`resume` / `jd` / `policy` 后端枚举与工具描述一律不动 —— 那是数据模型。把 `panels.candidates` 设 `false` + 换成「项目 / 制度文档 / 适用部门」，同一份镜像就变成企业制度检索系统。配置用法与字段表见 **3.7**。

**真实验证**：默认配置返回内置品牌；自定义配置返回客户名 / 术语 / 页签开关；`javascript:` 伪协议被丢弃、超长文本截断、白名单外字段不转发；`/api/branding` 200 且未登录可用，同时 `/api/models` 仍 401（公开路由没撕开鉴权边界）；`vue-tsc -b && vite build` 通过。

#### 7.1.3 协议四件套与 HR 场景红线（模板已备齐，法务待审）

- 用户协议、隐私政策、数据处理协议 DPA、License 协议：新增 `docs/legal/` 五份文件（含 `README.md` 填写指引与 22 项「只列问题、不作结论」的待确认清单），根目录补 `LICENSE` 与 `CHANGELOG.md`；`server/package.json` 与根 `package.json` 的 `license` 从 `ISC` / 空改为 `UNLICENSED`。
- DPA 明确点名 **DeepSeek 作为模型推理子处理者**、写清传输的是提示词与文档片段、客户可自配 `DEEPSEEK_API_KEY`；**备份中的删除时滞如实写明**（历史备份需到期轮转）。
- **HR 红线已落到代码**：`server/score-resume.js` 低分结论由「不通过」改为「需人工复核」，评分文本末尾固定附「辅助参考、不构成录用/淘汰决定、需人工复核」声明；阈值、权重与证据链不变，系统内仍无自动淘汰路径，状态变更走 `audit.js`。
- 面向公众提供生成式服务是否涉及备案 / 安全评估、就业公平与算法合规、个人信息出境等，**文档只列待确认问题，不下法律结论**，需按实际运营主体找执业律师确认。

> ⚠️ **不要直接把模板发给客户签**：每份顶部都标了「模板草案 / 需法务审核 / 不构成法律意见」，正文含 `{{甲方名称}}`、`{{坐席数}}`、`{{留存期限}}` 等占位符，以及可用率、通知时限、费用、管辖机构等待填数值。法务审核是这一包唯一的外部依赖，也是长周期项，建议现在就启动。

#### 7.1.4 商业能力与工程质量（最小可用版已落地）

| 原目标 | 本期结果 |
| --- | --- |
| License / 到期停用 | ✅ 轻量版：`server/license.js` + `scripts/gen-license.mjs`，客户名 / 版本 / 坐席 / 到期日 / HMAC 签名，登录页显示脱敏状态。**默认只提示不阻断**，`LICENSE_ENFORCE=1` 才拒绝新登录。用法见 3.7 |
| 版本号与 CHANGELOG | ✅ 三份 `package.json` 统一 `1.0.0`，新增 `CHANGELOG.md` |
| 一页纸操作手册 | ✅ `docs/操作手册.md`，已按**离线包实际内容**修正（客户机无源码目录，备份走 `docker compose exec app ...`） |
| 离线包带齐交付物 | ✅ `build-offline-bundle.sh` 现在随包复制 `LICENSE`、`CHANGELOG.md`、`docs/`、`templates/`，`SHA256SUMS` 改为动态枚举 |
| CI 门禁 | ✅ `.github/workflows/verify.yml`：npm ci → 前端构建 → 后端 `node --check` → 交付物 / 版本号 / JSON 模板静态断言；把需运行服务与真实 API Key 的 `verify-all.sh` 明确留给预发人工跑 |
| 按客户 / 坐席**计费**、支付、试用自动开通 | ⬜ 未做。等首个客户点名再做，很可能对方先问「能不能接我们 OA」（现成的 `/v1` + Webhook） |
| 单测、staging 环境 | ⬜ 未做。`npm test` 仍是占位 |

**验证**：许可生成 → 有效 → 篡改 seats 判 `invalid` → 过期判 `expired`（默认不阻断）→ 未配密钥判 `unsigned` → `LICENSE_ENFORCE=1` 时闸门返回 403 且 `next()` 未调用、非登录路径放行 → 恢复有效文件后回到 `valid`；脱敏视图不含 `signature` / `licenseId`；带许可文件真实启动服务后 `/api/branding` 返回 `license.status: valid`。

> 诚实边界：HMAC 是防误改与交付留痕，**不是防破解 DRM**；`LICENSE_ENFORCE=1` 只拦新登录，不踢已登录会话；CI 配置没在 GitHub 上实跑过。

> **两处更正，避免重复劳动**：① `PRAGMA user_version` 迁移版本号（当前 v5）和整卷备份/恢复的代码演练，**第一阶段已经做完**，不是本阶段待办；云上/客户机真机恢复演练属于第三阶段。② `mcp.json` 里 `enabled: false` 的是 `remote-example`，**`demo` 那条是 `enabled: true`**，此前把它记作「默认关闭」是错的。

#### 7.1.5 想先见客户：一周「最小可签包」

原计划的一周四项，前三项的代码工作**本期已做完**：

1. ✅ 去 demo 痕迹 + 换标题 / Logo（7.1.1）
2. ✅ 协议四件套模板（7.1.3）——**但法务审核仍待做**，这是唯一不能靠写代码关掉的一项
3. ✅ 版本号 + CHANGELOG + 一页操作手册（7.1.4）
4. ⬜ **干净 clone 构建一次**：在装了 Docker 的构建机上从全新 clone 打离线包，再执行
   `docker run --rm <image> find /app -maxdepth 2 -type f` 核对镜像内文件清单，
   特别确认 `server/eval/`、`server/samples/`、`server/*.md`、`uploads/` 都不在镜像里。
   顺带补 1.3 的四条真机验证（模型预下载 → 打包 → compose up → 健康检查）。

**剩下的三件事都跟写代码无关**：① 法务审协议并填占位符；② 在有 Docker 的机器上完整打一次离线包，并在客户同款服务器演练部署与恢复；③ 找一个种子客户做付费试点，让真实需求倒逼优先级。计费 / 支付系统仍建议等客户点名再做 —— 很可能对方第一句问的是「能不能接我们 OA」，而那是现成的 `/v1` + Webhook（2–3 天）。

### 7.2 明确不做（除非触发条件出现）

- **多租户 `tenant_id`**：9 张表、60+ 处 SQL、全局向量索引 / `candidates.json` / 全局 admin 都要改，3–4 周；目标是每客户独立部署时不需要。
- **P3 架构**：Postgres + Redis + 对象存储 + 多实例。最贵的一块是 SQLite 同步 API 改异步（12 文件 64+ 处调用点，会沿调用链传染到 SSE 路由），单人 4–8 周。
- **SSO / OIDC**：目前没有，客户若要求需 1–2 周新写。
- 以上按既定边界保持「待定」，本阶段一行未动。
