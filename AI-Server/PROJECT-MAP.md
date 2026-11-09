# AI-Server 项目文件说明

> 这份文档回答三个问题：哪些文件真正跑在线上链路里、每个文件解决什么问题、背后对应哪些知识点。
>
> 判断标准：**"是否进入前端实际调用的请求链路"**。只被脚本引用、或没有任何调用方的文件，单独归类。
> 行数以当前代码为准（`wc -l` 实测）。

---

## 一、总览

| 文件 | 行数 | 分类 | 是否进入线上链路 | 一句话职责 |
|---|---|---|---|---|
| `index.js` | 855 | 运行时 | 是（入口） | HTTP 服务、工具定义、AG-UI 协议适配 |
| `chat-core.js` | 332 | 运行时 | 是 | 聊天主链路：裁剪/附件/选模型/发起流 |
| `rag-vector.js` | 403 | 运行时 | 是 | 向量 + BM25 双路检索与 RRF 融合 |
| `rag-utils.js` | 197 | 运行时 | 是 | 文档解析、清洗、三级分块 |
| `session-files.js` | 158 | 运行时 | 是 | 会话级临时附件（内存，不进知识库） |
| `test-agui-protocol.mjs` | 880 | 测试 | 否（需服务在跑） | AG-UI 事件序列的契约测试，9 个用例 |
| `eval/ingest-corpus.js` | 110 | 评测 | 否 | 从固定语料重建向量库 |
| `eval/run-eval.js` | 166 | 评测 | 否 | 跑 20 题评测，输出 hit@k / MRR |
| `eval/compare.js` | 84 | 评测 | 否 | 两次评测逐题对比，区分"救回"和"弄坏" |
| `eval/inspect.js` | 123 | 评测 | 否 | 检索透视：看两路各自的排名与贡献 |
| `eval/eval-dataset.json` | — | 评测 | 否 | 20 条带标注的评测题 |
| `eval/results/*.json` | — | 数据 | 否 | 历次评测快照（baseline / cleaned / rrf） |
| `uploads/` | — | 数据 | 是（读写） | 上传文件落盘目录，已 gitignore |
| `vector-index/` | — | 数据 | 是（读写） | Vectra 本地向量库（单个 JSON），已 gitignore |

**读代码建议顺序**：`index.js` 的 `/agui` 路由 → `chat-core.js` 的 `prepareChatStream` → `index.js` 的 `createTools` → `rag-vector.js`。这四段串起来就是一次完整问答。

---

## 二、运行时文件详解

### 1. `index.js`（855 行）— 入口与协议层

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

### 2. `chat-core.js`（332 行）— 聊天主链路

**职责**：`/agui` 的实现主体——把 AG-UI 还原出的消息变成一次模型调用。协议（事件编码、SSE 帧）留在 `index.js` 的适配层，这里一行都不出现，所以以后换协议不用动这个文件。

`prepareChatStream()` 是唯一出口，内部五步：

