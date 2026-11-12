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
2. Railway 账号：新账号有一次性 $5 试用额度（30 天，无需信用卡）；之后 Free 计划每月 $1 额度、卷上限 0.5GB，**自定义域名需要 Hobby（$5/月）**，但 `*.up.railway.app` 免费域名 Free 就能用。
3. 一个可用的 DeepSeek API Key。

> 卷大小建议：embedding 模型缓存约几百 MB，加上数据库与图片，**免费 0.5GB 会比较紧**。
> 只做演示可以先试 Free，长期用建议 Hobby（5GB，$0.15/GB/月）。

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

---

## 三、先挂 Volume（最关键，别跳过）

容器文件系统每次部署都会重建。**不挂卷 = 每次 git push 后所有会话、账号、知识库全部清零。**

1. Service → **Volumes** → **New Volume**
2. Mount Path 填：`/app/data`（必须与 `APP_DATA_DIR` 完全一致，大小写敏感）
3. Size：演示 1GB 起，建议 5GB（Hobby）
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
