# 更新日志

本项目所有值得记录的版本变更均记于本文件，格式遵循 Keep a Changelog 风格，
版本号采用语义化版本。当前处于「第二阶段：能签」，产品尚未正式商用。

> 版本号与根 `package.json` / `server/package.json` / `web/package.json` 保持一致
> （三处均为 `1.0.0`，CI 静态门禁会断言三者同步）。

## [Unreleased]

### 修复

- **工具调用失败不再"卡一下"**：`getWeather` 原来是内联实现，单次 8 秒硬超时，且失败抛的是
  undici 原始英文错误（`The operation was aborted due to timeout`）。长跑进程里复用到的坏连接
  会一直挂到超时（实测日志：一轮 `POST /agui` 23.2 秒，两个 `getWeather` 都 abort，而同一台
  机器新开进程直连 open-meteo 只要 ~0.9 秒），模型看到英文错误还会再试一次、再等 8 秒。
  - 抽出 `server/weather.js`：时间预算切成 **两次 3.5 秒**——首次超时会销毁坏 socket，
    第二次走新连接通常立刻成功（实测北京那次 6.1 秒返回，正是"首超时 + 重试成功"）；
    最坏耗时 8 秒 → 7 秒，正常链路仍是 ~1.8 秒。
  - 失败文案改成中文并**明确要求模型不要再调用** `getWeather`，直接把降级结论给用户，
    省掉一整轮无谓的模型重试（原来那轮要再多 8 秒 + 一次模型往返）。
  - 并发去重：模型一轮里发两个完全相同的 `getWeather` 调用（实测出现过）时共享同一个
    in-flight promise，只打一次外部接口；成功结果再缓存 5 分钟，重复追问直接命中。
  - **禁用连接复用（治本）**：给本模块所有请求配 keepAliveTimeout≈0 的 undici Agent（`dispatcher`
    参数），响应一到 socket 就关闭，连接池里永远没有闲置连接——"复用到对端已悄悄关掉的坏连接"
    从源头消失，重试降级为纯兜底。代价是每次多一次 TCP+TLS 握手（~50~80ms，相对 3.5 秒预算可忽略）。
  - 阶段播报（治"卡"的感知）：`weatherReport` 新增 `onStage` 回调，每次尝试前播报
    「正在查询「××」的天气…/上一次请求失败，正在重试…」；服务端经 hooks.onToolProgress 转成
    AG-UI 自定义事件 `tool_progress` 下发，前端工具卡片在 running 状态下显示品牌色呼吸的
    进度行——用户看到的是"在干活"而不是"卡死了"。
  - 慢请求埋点：外部请求耗时超 2 秒打 `[weather] 慢请求` warning，下次连接层出问题
    日志里直接有证据，不用等用户截图。
  - 新增 `server/test-weather.cjs`（8 个用例：成功 / 首次超时后重试成功 / 连续失败 /
    并发去重 / 查不到城市 / 缓存命中 / 阶段播报 / keep-alive 用本地服务器实测"用完即关、
    池中无闲置 socket"），全部不联网或只连本地；`npm run test:weather`。

- **图片不再被挂到"当前这句话"上**：原来 `prepareChatStream` 取的是整个会话的图片池
  （`getSessionImages(sessionId)`），再全量拼到最后一条 user 消息；后果是用户几天前传过一张图，
  之后每一句提问都会被模型当成"这条消息带图"，模型于是每轮先声明"图与问题无关"，
  且 `hasImages` 恒为真，模型被永久钉在视觉模型上。
  - `aguiToChatMessages(messages, resolveImage)` 改为按"哪条消息传的图就挂回哪条"就地挂载，
    并按 `fileId` 去重；取不到 base64（图已被 30 天清理）时静默跳过，不让整轮请求失败。
  - 回填顺序修正：`hydrateSessionImages` 必须先于历史还原，否则服务重启后首个请求取不到图。
  - 新增 `countImageParts` / `planImageMount`：模型选择与日志口径改为"本轮实际挂了几张"，
    不再按"会话里存了几张"；`attachImagesToLastUserMessage` 降级为纯兜底——只有裁剪把带图
    那条消息整条删掉时，才把最近一张补挂回去（附一行说明，避免模型误解为本轮附件）。
  - 附件清单提示词同步改口：「图片挂在其上传的那条消息上，无关时不要提及」。