```
trimMessages          裁剪超长上下文（保留最近 10 条以内，清掉悬空 tool 消息）
buildAttachmentSystemPrompt  把本次会话附件清单拼成 system 提示
attachImagesToLastUserMessage  图片挂到最后一条 user 消息（多模态）
选模型                 有图 → MODEL_VISION，无图 → MODEL_REASONING
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

### 3. `rag-vector.js`（403 行）— 检索引擎

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

### 4. `rag-utils.js`（197 行）— 文档解析与切块

**职责**：把 PDF / Markdown 变成干净的文本块。

**关键函数**

- `extractFileText(filePath, ext)`：按后缀分派。Markdown 走 `markdown-it` 渲染再剥标签；PDF 走 `pdf-parse` 的 `PDFParse` 类，`try/finally` 保证 `destroy()` 释放 pdfjs 资源。
- `cleanText(text)`：统一换行、压缩行内空格、去掉 `-- 1 of 1 --` 分页标记、合并竖排单字行。
- `mergeVerticalCharLines(text)`：电子发票这类 PDF 会把"购买方信息"竖着排成单个汉字一行，这里按阈值（单字行占比 > 20%）识别并拼回一行。
- `splitTextIntoChunks(text, 800, 150)`：**三级回退**——段落 → 句子 → 字符窗口。块间保留 150 字符重叠，避免答案正好被切在边界上。

**知识点**：pdf-parse / pdfjs 资源释放、正则零宽断言（`(?<=[。！？；\n])`）、文本清洗、分块策略（语义边界 vs 固定窗口）、重叠窗口的作用。

**解决的问题**：PDF 提取出来的文本很脏（竖排拆字、乱空格、分页符），直接切块会得到大量碎片；切块方式不当则会切断语义，导致检索到了片段但读不懂。

---

### 5. `session-files.js`（158 行）— 会话级临时附件

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

9 个用例覆盖的能力：

| 用例 | 断言什么 |
|---|---|
| `text` | 基础文本流：RUN_STARTED / STATE_SNAPSHOT / TEXT_MESSAGE_CHUNK / RUN_FINISHED；断言**不**下发 MESSAGES_SNAPSHOT（服务端无状态） |
| `server_tool` | 服务端工具：START → ARGS → END → RESULT 闭环 |
| `frontend_tool` | 前端工具只下发调用不给结果（挂起语义） |
| `interrupt` | 审批中断：`outcome=interrupt` 与字段契约 |
| `resume_allow` | resume 允许：执行工具、回传结果、重复 resume 幂等 |
| `resume_reject` | resume 拒绝：不产生副作用 |
| `rag` | 检索工具：TOOL_CALL_RESULT 与 `/sources` 状态增量 |
| `long_context` | 历史超过 token 上限时触发裁剪（`CUSTOM:trim_notice`）且仍能正常完成 |
| `bad_request` | 缺 messages 返回 400 |

**知识点**：SSE 帧解析（`data: ` 前缀、`\n\n` 分隔、跨 chunk 的半帧拼接）、契约测试与快照测试的区别、幂等性验证、用 `randomUUID` 隔离测试数据。

**解决的问题**：协议层改动最容易悄悄破坏前端——事件少一个、顺序反了，前端不报错但界面就是不对。这个脚本把"协议正确"变成可回归的。

> `long_context` 替代了原来的 `test-long-chat.js`。旧脚本打的是已删除的 `/api/chat`，而且只 `console.log` 事件、没有断言，跑完还得人眼判断。现在它读 `.env` 的 `MAX_CONTEXT_TOKENS` 自动算填充轮数（默认上限 6000 时约 9 轮），断言服务端确实下发了 `CUSTOM:trim_notice` 且 `droppedMessages > 0`。

---

## 四、评测工具（`eval/`）

这一组回答的是"改了检索到底有没有变好"，而不是"我觉得变好了"。

| 脚本 | 用法 | 作用 |
|---|---|---|
| `ingest-corpus.js` | `npm run eval:ingest` / `--list` | 从固定语料重建向量库，保证每次评测的语料一致 |
| `run-eval.js` | `npm run eval -- <tag> [--topk N]` | 跑 20 题，输出 hit@1/3/5、MRR、分类统计，落 `results/<tag>.json` |
| `compare.js` | `node eval/compare.js <a> <b>` | 逐题对比两次结果，列出名次变化与"改善/退化"条数 |
| `inspect.js` | `npm run inspect [-- query]` | 单条查询透视 / 整体双路参与率体检 |

**指标定义**

- `hit@k`：正确答案所在片段是否出现在前 k 条。
- **严格口径**：文件名匹配 **且** 片段包含 `expectKeywords` 里**任一**关键词，两个条件都满足才算命中。只用文件名匹配会自我欺骗——文件对了但片段是无关段落，模型照样答不出来。
- `MRR`：`1/正确排名` 的平均值，衡量"排得有多靠前"，比 hit@k 更细。
- `文件级 hit@3` 与 `严格 hit@3` 的差值 = "文件找到了但片段没对上"的数量。

**知识点**：检索评测方法（hit@k / MRR / 严格口径）、对照组思维（baseline → cleaned → rrf 三份快照）、数据治理优先于算法调参。

**解决的问题**：改检索最怕"感觉变好了"。这批数据上就验证过一次：只删掉一篇 21 段同质链接的"磁铁文档"，hit@3 从 80% 涨到 95%，比改任何参数都有效。

---

## 五、端点清单

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

## 六、一次请求的完整链路

```
浏览器 ChatEngine
   │  POST /agui  { messages, threadId, forwardedProps.sessionId, state }
   ▼
index.js  /agui
   ├─ aguiToChatMessages()      扁平事件 → AI SDK 消息结构
   ├─ prepareChatStream()       chat-core.js
   │     ├─ trimMessages()                超长则裁剪
   │     ├─ buildAttachmentSystemPrompt() 注入附件清单
   │     ├─ attachImagesToLastUserMessage() 图片挂载
   │     └─ streamText({ stopWhen: stepCountIs(5) })
   │           │
   │           ├─ 模型决定调用 searchKnowledgeBase
   │           ▼
   │        createTools().searchKnowledgeBase
   │           ├─ searchVector()        rag-vector.js  向量 + BM25 → RRF
   │           └─ searchSessionFiles()  session-files.js  内存点积
   │           └─ mergeByRank()         两源按名次融合
   │           └─ 返回 { text, sources }
   │           ▼
   │        工具结果回填，模型继续生成（最多 5 步）
   ▼
SSE 事件流：RUN_STARTED → 文本增量 → TOOL_CALL_* → STATE_DELTA(sources) → RUN_FINISHED
   ▼
前端渲染：正文 / 思考过程 / 工具卡片 / 引用来源
```

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

---

## 八、知识点速查

| 想知道什么 | 看哪里 |
|---|---|
| 流式响应怎么实现的、为什么不流式 | `index.js` `/agui` 的响应头 + `chat-core.js` `prepareChatStream` |
| 多步工具循环怎么开的 | `chat-core.js` 的 `stopWhen: stepCountIs(MAX_AGENT_STEPS)` |
| 工具为什么分三类 | `index.js` `createTools` / `createFrontendTools` / `createApprovalTools` 的注释 |
| 中断与恢复怎么做的 | `index.js` `INTERRUPT_PREFIX` / `executeApprovalTool` + 测试用例 `interrupt`/`resume_*` |
| 上下文裁剪怎么做的 | `chat-core.js` `trimMessages` |
| 图片怎么发给模型的 | `chat-core.js` `toContentParts` / `attachImagesToLastUserMessage` |
| RAG 索引怎么建的 | `rag-utils.js` `splitTextIntoChunks` + `rag-vector.js` `batchInsertEmbedding` |
| 为什么 BM25 能救精确串 | `rag-vector.js` `tokenize` / `bm25Search` |
| 两路怎么融合的 | `rag-vector.js` `fuseRRF` |
| 检索效果怎么量化 | `eval/run-eval.js` + `eval/compare.js` |
| BM25 到底有没有生效 | `npm run inspect` |
