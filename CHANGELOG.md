# 更新日志

本项目所有值得记录的版本变更均记于本文件，格式遵循 Keep a Changelog 风格，
版本号采用语义化版本。当前处于「第二阶段：能签」，产品尚未正式商用。

> 版本号与根 `package.json` / `server/package.json` / `web/package.json` 保持一致
> （三处均为 `1.0.0`，CI 静态门禁会断言三者同步）。

## [Unreleased]

暂无。

## [1.0.0] - 2026-11-13

首个对外私有化交付准备版本，汇总第一阶段「能装」与第二阶段「去 demo 痕迹 / 能签」
的已完成工作，并补齐对外交付所需的法律、版本、品牌与运维文档。

### 新增

- **第一阶段「能装」**
  - 会话附件持久化：新增 `session_files` 表与 `uploads/session-files` 目录，
    会话中的附件在服务重启后不再丢失。
  - 版本化数据库迁移：使用 `PRAGMA user_version` 管理 schema 变更（当前为 v5）。
  - 整卷备份与恢复演练：将 `app.db` 与 `images/`、`uploads/`、`vector-index/`
    打包为 `tar.gz`，并完成恢复演练；备份产出成对的 `.db` 与 `.tar.gz`。
  - 离线 embedding 模型预下载脚本（`scripts/prefetch-model.mjs`）与
    `Dockerfile.offline`，支持无外网环境部署。
  - `deploy/docker-compose.yml` 与 `deploy/.env.example` 部署编排与配置模板。
  - `scripts/setup.mjs` 初始化向导。
  - 离线安装包构建脚本（`scripts/build-offline-bundle.sh`），
    含 `--platform linux/amd64` 架构对齐与 `BUILD-INFO.txt` 构建信息。
- **第二阶段第一包「去 demo 痕迹」**
  - 新增 `deploy/mcp.example.json` 作为随文档交付的 MCP 配置模板。
- **第二阶段第二包「能签」**
  - 运行时品牌配置：新增 `server/branding.js` 与公开端点 `GET /api/branding`，
    前端新增 `web/src/config/branding.ts`；产品名、Logo、登录页文案、协议链接、
    行业术语字典与「候选人」页签开关全部来自数据卷 `branding.json`，
    **同一份镜像换客户无需重新构建**。
  - 轻量许可校验：新增 `server/license.js` 与 `scripts/gen-license.mjs`，
    支持客户名 / 版本 / 坐席 / 到期日 / HMAC 签名校验，登录页显示脱敏授权状态；
    **默认只提示、不阻断**，仅 `LICENSE_ENFORCE=1` 时到期或超额才拒绝新登录。
  - 品牌与许可模板：`deploy/branding.example.json`、`deploy/license.example.json`；
    `deploy/.env.example` 补 `BRANDING_FILE` / `LICENSE_FILE` / `LICENSE_SIGN_SECRET` /
    `LICENSE_ENFORCE` 说明；根 `package.json` 新增 `license:generate`。
  - 法律与合规：`docs/legal/` 下五份模板草案（说明页、用户协议、隐私政策、
    数据处理协议 DPA、软件许可协议）、根目录 `LICENSE` 权属声明。
    **均为模板草案，不构成法律意见，签署前必须由法务审核。**
  - `docs/操作手册.md` 一页纸操作手册（离线部署、管理员、账号管理、容器内的
    备份恢复命令、换品牌与装许可、常见故障）。
  - `.github/workflows/verify.yml` CI 门禁：依赖安装、前端构建、后端语法检查、
    交付物与版本号静态断言；明确把需运行服务与真实 API Key 的验收留给预发人工执行。
  - 离线安装包现在随包携带 `LICENSE`、`CHANGELOG.md`、`docs/`（协议 + 手册）与
    `templates/`（品牌 / 许可 / MCP 模板），`SHA256SUMS` 改为动态枚举全包文件。

### 变更

- `server/mcp.json` 清空为 `[]`，移除内置 demo 配置。
- 测试用 MCP 配置从 `server/mcp.json` 迁移到 `server/eval/fixtures/mcp-demo.json`。
- `.dockerignore` 新增排除 `server/eval`、`server/samples`、`server/*.md` 等
  验收脚本、样例与内部文档，使交付镜像只保留运行时代码。
- 前端标题改为中文、替换为自绘 favicon；`main.ts` 改为先加载品牌再挂载，
  `LoginGate` / `App` / `SidePanel` / `DocPanel` / `CandidatePanel` 改用品牌单例与术语字典。
- **HR 场景红线**：`server/score-resume.js` 的低分结论由「不通过」改为「需人工复核」，
  评分结果末尾固定附「辅助参考、不构成录用/淘汰决定、需人工复核」声明；
  阈值、权重与证据链逻辑不变。
- 三份 `package.json` 版本统一为 `1.0.0`；根与 server 的 `license` 从
  `ISC` / 空改为 `UNLICENSED`（商业私有化交付，不采用开源许可）。

### 修复

- 服务启动冒烟一度表现为「日志只停在 dotenv、健康检查 502」：根因是本机
  `NODE_OPTIONS` 被 IDE 注入了 shim，清空 `NODE_OPTIONS=` 后启动与接口全部正常；
  该前置条件已写入交付清单的故障速查。
- `docs/操作手册.md` 初版让客户机直接执行 `node scripts/setup.mjs` /
  `node server/backup.js`，但离线包内不含源码目录；已改为 `cp .env.example .env` 与
  `docker compose exec app node ...`。

### 已知限制

- 本机无 Docker，离线镜像构建、`docker compose up`、健康检查均**未在真机验证**；
  离线包的文档复制与动态校验和逻辑已通过 `bash -n`，但未实际打出一个完整包。
- 无 CI 环境：本轮已补 `.github/workflows/verify.yml` 配置与本地等价检查，
  但**无法在 GitHub 上实跑验证**。
- 无多租户、无 SSO；云上数据为空库；删除用户全部数据仍需人工按运维流程处理
  （无自动化删除接口）；无数据留存自动清理定时任务。
- License 校验默认仅作提示、不阻断使用；HMAC 签名用于防误改与交付留痕，
  **不是防破解 DRM**，私有化交付下客户可接触镜像与源码。
- 协议四件套均为模板草案，含大量 `{{占位符}}`，未经法务审核不得直接签署。
- 品牌接口 `/api/branding` 是未登录可读的公开端点，只返回白名单字段；
  请勿在 `branding.json` 中写入任何密钥或内部信息。