- **不再对"历史里的旧图"弹"已切换视觉模型"**：`hasImages` 决定模型、`countLastUserImages`
  决定提示，两者分开。历史消息里躺着图时模型仍必须走视觉（否则看不见图），但那不是
  "用户这轮上传了图片"，原样提示会让用户以为系统搞错了。
- **兜底挂图加闸**：`planImageMount` 新增 `allowFallback`，只有 `trimMessages` 真的裁剪过
  才允许把会话里的旧图补回最后一条 user。没裁剪却找不到图，说明这轮本来就没有图——
  原逻辑会把旧图硬塞回来，导致每轮都被判成视觉任务、每轮都弹切换提示。
- **计划面板改为消息内嵌**：原先 `PlanPanel` 是整块挂在消息列表外/顶部的常驻卡片，看起来像
  全局横幅——用户反馈"三步计划为什么一直在聊天列表最上面，不跟当前对话放一起"。现在计划挂到
  **发起 `planSteps` 调用的那条 AI 回复内部**（工具步骤卡片上方），一份计划对应一条消息，
  往下读别的消息时跟着滚走；同一会话里做过多次计划，也只会在各自那一轮出现。
  - 归属识别：`planSteps` 工具调用本身就在引擎消息的 `toolcall` 块里，所以记住"哪个
    `toolCallId` 对应当前 `agentState.plan`"，渲染时按步骤反查。**不记消息 id**——只有工具
    调用、没有正文的 AI 消息会被合并到下一条（保持单气泡），消息 id 会消失，而 `toolCallId` 跟着步骤走。
  - 时序：`/plan` 可能在 `TOOL_CALL_*` 之后才到，也可能早于引擎把消息同步给 Vue（同步走
    `queueMicrotask`）。所以 `syncPlanOwner()` 只做"能落定就落定"，落不定由渲染时的
    `resolvePlanOwner()` 懒解析兜底，不依赖任何事件顺序。
  - 失效回退：切会话 / 重放 / 刷新都会换一批消息，记录的 id 可能已不存在 → 回退到"最近一次
    `planSteps` 调用"。因此刷新恢复、历史会话恢复都不需要额外持久化归属关系。
  - `PlanPanel` 增加可选 `plan` prop（不传仍读 `agentState.plan`，保留"对话之外也能看计划"
    的用法）；`isPlanState` 类型守卫上移到 `store/chat.ts` 供两处共用；`ChatMessage` 新增
    `plan` 字段并随展示快照持久化（写入时深拷贝，避免存了 `agentState` 的响应式引用后跟着 delta 漂移）。

### 新增

- **多步骤计划（`planSteps`）**：模型可把复杂任务拆成 2~6 步，进度通过共享状态
  `STATE_DELTA` 的 `replace /plan` 整数组下发给前端，界面顶部渲染成时间轴。
  - 服务端新增 `planSteps`（声明计划）与 `getWeather`（真实 HTTP，open-meteo）两个工具，
    以及 `buildPlan` / `advancePlan` / `settlePlan` 三个纯函数负责计划生命周期。
  - 进度由**工具执行完成**这一客观事件驱动，不依赖模型反复上报，模型无法自行篡改进度；
    声明了 `tool` 的步骤只有同名工具执行完才推进，避免 `renderChart` 这类旁支工具把流程带乱。
  - 前端新增 `web/src/components/PlanPanel.vue`，自身订阅 `agentState.plan`（不接收 props），
    演示了"在对话组件之外读取实时状态"；五态渲染 pending / running / done / failed / skipped。
  - 收尾规则按步骤性质区分：声明了 `tool` 却没执行 → `skipped`；纯写作步骤 → 本轮产出过
    正文即 `done`。实测「杭州三日游」全流程 3/3 步正确收敛。
