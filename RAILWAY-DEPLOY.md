# 从 GitHub 到在线地址：Railway 部署手册

> 目标：`https://<你的服务名>.up.railway.app` 打开就是登录页，前后端同一个域名、同一个端口。
> 平台自动签发 TLS 证书，所以 P0 里的「HTTPS + 域名」由 Railway 解决，不用自己配 nginx / Caddy。

---

## 〇、之前「地址生成了但没用」的四个原因

按实际命中概率排序，这次已全部修掉：

| # | 原因 | 现在的修法 |
|---|---|---|
| 1 | **仓库根目录没有任何构建配置**（没有根 `package.json`、没有根 `Dockerfile`、没有 `railway.json`），Railway 的构建器检测不出这是 Node 项目，报 "No start command found" 或干脆构建失败 | 新增根 `package.json` / `railway.json` / 根 `Dockerfile` |
| 2 | **`server/Dockerfile` 用了 JS 的 `/** ... */` 注释**。Dockerfile 只认 `#`，这份文件从来就没能构建成功过 | 已改成 `#` 注释，并标注「仅后端历史版」；线上统一用根 Dockerfile |
| 3 | **前端从没进过仓库**：`web/dist` 被 `.gitignore` 排除，旧 Dockerfile 也不编译前端。就算后端起来了，打开域名也只有 API / 404 | 根 Dockerfile 第一阶段 `npm ci && npm run build`，产物进镜像，由 Express 托管 |
| 4 | **GitHub 上的代码是旧的**：本地一堆 P0 改动（静态托管、配额、MCP、图片持久化…）当时还是未提交/未跟踪状态，线上根本没有这些功能 | 本次全部改造完成后提交并 `git push`，见第五节 |

另外两个「起来了但立刻不好用」的坑：
- 没配 `DEEPSEEK_API_KEY` → `index.js` 会 `process.exit(1)`，容器反复重启，域名一直 502；
- **没挂 Volume** → 容器文件系统是临时的，每次部署 SQLite、上传的文档、图片、向量索引全部清空。

---

## 一、前提

1. GitHub 仓库 `https://github.com/baoyu-zhang/AI-Server` 已推送本次改造后的代码（分支 `main`）。
2. Railway 账号：**30 天试用（$5 一次性额度、无需信用卡）足够完成一次完整部署验证**；试用结束自动回落到 Free（$0/月，每月 $1 额度）。
3. 一个可用的 DeepSeek API Key（费用走 DeepSeek 账单，与 Railway 无关，按 token 计）。

> ⚠️ **Free 计划只够「纯聊天」，一用知识库就不够**，别按「永久免费」规划：
> - embedding 模型是**懒加载**的（`rag-vector.js` 的 `getExtractor`）：不上传文档、不检索、
>   不设 `WARMUP_EMBEDDING=1` 时根本不会下载，此时 Node + Express 常驻约 150–250MB，
>   0.5GB 内存和 0.5GB 卷都够跑基础对话；
> - 一旦上传文档或做检索，模型加载后内存涨到 500–800MB、还要下几百 MB 缓存，
>   **同时撞上 0.5GB 内存与 0.5GB 卷两道天花板**，会 OOM 或磁盘写满；
> - 每月 **$1 额度**（内存约 $10/GB·月）只够约 100MB 内存常驻一整月，一个常驻 Web 服务几天就烧完，服务被暂停到下月；
> - 试用账号创建的卷在试用额度过期 30 天后会被删除，别在上面放唯一一份数据。
>
> `*.up.railway.app` 免费域名 Free 就能用（自定义域名才需要 Hobby）。
> 短期演示用剩下的试用期即可，长期在线见第八节「费用与免费替代方案」。

---

## 二、创建服务

1. 打开 `https://railway.com/new/github`，用 GitHub 登录并授权仓库访问。
2. 选 `baoyu-zhang/AI-Server` → Deploy。
   第一次构建会花几分钟（前端 `npm ci` + 后端 `npm ci`），**此时失败是正常的**，因为变量和卷还没配。
3. 构建完成后先别去点域名，按第三、四节配置。

> Railway 会读仓库根的 `railway.json`：builder = DOCKERFILE、dockerfilePath = `Dockerfile`、
> startCommand = `node index.js`、healthcheckPath = `/api/health`、healthcheckTimeout = 300 秒。
> 如果面板里 Builder 没自动切到 Dockerfile，到 **Service → Settings → Build** 手动选 Dockerfile，
> 并把 Config File 路径写成 `/railway.json`（注意是仓库根的绝对路径）。

### 2.1 新版控制台（Staged Changes）该怎么点

