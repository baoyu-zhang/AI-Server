# AI-Server 项目文件说明

> 这份文档回答三个问题：哪些文件真正跑在线上链路里、每个文件解决什么问题、背后对应哪些知识点。
>
> 判断标准：**"是否进入前端实际调用的请求链路"**。只被脚本引用、或没有任何调用方的文件，单独归类。
> 行数以当前代码为准（`wc -l` 实测，2026-11-13）。
>
> 配套阅读：`PRODUCT-GUIDE.md` 第 2 章（技术选型与替代方案对比）、第 3 章（全部端点与接入示例）、`docs/操作手册.md`（运维视角）。

---

## 一、总览（按层分组，共 34 个模块、9601 行）

> 阅读策略：**先纵向（跟着一次请求走），再横向（按层读）**。下面四层从上到下，正好是请求穿过服务的顺序。

### 第 1 层：入口与横切（每个请求都过这里）

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| `index.js` | 2580 | 唯一入口：Express 挂载顺序、全部路由、AG-UI 协议适配、工具定义 |
| `security.js` | 136 | 生产配置硬校验、CORS、安全响应头、请求体限制（最先挂） |
| `auth.js` | 272 | session + API Key 双凭证、登录/注册/登出、登录失败限流 |
| `rate-limit.js` | 63 | 内存滑动窗口限流（按 IP） |
| `quota.js` | 100 | 按用户每日 Token 配额（DB 计数，不是内存） |
| `prompt-guard.js` | 99 | 提示注入防护：拦截试图改写 system 指令的输入 |
| `runtime.js` | 128 | `/api/health` 探针、`markReady()`、优雅退出（`attachGraceful`） |
| `ops-alert.js` | 207 | 运行时告警（配额超限、模型持续失败等推给管理员） |
| `branding.js` | 176 | 品牌配置（卷内 branding.json，公开 `/api/branding`） |
| `license.js` | 239 | 轻量许可校验（HMAC 签名、到期/坐席，默认只提示不阻断） |

### 第 2 层：聊天主链（业务核心，跟着一次提问走）

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| `chat-core.js` | 411 | 聊天主链路：裁剪/附件/选模型/发起流（协议细节零依赖） |
| `models.js` | 148 | 模型注册表与降级链（快速/思考/视觉三档） |
| `model-fallback.js` | 91 | 单供应商多模型降级（主模型挂了自动切） |
| `mcp-client.js` | 412 | MCP 工具客户端：stdio/http/sse 三种传输、审批标记 |
| `mcp-demo-server.js` | 65 | 测试用玩具 MCP server（已从交付配置摘除，仅验收用） |

### 第 3 层：检索与业务工具（Agent 的"手"）

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| `rag-vector.js` | 621 | 向量 + BM25 双路检索与 RRF 融合、文档入库 |
| `rag-utils.js` | 324 | 文档解析、清洗、三级分块 |
| `session-files.js` | 301 | 会话附件入口（磁盘为准 + 内存缓存） |
| `session-files-store.js` | 210 | 附件持久化（session_files 表 + uploads/session-files/） |
| `score-resume.js` | 450 | 简历×JD 评分（维度+门槛+证据链，独立于协议层可直调） |
| `weather.js` | 156 | 天气查询（专用 Agent 禁用 keep-alive 根治坏连接复用 + 两次 3.5 秒重试 + 并发去重 + 5 分钟缓存 + 阶段播报 onStage，失败抛中文指引；`npm run test:weather`） |
| `candidates-store.js` | 254 | 候选人池（cand 字段级增删改查） |

### 第 4 层：数据与状态（落在哪里）

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| `db.js` | 277 | node:sqlite 单库 + WAL + 外键 + `PRAGMA user_version` v5 版本化迁移 |
| `threads-store.js` | 224 | 会话线程与运行快照（threads / thread_runs） |
| `image-store.js` | 154 | 聊天图片落库 + HMAC 签名 URL（chat_images 表） |
| `usage-store.js` | 59 | 模型用量记账（model_usage 表） |
| `memory-store.js` | 75 | 用户长期记忆（user_memory 表，前端记忆面板） |
| `audit.js` | 75 | 操作审计（audit_log 表，只追加） |
| `account-routes.js` | 214 | 账号自助/记忆/会话删除/用户停用路由 |
| `api-keys.js` | 101 | API Key 签发与吊销（外部系统调用用） |
| `webhook-store.js` | 169 | 事件回推（HMAC-SHA256 签名 + SSRF 防护） |
| `candidates-store.js` | — | （见第 3 层） |