- **生成式 UI（受控档 / L1）**：新增 `renderChart` 工具，模型把数据作为工具参数下发，
  前端 `web/src/ui/` 校验后渲染 `BarChart.vue`。未注册组件一律不渲染，props 校验失败降级成
  "原因 + 原始入参"，并留有 `setUiIssueSink` 埋点出口。校验层零框架依赖，可脱离浏览器单测。

- **评测体系补齐为四层（离线一键回归）**：原来只有 RAG 检索层一套 golden set；本轮把业务逻辑
  也纳入评测，回答"改完有没有弄坏老功能"。
  - 新增 `server/eval/behavior-golden.json`（19 条确定性用例：图片挂载 10 + 计划状态机 9）与
    `server/eval/run-behavior.js`（声明式 expect 断言，失败打印具体路径与实际值，落
    `results/behavior-<tag>.json`）。用例覆盖本轮全部坑：历史图误挂、纯文本误判视觉、
    `planSteps` 自引用、旁支工具乱推进、有正文被判 skipped、兜底挂错图等。
  - 把 `buildPlan` / `advancePlan` / `settlePlan` 从 `index.js` 抽到 `server/plan-core.js`
    （纯函数，行为不变）：`index.js` 与评测脚本共用同一份，保证"跑的代码"和"测的代码"不漂移。
  - 新增统一入口 `server/eval/eval-all.js`：串起①行为 Golden Set ②天气降级 ③RAG 检索
    ④UI spec 四层，任一层失败整体退出码 1。`npm run eval:all` 全跑，`npm run eval:quick`
    只跑业务逻辑层（秒级反馈）。新增脚本 `eval:behavior` / `eval:all` / `eval:quick`。
  - 四层实测：行为 19/19、天气 8/8、检索 hit@3 95% / MRR 0.850、spec 18/18，`eval:all` 4/4 全通过。

- **新增跨编辑器可复用的开发 skill（`add-tool`）**：把"给项目加一个工具"的五步流程固化成
  `SKILL.md`，让 AI 编程助手按同一套规范执行，避免漏 UI 联动/测试/文档/重启生效等步骤。
  - `.workbuddy/skills/add-tool/SKILL.md` 为唯一事实源，遵循 Agent Skills 规范（YAML
    frontmatter + Markdown 指令），内容含三类工具的区分、`description`/`inputSchema` 的正确写法、
    三个"改了不报错但静默失效"的雷区、验收清单。
  - 新增 `scripts/sync-skills.sh` 一键同步到 `.trae/skills/`（Trae 编辑器的发现目录不同），
    用 `rsync --delete` 保证两端一致、无 rsync 时退化成 `cp`；脚本幂等，已实测两端内容一致。
  - skill 属开发期元信息，不参与运行时、不影响 3000 端口；后端仍按既有流程改动重启生效。

### 变更

- **AG-UI 正文改为标准三连**：`TEXT_MESSAGE_CHUNK` → `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` × N + `TEXT_MESSAGE_END`。
  原因：CHUNK 是官方简写事件，但需要客户端实现展开逻辑；且「CHUNK + 显式 END」经官方
  `@ag-ui/client` 的 `transformChunks` 展开会产出**两个** `TEXT_MESSAGE_END`，严格的第三方客户端
  会当成重复收尾。改成三连后，服务端发出的流与客户端展开结果完全一致（实测事件序列零差异），
  协议层不再依赖任何前端库的展开实现，换框架 / 接第三方客户端 / 作为开放接口对外都直接可用。
  同步更新 `server/test-agui-protocol.mjs` 断言（新增「不再下发 CHUNK」「START/END 数量配对」
  「分片可归属到已 START 的消息」三项）与 `PROJECT-MAP.md` 用例说明。

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