> ⚠️ **硬前提：Source 必须先连上仓库。** 只要 Settings → Source 里还摆着
> `Connect Repo` / `Connect Image` 两个按钮，这个服务就**没有任何代码来源**，
> 下面这些入口全都不会产生构建：`Deploy` 横幅、`Make a deployment to get started.`、
> `Deploy Latest Commit`、`Redeploy`、右侧 AI 助手的 `Deploy Latest Commit`、命令面板。
> 此时 Railway 的 AI 助手会直接回：
> *"This service has never deployed, so there's no latest commit to redeploy. `/app` also isn't a git repository"*。
> 那句话的意思不是「代码坏了」，而是**服务里压根没有 git 仓库可以拿 commit**。
> 注意：**在 GitHub 装了 Railway App ≠ 在 Railway 里选了仓库**，这两步是分开的。
> 另外 Root Directory 输入框那个 `/` 只是 CLI 部署的子目录，不是仓库路径，别把它当仓库已连上的证据。

新界面把「新建服务」变成一条**待应用变更**，画布上显示 `Service will be created`、
顶部出现 `Apply 1 change` / `Details` / `Deploy`。这不是部署失败，是服务还没真正创建。
按这个顺序点，别一进来就 Deploy：

1. **Settings → Source → Connect Repo**：确认已关联 `baoyu-zhang/AI-Server` 的 `main` 分支。
   如果这里还显示 `Connect Repo` / `Connect Image` 两个按钮，说明仓库没连上，先连；
   显示的是仓库名 + 分支名才是已连好。没连仓库就 Deploy 会得到一个空服务。

   > 点 Connect Repo 会跳到 GitHub 的「Install & Authorize Railway App」页，**这一步是必需的、不收费**。
   > 建议把默认的 `All repositories` 改成 **`Only select repositories`**，只勾 `AI-Server`：
   > 该授权包含「代码读写 + administration + checks/deployments/workflows」且不能逐项取消，
   > 缩小仓库范围就能降低暴露面，不影响 `git push` 自动部署。
   > 以后在 GitHub → Settings → Applications → Installed GitHub Apps → Railway → Configure 可随时增删仓库或卸载。
   > 若授权后 Railway 的仓库下拉是空的：点下拉旁的刷新图标；还不行就回 Configure 把
   > All ↔ Only 切换保存一次，强制 GitHub 重新下发安装事件。
2. **Root Directory 保持 `/`**（截图里已正确）。这是 CLI 部署时的子目录，**不要**改成 `/server`，
   否则根 `Dockerfile` / `railway.json` / `web/` 都读不到。
3. **Variables 页签**：先把第四节那 5 个必填变量填完。缺 `DEEPSEEK_API_KEY` 会让容器
   `exit(1)` 反复重启，白烧试用额度。
4. 再点顶部 **`Deploy`**：它会把那条 staged change 一起提交并触发首次构建
   （只想应用配置、不触发构建，用 `Apply 1 change`，等价官方的 Alt + Deploy）。
5. 服务真正创建出来之后，才挂卷：**Variables 页签往下滚到 Volumes**（部分版本在
   Settings → Volumes）→ New Volume → Mount Path 填 `/app/data` → 自动重新部署。
   > 面板不允许在创建前挂卷也没关系：顺序改成「填变量 → Deploy → 挂卷 → 自动重新部署」，
   > 只要**在产生真实数据之前**挂好就行，此时还没有数据可丢。
   > **试用计划卷上限 0.5GB**：Size 别填 1GB（会被拒），也不要设 `WARMUP_EMBEDDING=1`
   > （会提前下载几百 MB 模型直接把卷撑爆）。纯聊天用不到模型，0.5GB 足够。
6. 最后 Networking → **Generate Domain**，再按第五节验证。

> 右上角 `8 days or $3.91 left` 的含义：试用剩 8 天**或**剩 $3.91 额度，谁先到算谁。
> 所以先把配置一次填对再部署，别用「反复重试」去试错，失败重启也在计费。

### 2.2 服务创建后显示 `Service is offline`

这是**正常中间态**：staged change 应用完，服务实体存在了，但还没有一次运行中的部署。
右侧的 `ai-server.railway.internal` 是 Railway 内网 DNS、Region / Replica 是默认配置，
它们都会自动生成，**不代表服务在跑**。此时别急着 `Generate Domain`，没有后端接着域名只会 502。

**点部署之前先花 30 秒确认两件事**，否则会白跑一次构建、白烧额度：
① Settings → Source 显示的是 `baoyu-zhang/AI-Server · main`，而不是 `Connect Repo` 按钮；
② Variables 里 5 个必填项齐全，且 `ADMIN_PASSWORD` 不是本机那个短口令。