### 第 5 层：运维与交付（不碰业务，出事时兜底）

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| `backup.js` | 247 | 整卷备份（VACUUM INTO 的 .db + tar.gz 打包三类文件目录） |
| `restore.js` | 464 | 备份校验/列表/恢复（路径穿越防护、--force 留底） |
| `logger.js` | 185 | 文件日志（轮转、保留天数） |
| `paths.js` | 70 | 路径单卷布局（APP_DATA_DIR 开关，云上 /app/data） |

**读代码建议顺序**（一天能走完前四步）：`index.js` 的启动段（挂载顺序）→ `/agui` 路由 → `chat-core.js` 的 `prepareChatStream` → `index.js` 的 `createTools` → `rag-vector.js`。这五段串起来就是一次完整问答；其余 29 个文件都是这根主轴上的"挂件"，按层再读。

---

## 二、运行时文件详解

### 1. `index.js`（855 → 现 2580 行）— 入口与协议层

**职责**：Express 服务、工具定义、AG-UI 协议事件编码、RAG 管理端点。

内部可分成三块，边界比较清楚：

| 区块 | 位置 | 内容 |
|---|---|---|
| 工具集合 | `isAttachmentQuery` / `mergeByRank` / `createTools` / `createFrontendTools` / `createApprovalTools` | 模型能调用的全部能力 |
| 协议层 | `aguiToChatMessages` / `/agui` 路由 | AG-UI 输入转 AI SDK 消息、事件流下发 |
| 资源管理 | `/api/upload-doc` 等 6 个端点 | 文档入库、文档列表、会话附件 |

**关键函数**

- `createTools(sessionId)`：工厂函数而非模块级常量。因为附件检索要 `sessionId`，做成常量就只能靠全局变量传，并发时会串号（A 用户检索到 B 用户的附件）。闭包天然隔离。
- `createFrontendTools(definitions, serverTools)`：把浏览器下发的工具定义转成 AI SDK 工具，**不带 `execute`**。同名一律服务端优先——`definitions` 来自请求体，是不可信输入，允许覆盖的话前端就能下发同名 `searchKnowledgeBase` 劫持检索。
- `createApprovalTools()`：同样不带 `execute`，靠协议层把它转成 interrupt，用户确认后才执行。
- `aguiToChatMessages(messages)`：AG-UI 的 `messages` 是扁平的 `TOOL_CALL_*` 事件流，AI SDK 要的是 `assistant(tool-calls) + tool(result)` 结构，这里是两者的翻译层。
- `mergeByRank(lists, topK)`：知识库与会话附件的分数量纲不同（前者 RRF 融合分，后者 cosine），不能直接比 `score`，按名次融合。

**知识点**：Express 中间件与路由、SSE 响应头（`no-transform` / `X-Accel-Buffering: no` 防止缓冲导致"不流式"）、multer 磁盘存储、扩展名白名单、AG-UI 协议事件模型、工具三类执行时机。

**解决的问题**：把"模型能调工具"包装成"前端能消费的流"。难点不在调模型，而在**协议适配**——事件顺序、字段契约、中断恢复。

---

### 2. `chat-core.js`（332 → 现 411 行）— 聊天主链路

**职责**：`/agui` 的实现主体——把 AG-UI 还原出的消息变成一次模型调用。协议（事件编码、SSE 帧）留在 `index.js` 的适配层，这里一行都不出现，所以以后换协议不用动这个文件。

`prepareChatStream()` 是唯一出口，内部五步：

```
trimMessages          裁剪超长上下文（保留最近 10 条以内，清掉悬空 tool 消息）
buildAttachmentSystemPrompt  把本次会话附件清单拼成 system 提示
countImageParts       数本轮消息里实际挂了几张图（决定选不选视觉模型）
attachImagesToLastUserMessage  仅作裁剪兜底：最近一张图补挂到最后一条 user
选模型                 本轮有图 → MODEL_VISION，无图 → MODEL_REASONING
streamText            发起流式请求
```

**关键实现细节**