点 **Deployments** 页签，按看到的内容对号入座：

| 看到什么 | 原因 | 怎么做 |
|---|---|---|
| `Undeployed service` / `There is no active deployment for this service` | 只 Apply 了变更，从没触发过构建 | 点页面中间的 **`Make a deployment to get started.`**。注意 staged change 应用后顶部 `Deploy` 横幅会消失，别再找它；也可 Cmd/Ctrl+K → `Deploy latest commit` |
| `❌ .env 缺少 DEEPSEEK_API_KEY` | `index.js:203` 是硬检查，缺了直接 `exit(1)` | Variables 补 `DEEPSEEK_API_KEY` |
| `[security] 生产配置自检未通过：ADMIN_PASSWORD 是弱口令` | `security.js` 的 `WEAK_PASSWORDS` 会拦 `admin`、纯数字短口令等常见弱口令（含本机 `.env` 里的演示口令） | 换 ≥12 位随机串：`openssl rand -hex 16` |
| `生产配置自检未通过：数据目录不可写` | Volume 没挂、或挂载路径不是 `/app/data` | 按第三节挂卷后重新部署 |
| Build Logs 里 `npm ci` / `COPY` 失败 | Dockerfile 构建阶段问题 | 复制完整 Build Logs 再对着改 |
| 部署列表为空，且 Source 仍显示 `Connect Repo` | 只授权了 GitHub App，**没在 Railway 里选仓库** | 回 Settings → Source 选 `AI-Server` / `main` |
| 点 `Deploy Latest Commit` / `Redeploy` 没反应，或 AI 助手回 `no latest commit to redeploy` · `/app isn't a git repository` | 服务没有 Source，`Redeploy` 只能重跑**已经成功过**的部署 | 先 Connect Repo 选 `baoyu-zhang/AI-Server` / `main`，再回 Deployments 触发首次部署；AI 助手也一样绕不开 Source |
| Connect Repo 点开后仓库下拉是空的 | GitHub App 只授权了别的仓库，或安装事件没同步 | GitHub → Settings → Applications → Railway → Configure 勾上 `AI-Server`；回 Railway 刷新，必要时把 All ↔ Only 切换保存一次 |

> 最容易踩的两个组合：① 以为 GitHub 授权完仓库就自动连上了，其实还要在 Railway 选一次；
> ② 把本机 `.env` 里的短口令照抄到云上，被生产自检拦下，表现为容器反复重启、服务一直 offline。

### 2.3 连上仓库后冒出随机服务名 / Root Directory 被填成仓库名

新版控制台的 `Connect Repo` 有时会变成「**用这个仓库新建一个服务**」，于是画布上出现
一个随机名服务（如 `charming-flow`，带 `NEW` 标），同时把原来那个空服务标成
`Service will be deleted`，顶部变成 `Apply N changes`。这是正常行为：旧服务从没部署过、
没有域名也没有卷，删掉没有数据损失；服务名只是显示名，之后可在 Settings 里改回去。

**但有两件事必须处理，否则第一次构建必失败：**

| 现象 | 问题 | 怎么做 |
|---|---|---|
| Root Directory 被自动填成 `baoyu-zhang/AI-Server` | 这是**仓库内的子目录**路径，不是仓库名。根 Dockerfile 里有 `COPY server/...` 和 `COPY web/...`，构建上下文必须是仓库根 | 清空或填 **`/`**，改完再 Apply；保持 `/` 也是 `railway.json` 能被读到的前提 |
| 旧服务上填过的 Variables / 挂过的卷 | 变量与卷是**服务级**配置，换服务不会自动迁移 | 在新服务的 Variables 页签重新确认 5 项，重新挂卷 `/app/data` |

推荐顺序（省额度，别一上来就 Deploy）：

1. 先把 Root Directory 改成 `/`。
2. 点 `Details` 扫一眼 N 条变更，确认只是「新建服务 + 删除旧空服务 + Source 配置」。
3. 点 **`Apply N changes`** 让服务实体就位（`Deploy` 会同时触发构建，变量没齐就白跑）。
   若 Apply 自己就开始了构建，别慌：那次大概率因缺 `DEEPSEEK_API_KEY` 快速失败，补齐后再 Redeploy 即可。
4. 在新服务 **Variables** 补齐 5 项 → 挂卷 `/app/data`（0.5GB）→ 再触发 **Deploy**。
5. Build Logs 里应看到两阶段：`web` 构建 `npm ci && npm run build`，`app` 构建 `npm ci --omit=dev`；
   Deploy Logs 出现 health 200 后 Networking → Generate Domain。

> `Wait for CI` 保持**关闭**：仓库里没有 GitHub Actions，打开会一直等不到 CI 结果而不部署。
> `Source Repo` 显示 `baoyu-zhang/AI-Server`、`Branch connected to production` 显示 `main`，
> 这两项对了就说明代码来源已经通了。

---

## 三、先挂 Volume（最关键，别跳过）

容器文件系统每次部署都会重建。**不挂卷 = 每次 git push 后所有会话、账号、知识库全部清零。**

1. Service → **Volumes** → **New Volume**
2. Mount Path 填：`/app/data`（必须与 `APP_DATA_DIR` 完全一致，大小写敏感）
3. Size：**试用计划上限 0.5GB，填 0.5GB**（纯聊天够用，见 2.1 节）；
   Hobby 计划可填 5GB，需要开知识库检索时再升级
4. Create → Railway 会自动重新部署

为什么只有这一个目录：所有运行时状态都收敛到了 `server/paths.js` 里定义的 `APP_DATA_DIR`
（SQLite、上传原件、向量索引、聊天图片、签名密钥、备份、embedding 模型缓存）。
Railway 每个服务只能挂一个卷，所以这一步是「全部持久化」还是「全部丢失」的分界线。

> 注意：Railway **不会自动备份卷**。项目内的自动备份（`backup.js`）写在同一个卷里，
> 只能防误删数据，防不了卷本身损坏。重要数据请定期用 `npm run db -- backup` 后把文件下载到本地，
> 恢复命令见 `命令清单.md` 的「备份与恢复」一节。

---

## 四、填环境变量

Service → **Variables** → 把 `.env.production.example` 里的**必填 5 项**填进去：

```
DEEPSEEK_API_KEY=sk-真实key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<12位以上随机串>
APP_DATA_DIR=/app/data
IMAGE_SIGN_SECRET=<openssl rand -hex 32 生成>
```

注意事项：

- **不要手动设 `PORT`**：Railway 会注入，应用已用 `process.env.PORT || 3000`。
- 弱口令会被 `security.js` 的启动自检拦下（进程直接退出，日志里有中文原因），这是故意的。
- `NODE_ENV` / `LOG_TO_FILE` / `HF_ENDPOINT` 已写进 Dockerfile，不必重复填。
- 可选：`WARMUP_EMBEDDING=1`（后台预热模型，第一个用户不用等）、`OPS_ALERT_WEBHOOK`（错误阈值告警）、`IMAGE_SIGN_TTL_DAYS`（图片链接有效期，会让历史图片过期，慎开）。

---

## 五、拿在线地址

1. Service → **Networking** → **Generate Domain**
2. 得到 `https://xxxx.up.railway.app`，平台自动配置 TLS，无需证书操作。
3. 验证三件事：

```bash
# ① 健康检查（应返回 ok:true / ready:true）
curl -s https://xxxx.up.railway.app/api/health

# ② 首页必须是 HTML 登录页，不是 401 的 JSON
curl -i https://xxxx.up.railway.app/ | head -5

# ③ 登录接口通
curl -s -X POST https://xxxx.up.railway.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你设的强口令"}'
```

4. 浏览器打开域名 → 用 `ADMIN_USERNAME/ADMIN_PASSWORD` 登录 → 发一句话 → 刷新看历史还在 →
   上传一张图 → 刷新看图还在。这四步全过，说明卷、静态托管、图片持久化都正确。

之后每次 `git push origin main`，Railway 自动重新构建部署，域名不变。

---

## 六、出问题先查这张表

| 现象 | 大概率原因 | 怎么确认 |
|---|---|---|
| 部署日志 `No start command found` | 面板没读到根 `railway.json` / Builder 没切成 Dockerfile | Settings → Build 手动指定，Config File 写 `/railway.json` |
| 容器反复重启、日志有「缺少 DEEPSEEK_API_KEY」 | 变量没填或填了示例值 | Variables 核对，重新 Deploy |
| 日志有「生产配置自检未通过」 | 弱口令 / 数据目录不可写 | 按日志里的中文提示改；目录不可写通常是卷没挂 |
| 健康检查一直 `Starting Container` 直到超时 | healthcheckPath 不是 `/api/health`，或应用没起来看日志 | 先用 Deploy Logs 看启动报错；timeout 保持 300s |
| 打开域名是 404 / 只有 JSON | 用了旧的 `server/Dockerfile`（只有后端） | 确认根 Dockerfile 生效；`web/dist` 由构建阶段生成 |
| 打开域名是 401 JSON | 静态托管挂到了鉴权之后（老版本代码） | 确认推的是最新 main |
| 每次部署后数据全空 | **卷没挂**或 Mount Path 不是 `/app/data` | Volumes 页核对路径 |
| 首次对话特别慢（1 分钟以上） | embedding 模型首次下载几百 MB | 设 `WARMUP_EMBEDDING=1`；模型缓存已在卷里，第二次部署不再重下 |
| 历史图片 403 | `IMAGE_SIGN_SECRET` 变了，或开了 `IMAGE_SIGN_TTL_DAYS` 且链接过期 | 固定密钥；关掉 TTL 或重新发图 |