- `trimMessages`：`structuredClone` 先复制，不改入参；裁剪后如果开头是 `role: 'tool'`，必须 `shift()` 掉——孤立的 tool 消息会让 provider 直接 400（它找不到对应的 tool_call）。
- `toContentParts()`：把字符串 content 和数组 content 统一成 AI SDK 的 content parts。不写这层，数组 content 会被拼成 `"[object Object]"`。
- `streamText` **绝不能 `await`**。await 会等到全文生成完，流式彻底失效（表现为前端卡很久然后一次刷出全文）。这是全项目最容易被改坏的一行。
- `stopWhen: stepCountIs(MAX_AGENT_STEPS)`：多步循环开关。不写这行，AI SDK 默认跑一步就停，模型调完一个工具就结束，不会基于结果继续推理。

**知识点**：token 计数（js-tiktoken / `cl100k_base`）、上下文窗口管理、多模态 content parts、Vercel AI SDK 的 `streamText` / `stopWhen` / `onStepFinish`、消息结构合法性。

**解决的问题**：上下文超限（对话一长就 400 或费用爆炸）、图片无法挂载、多步工具循环开不起来。

---

### 3. `rag-vector.js`（403 → 现 621 行）— 检索引擎

**职责**：文本向量化、向量库读写、双路召回与融合。

**核心函数**

| 函数 | 作用 |
|---|---|
| `getEmbedding` / `getEmbeddings` | 本地 bge-small-zh-v1.5 推理（512 维，mean pooling + L2 归一化） |
| `tokenize` | 中文 bigram + 英文/数字整体，供 BM25 使用 |
| `getBm25Index` | 构建倒排（df / tf / avgdl），带缓存与并发去重 |
| `bm25Search` | Okapi 打分，`k1=1.2, b=0.75` |
| `retrieveCandidates` | 双路各取 `max(topK*4, 20)` 条原始候选 |
| `fuseRRF` | 按名次融合 `Σ1/(60+rank)`，归一到 0~1 |
| `searchVector` | 对外唯一接口，返回 `{score, content, fileName}` |
| `searchWithCandidates` | 返回两路原始候选，供 `inspect` 与将来的 rerank 使用 |
| `getBm25Stats` | 倒排体检：文档数 / 词表 / 平均长度 |

**为什么自己实现 BM25**：Vectra 自带 `queryItems(..., isBm25=true)`，但它要求 metadata 有 `documentId/startPos/endPos` 才能回读原文，否则**静默返回空**；分词器还是英文模型，中文切不动。踩过这个坑才知道"没报错不等于生效"。

**知识点**：embedding 与余弦相似度、BM25（idf / tf 饱和 / 长度归一化）、稀疏检索 vs 稠密检索、RRF 排名融合、缓存失效（`invalidateBm25` 漏调会导致新文档搜不到）、本地模型推理。

**解决的问题**：纯向量检索对"精确串"不敏感——`Retrieval-Augmented Generation` 这种英文全称、`纳税人识别号` 这种专有名词，向量分数会被稀释到 0.40~0.43，跟一堆无关片段挤在一起；BM25 能把它们拉开到 11.99 vs 8.61 的量级差。

---

### 4. `rag-utils.js`（197 → 现 324 行）— 文档解析与切块

**职责**：把 PDF / Markdown 变成干净的文本块。

**关键函数**

- `extractFileText(filePath, ext)`：按后缀分派。Markdown 走 `markdown-it` 渲染再剥标签；PDF 走 `pdf-parse` 的 `PDFParse` 类，`try/finally` 保证 `destroy()` 释放 pdfjs 资源。
- `cleanText(text)`：统一换行、压缩行内空格、去掉 `-- 1 of 1 --` 分页标记、合并竖排单字行。
- `mergeVerticalCharLines(text)`：电子发票这类 PDF 会把"购买方信息"竖着排成单个汉字一行，这里按阈值（单字行占比 > 20%）识别并拼回一行。
- `splitTextIntoChunks(text, 800, 150)`：**三级回退**——段落 → 句子 → 字符窗口。块间保留 150 字符重叠，避免答案正好被切在边界上。

**知识点**：pdf-parse / pdfjs 资源释放、正则零宽断言（`(?<=[。！？；\n])`）、文本清洗、分块策略（语义边界 vs 固定窗口）、重叠窗口的作用。

**解决的问题**：PDF 提取出来的文本很脏（竖排拆字、乱空格、分页符），直接切块会得到大量碎片；切块方式不当则会切断语义，导致检索到了片段但读不懂。

---

### 5. `session-files.js`（158 → 现 301 行，另拆出 session-files-store.js 210 行）— 会话级临时附件

**职责**：用户本次对话临时上传的文件，存内存，向量也算在内存里，**不进长期知识库**。

**关键设计**

- `sessions: Map<sessionId, {files, updatedAt}>`，`SESSION_TTL = 24h` 定时清理，`setInterval(...).unref()` 避免定时器拖住进程退出。
- `MAX_FILES_PER_SESSION = 5`，防止单个会话把内存吃满。
- `searchSessionFiles()`：内存里暴力算点积（向量已 L2 归一化，点积即余弦），不写磁盘。
- 图片走 `addSessionImage`，只存 base64 不做向量化，因为图片由视觉模型直接看。

**知识点**：内存态与持久态的取舍、TTL 与资源回收、`unref()` 的用途、点积等价余弦的前提条件。

**解决的问题**：用户临时上传的发票、简历不该污染长期知识库（否则下次别人的问题会检索到），但又必须能被当前对话检索到。

---

## 三、测试脚本

### `test-agui-protocol.mjs`（830 行）

**性质**：协议契约测试。直接对 `/agui` 发 run，解析 SSE 帧，断言**事件类型、顺序、字段**，不断言模型文案（模型有随机性，断文案必挂）。

前提：服务已在跑。用法：

```bash
npm run test:agui                 # 全部用例
node test-agui-protocol.mjs --list  # 列出用例
node test-agui-protocol.mjs --case=text,rag
```

10 个用例覆盖的能力：

| 用例 | 断言什么 |
|---|---|
| `text` | 基础文本流：RUN_STARTED / STATE_SNAPSHOT / 正文标准三连（TEXT_MESSAGE_START → CONTENT → END）/ RUN_FINISHED；断言**不**下发 MESSAGES_SNAPSHOT（服务端无状态） |
| `server_tool` | 服务端工具：START → ARGS → END → RESULT 闭环 |
| `frontend_tool` | 前端工具只下发调用不给结果（挂起语义） |
| `interrupt` | 审批中断：`outcome=interrupt` 与字段契约 |
| `resume_allow` | resume 允许：执行工具、回传结果、重复 resume 幂等 |
| `resume_reject` | resume 拒绝：不产生副作用 |
| `rag` | 检索工具：TOOL_CALL_RESULT 与 `/sources` 状态增量 |
| `plan` | 多步骤计划：`/plan` 走整数组 replace、status 取值合法、同一时刻最多一个 running、收尾全部进入终态、声明了 tool 的步骤确实被调用过 |
| `long_context` | 历史超过 token 上限时触发裁剪（`CUSTOM:trim_notice`）且仍能正常完成 |
| `bad_request` | 缺 messages 返回 400 |

**知识点**：SSE 帧解析（`data: ` 前缀、`\n\n` 分隔、跨 chunk 的半帧拼接）、契约测试与快照测试的区别、幂等性验证、用 `randomUUID` 隔离测试数据。

**解决的问题**：协议层改动最容易悄悄破坏前端——事件少一个、顺序反了，前端不报错但界面就是不对。这个脚本把"协议正确"变成可回归的。

> `long_context` 替代了原来的 `test-long-chat.js`。旧脚本打的是已删除的 `/api/chat`，而且只 `console.log` 事件、没有断言，跑完还得人眼判断。现在它读 `.env` 的 `MAX_CONTEXT_TOKENS` 自动算填充轮数（默认上限 6000 时约 9 轮），断言服务端确实下发了 `CUSTOM:trim_notice` 且 `droppedMessages > 0`。

---

## 四、评测工具（`eval/`）

这一组回答的是"改完到底有没有变好 / 有没有弄坏老功能"，而不是"我觉得变好了"。
共四层，全部**离线可跑**（不调模型、不联网、不需要服务启动）；统一入口 `npm run eval:all`
一次跑完四层，改完代码最快反馈用 `npm run eval:quick`（只跑业务逻辑层①②）。