---

## 七、本地与云上的差异（一句话记住）

| | 本机 | Railway |
|---|---|---|
| 前端 | vite dev server :8082 | 构建成静态文件，Express :PORT 直接托管 |
| 数据目录 | `server/data/`（默认） | `/app/data`（卷） |
| HTTPS | 无 | 平台自动 |
| 进程守护 | pm2（fork 单实例） | 平台管理，单副本（SQLite 与内存限流要求单实例） |
| 日志 | `server/data/logs/` 文件 | stdout，Railway Deploy Logs |

单实例是**当前架构的硬约束**：限流、配额、登录尝试、会话归属、MCP 工具索引都在进程内存里，
开多副本会互相打架。要横向扩容得先做 P3（迁 Redis / PostgreSQL），那部分本次按你的要求暂缓。

---

## 八、费用与免费替代方案（2026-11-12 核对官方定价页）

### 8.1 Subscribe 那个页面是什么

控制台弹出「Subscribe / Hobby $5 /mo」是**升级引导页，不是付款墙**，右上角标的是试用剩余天数。
直接关掉即可继续部署，不用绑卡。试用期 30 天、一次性 $5 额度，用完或到期后账号**自动**回落到
Free 计划（$0/月 + 每月 $1 额度）；若面板里出现了一个「inactive 的 Hobby 订阅」，到
`https://railway.com/workspace/plans` 点 Cancel Plan 就能退回 Free。

### 8.2 Hobby 的 $5 不是「送 $5」

| 项 | 说明 |
|---|---|
| `$5 minimum usage` | **每月最低消费 $5**，其中含 $5 用量；用不满也照扣 $5 |
| 超出部分 | 按秒计费：内存 ≈ $10/GB·月、CPU ≈ $20/vCPU·月、卷 ≈ $0.16/GB·月、出网 $0.05/GB |
| 卷上限 | 5 GB（Free 只有 0.5 GB），RAM 上限从 0.5 GB 提高到 48 GB |
| 绑定方式 | 需要信用卡，按账单周期后付费；记得在 Billing 里设 **usage limit** 防超支 |

**本项目粗估（按是否用知识库分两种情况）**：

| 场景 | 常驻内存 | 月用量 | Hobby 实付 |
|---|---|---|---|
| 纯聊天（不传文档、不设预热） | 0.2–0.3 GB | ≈ $3–4 | **$5**（最低消费兜底） |
| 开启 RAG 检索 / 设了 `WARMUP_EMBEDDING=1` | 0.6–0.8 GB | ≈ $7–9 | **$7–9** |

CPU 按平均 0.05 vCPU ≈ $1/月、卷 1GB ≈ $0.16/月、出网忽略。
DeepSeek API 的 token 费另算，与 Railway 无关。

### 8.3 三条路怎么选

| 目标 | 做法 | 花钱 | 代价 |
|---|---|---|---|
| **只是想拿到一个 https 地址、验证部署链路、录一段演示** | 关掉 Subscribe 页，用剩余试用期按第二～五节部署 | **0 元** | 试用结束服务暂停；卷 30 天后可能被删，先导出数据 |
| **要一个长期在线、刷新数据还在的地址** | 订阅 Hobby + 挂 5GB 卷 + 设用量上限 | 约 **$5–10/月** + API 费 | 需信用卡；定期把卷里的 `app-*.db` 下载本地备份 |
| **一分钱不花但要长期可访问** | 用 Cloudflare Tunnel / 内网穿透把本机 `localhost:3000` 暴露出去（pm2 已在跑） | 0 元 | 电脑必须开着、家宽上行不稳、不适合给别人当正式服务 |

> **不建议 Render Free 作为免费替代**：它的免费 Web 服务**没有持久盘**、15 分钟无流量就休眠，
> 且每次重启/休眠都会清空本地文件（官方原话：local SQLite databases 会丢）。
> 那等于把本项目最关键的「刷新后会话与图片还在」直接打回原形。
> Koyeb 免费档同样要信用卡预授权且无持久卷，Fly.io 新用户已无免费层。