| 层 | 脚本 | 用法 | 作用 |
|---|---|---|---|
| ① 业务逻辑 | `run-behavior.js` + `behavior-golden.json` | `npm run eval:behavior -- <tag>` | 19 条确定性用例：图片挂载（10）+ 计划状态机（9），按声明式 expect 校验，落 `results/behavior-<tag>.json` |
| ② 工具降级 | `test-weather.cjs` | `npm run test:weather` | 8 条：超时重试 / 连续失败 / 并发去重 / 缓存 / 阶段播报 / keep-alive 实测 |
| ③ 检索质量 | `run-eval.js` + `eval-dataset.json` | `npm run eval -- <tag>` | 20 题，hit@1/3/5、MRR、分类统计，落 `results/<tag>.json` |
| ③ 对照 | `compare.js` | `node eval/compare.js <a> <b>` | 逐题对比两次结果，列出名次变化与"改善/退化"条数 |
| ③ 语料 | `ingest-corpus.js` | `npm run eval:ingest` / `--list` | 从固定语料重建向量库，保证检索评测语料一致 |
| ④ 生成式 UI | `web/src/ui/spec.selftest.ts` | `node --experimental-strip-types ...` | 18 条：`normalizeBarChart` 脏数据鲁棒性 |
| 统一入口 | `eval-all.js` | `npm run eval:all` / `eval:quick` | 串起四层，任一层失败则整体退出码 1 |

**为什么要分层、且业务层必须确定性**：检索质量用 hit@k/MRR（有排序、有灰度），但图片挂错、
计划乱跳这类 bug 是"输入确定、输出也该确定"的——用模型去测只会引入随机性，反而测不出回归。
所以把它们固化成毫秒级断言（`plan-core.js` 抽成纯函数模块，index.js 与评测共用同一份，
保证"跑的代码"和"测的代码"是同一份，不会漂移）。

**指标定义**

- `hit@k`：正确答案所在片段是否出现在前 k 条。
- **严格口径**：文件名匹配 **且** 片段包含 `expectKeywords` 里**任一**关键词，两个条件都满足才算命中。只用文件名匹配会自我欺骗——文件对了但片段是无关段落，模型照样答不出来。
- `MRR`：`1/正确排名` 的平均值，衡量"排得有多靠前"，比 hit@k 更细。
- `文件级 hit@3` 与 `严格 hit@3` 的差值 = "文件找到了但片段没对上"的数量。
- 行为层用**通过率**（19/19）+ 按分组统计，失败时打印具体断言路径与实际值（如 `steps.0.status 实际 skipped / 期望 done`）。

**知识点**：检索评测方法（hit@k / MRR / 严格口径）、对照组思维（baseline → cleaned → rrf 三份快照）、
Golden Set 分层（确定性业务逻辑 vs 概率性检索质量）、单一事实源（纯函数抽出给生产与评测共用）、
数据治理优先于算法调参。

**解决的问题**：改检索最怕"感觉变好了"。这批数据上就验证过一次：只删掉一篇 21 段同质链接的"磁铁文档"，hit@3 从 80% 涨到 95%，比改任何参数都有效。业务逻辑层则锁住了本轮踩过的全部坑——历史图误挂、纯文本误判视觉、计划自引用、旁支工具乱推进、有正文被判 skipped——以后任何改动一跑就知道老 bug 有没有复活。

---

## 五、端点清单

> 当前端点已扩到 25+ 个（P0–P2 与产品化阶段陆续新增：API Key、Webhook、账号管理、`/v1` OpenAI 兼容层、`/api/branding` 等）。完整清单与每个端点的请求/响应示例见 **`PRODUCT-GUIDE.md` 第 3.6 节速查表**。这里只保留主链路六端点与历史决策。

单协议：**只有 `/agui` 一个聊天入口**，其余 5 个都是资源管理端点，全部有前端调用方。

| 端点 | 前端是否调用 | 说明 |
|---|---|---|
| `POST /agui` | **是（主链路）** | ChatEngine 走这里，AG-UI 协议，唯一的聊天入口 |
| `GET /api/documents` | **是** | 左侧文档栏 |
| `POST /api/upload-doc` | **是** | 上传 → 解析 → 切块 → 覆盖同名旧片段 → 入库，一次完成 |
| `POST /api/documents/delete` | **是** | 按文件名删全部片段 |
| `POST /api/session-files/upload` | **是** | 会话附件上传（文档解析成文本、图片转 base64，都不进知识库） |
| `POST /api/session-files/delete` | **是** | 删会话附件 |

**已删除的 5 个端点及原因**

| 端点 | 删除原因 |
|---|---|
| `POST /api/chat` | 早期自研 SSE 端点。同时维护两套协议，每次改裁剪/附件逻辑都要做两遍回归，收益小于成本。长上下文诊断能力已迁到 `test-agui-protocol.mjs` 的 `long_context` 用例 |
| `POST /api/embedding-add` | 接收前端传来的 `chunks` 直接入库，等于绕过文件解析——任何人都能往知识库写任意文本（语料投毒），还能用同名覆盖已有文档。现已并入 `/api/upload-doc` |
| `POST /api/search-knowledge` | 无调用方。`npm run inspect` 信息更全（带 `dense#N` / `bm25#N` 双路排名） |
| `GET /api/vector-list` | 无调用方。`GET /api/documents` + `npm run inspect` 已覆盖 |
| `POST /api/vector-clear` | 无调用方，且**没有鉴权**——部署到公网后一次 POST 就能清空知识库。清库改为本地删 `vector-index/` 目录或重跑 `npm run eval:ingest` |

**为什么不需要 `/api/embedding-add` 这种"纯文本入库"接口**：`eval/ingest-corpus.js` 需要绕过文件解析时，是直接 `require('../rag-vector')` 调 `batchInsertEmbedding` 的，走进程内调用，不需要开一个 HTTP 口子把写权限交给浏览器。

---

## 六、一次请求的完整链路（2026-11-13 更新：含中间件链）

```
浏览器 ChatEngine
   │  POST /agui  { messages, threadId, forwardedProps.sessionId, state }
   ▼
index.js  启动段（挂载顺序 = 安全边界，顺序错了就是 3.10 那个事故）
   ├─ assertProductionConfig()   security.js  生产缺配直接拒启
   ├─ attachSecurity()           CORS / 安全头 / 请求体上限
   ├─ attachRequestContext()     请求 id、计时
   ├─ express.static(web/dist)   静态托管【必须在 requireAuth 之前】
   ├─ /api/health、/api/branding 公开端点（探针不带 token / 登录页要品牌）
   ├─ app.use(requireAuth)       总闸门：session 或 API Key 二选一
   ├─ /api/auth、/api/admin、accountRouter、/v1/chat/completions
   └─ licenseGate()              只拦登录/注册（默认不阻断）
   ▼
index.js  /agui 路由
   ├─ 限流（rate-limit）→ 配额检查（quota）→ prompt 注入防护（prompt-guard）
   ├─ 会话归属校验 claimSession（sessionOwners，防止用别人的 sessionId）
   ├─ hydrateSessionImages()    先按 fileId 回填会话图片（必须在下面这步之前）
   ├─ aguiToChatMessages()      扁平事件 → AI SDK 消息结构；图片挂回它上传时的那条消息
   ├─ 历史回填（threads-store：threadId → 历史消息 + state）
   ├─ prepareChatStream()       chat-core.js
   │     ├─ trimMessages()                超长则裁剪
   │     ├─ buildAttachmentSystemPrompt() 注入附件清单
   │     ├─ countImageParts()             数本轮挂了几张图（选模型用）
   │     ├─ attachImagesToLastUserMessage() 仅在裁剪把图删掉时兜底补一张
   │     └─ streamText({ stopWhen: stepCountIs(5) })
   │           │
   │           ├─ 模型决定调用 searchKnowledgeBase
   │           ▼
   │        createTools().searchKnowledgeBase
   │           ├─ searchVector()        rag-vector.js  向量 + BM25 → RRF
   │           ├─ searchSessionFiles()  session-files 附件（磁盘惰性回填）
   │           └─ mergeByRank()         两源按名次融合 → { text, sources }
   │           ├─（模型也可能调 MCP 工具 → mcp-client 转发 → 需审批则发
   │           │   interrupt 事件，前端弹卡，恢复后继续）
   │           └─ 工具结果回填，模型继续生成（最多 5 步）
   ▼
落库与记账（RUN_FINISHED 前后）
   ├─ threads-store 保存完整消息快照（刷新后能恢复的依据）
   ├─ usage-store 记 token 用量 → quota 计数
   ├─ audit 写敏感操作（工具审批、配额超限）
   ▼
SSE 事件流：RUN_STARTED → 文本增量 → TOOL_CALL_* → STATE_DELTA(sources) → RUN_FINISHED
   ▼
前端渲染：正文 / 思考过程 / 工具卡片 / 引用来源
```

> 想亲手追一遍：`node index.js` 启动后，开两个终端——一个 `tail -f logs/`（文件日志，logger.js 轮转），一个浏览器 Network 面板看 `/agui` 的 EventStream。日志里的每个函数名都在上面这张图里。

---

## 七、可以怎么用这份地图

**如果只想跑起来**：

```bash
npm install
# .env 里配 DEEPSEEK_API_KEY（可选 MAX_CONTEXT_TOKENS / MODEL_* ）
node index.js
```

> 项目没有配 `dev` 脚本，也没有 nodemon。改完代码要手动重启，这一点和前端的热更新不一样，容易误判"改了没生效"。

**如果改了检索，验证顺序**：

```bash
npm run inspect                                   # 先看两路是否都在干活
npm run eval -- 你的tag                            # 跑指标
node eval/compare.js rrf 你的tag                   # 对照上一次，看退化
```

**如果改了协议层，验证顺序**：

```bash
npm run test:agui
```

**已经没有可以删的文件了**：`test-long-chat.js` 与 5 个无调用方的端点已在这次清理中移除，`uploads/`、`vector-index/` 是运行时数据且已 gitignore。以后新增端点时，先确认它有调用方——两个入口都叫"聊天"时，代价是双份回归。

**哪些文件别动**：`chat-core.js` 里 `streamText` 不能加 `await`；`rag-vector.js` 里新增/删除片段必须调 `invalidateBm25()`；`index.js` 里前端工具同名必须以服务端为准。这三处都是"改错了不报错、但功能静默失效"的位置。

**如果用 AI 辅助开发（跨编辑器通用）**：项目在 `.workbuddy/skills/` 固化了可复用工作流，目前有 `add-tool`（新增一个工具的五步流程 + 上面三个雷区 + 验收清单）。这套 skill 遵循 Agent Skills 规范（`SKILL.md` = YAML frontmatter + Markdown 指令），Trae 等编辑器也认，只是发现目录不同（Trae 是 `.trae/skills/`）。

- `.workbuddy/skills/` 是**唯一事实源**，要改 skill 只改这里；
- 改完跑 `bash scripts/sync-skills.sh`，一键同步到 `.trae/skills/`（幂等，可反复跑）；
- skill 内容属于"怎么开发这个项目"的元信息，不参与运行时，也不影响 3000 端口。

---

## 八、知识点速查

| 想知道什么 | 看哪里 |
|---|---|
| 流式响应怎么实现的、为什么不流式 | `index.js` `/agui` 的响应头 + `chat-core.js` `prepareChatStream` |
| 多步工具循环怎么开的 | `chat-core.js` 的 `stopWhen: stepCountIs(MAX_AGENT_STEPS)` |
| 工具为什么分三类 | `index.js` `createTools` / `createFrontendTools` / `createApprovalTools` 的注释 |
| 中断与恢复怎么做的 | `index.js` `INTERRUPT_PREFIX` / `executeApprovalTool` + 测试用例 `interrupt`/`resume_*` |
| 上下文裁剪怎么做的 | `chat-core.js` `trimMessages` |
| 图片怎么发给模型的 | `index.js` `aguiToChatMessages(resolveImage)` 按消息就地挂 + `chat-core.js` `toContentParts` / `countImageParts` / `attachImagesToLastUserMessage`（裁剪兜底） |
| RAG 索引怎么建的 | `rag-utils.js` `splitTextIntoChunks` + `rag-vector.js` `batchInsertEmbedding` |
| 为什么 BM25 能救精确串 | `rag-vector.js` `tokenize` / `bm25Search` |
| 两路怎么融合的 | `rag-vector.js` `fuseRRF` |
| 检索效果怎么量化 | `eval/run-eval.js` + `eval/compare.js` |
| BM25 到底有没有生效 | `npm run inspect` |
