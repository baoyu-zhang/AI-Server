# 从通用 RAG 脚手架到「招聘场景简历助手」改造计划

> 目标：把现有 `AI-Server`（通用文档问答 + 会话附件 + 审批删除）改造成一个**有明确业务身份**的招聘场景助手，
> 让"我做了个 RAG demo"变成"我做了个 HR 简历初筛助手"。
>
> 现有能力基线：7 篇 / 62 段语料，`hit@3` 100%、MRR 0.975（`eval/results/baseline-v2.json`）。
> 改造过程中这 20 题必须保持不退化，作为"通用能力没被搞坏"的回归。

## 执行状态（2026-11-11 更新）

本文档的 P0~P3 是**全量计划**，实际按 250 行切片推进：先做「元数据 + 过滤 + 一个评分工具 + 一个审批工具」，
够跑出"问匹配度 → 出五项评分 + 原文依据 → 说录用 → 弹审批"的闭环即可演示，P2 的表格与持久化延后。

执行方式为**自己写、AI 审**：代码由本人落笔，AI 负责接口设计、逐段讲解与代码审查。

| 切片项 | 状态 | 落点 |
|---|---|---|
| 元数据三字段 | 已完成 | `rag-vector.js` `batchInsertEmbedding(chunks, fileName, meta)`，白名单只收 `docType/jobId/candidateId` |
| 双路过滤 | 已完成 | `matchesFilter` + 向量路透传 `filter` + BM25 打分前过滤 |
| 上传接业务参数 | 已完成 | `/api/upload-doc` 收 `docType/jobId/candidateId`，简历缺 `candidateId`、JD 缺 `jobId` 直接 400 |
| 同名文件不互相覆盖 | 已完成 | `resolveDocName`：同业务对象沿用原名覆盖，不同候选人另存 `-2/-3`（否则后传的会删掉前一个人的简历） |
| `scoreResumeAgainstJD` | 已完成 | `score-resume.js`：四维加权（30/20/20/15）+ 三道硬门槛否决，模型只判档位、代码加总 |
| `listCandidates` / `listJobs` | 已完成 | 服务端工具，给模型"拿到真实 id"的入口；另有 `GET /api/candidates`、`GET /api/jobs` 供前端 |
| `updateCandidateStatus` | 已完成 | 审批工具 + `candidates-store.js`（JSON 持久化、写串行化、原子替换、幂等） |
| 简历脱敏 | 已完成 | `rag-utils.js` `redactPII`：手机号 / 身份证 / 邮箱 / 银行卡 / 门牌号五条规则，在 `extractFileText` 末尾统一执行 |
| 前端上传表单带业务标签 | 已完成 | `DocPanel.vue`：类型选择 + 候选人 / 岗位可搜索可新建，必填项前置校验 |
| 候选人面板 | 已完成 | `CandidatePanel.vue` + `SidePanel.vue`：左侧栏两个页签，卡片式列表，操作走对话（改状态仍经审批） |
| 文档列表按类型分组 | 已完成 | `/api/documents` 带 `docType/jobId/candidateId`，`DocPanel` 列表渲染为标签 |
| Word（.docx）上传 | 已完成 | `rag-utils.js`：mammoth 转 HTML + `htmlToText`；表格按 `\|` 分行、脱敏照走。`.doc` 明确提示另存为 |
| 上传失败的错误语义 | 已完成 | 统一错误中间件：格式不支持 / 文件损坏 → 400 JSON，体积超限 → 413；解析失败同步清掉落盘文件 |

验收脚本：`npm run verify:hr`（61 项断言，覆盖 store 单测、同名上传、评分接线、审批 interrupt→resume→重放幂等、
PII 脱敏五条规则与"入库后磁盘索引里查不到手机号"、docx 表格还原与坏文件清理；`--skip-model` 可只跑不需要模型的三段）。

---

## 0. 一页结论

| 阶段 | 内容 | 新增/改动 | 验收标准 | 预估 token |
|---|---|---|---|---|
| **P0** | 数据隔离与领域标记 | ~280 行 | 能按候选人过滤检索；简历里的手机号入不了库 | 90k ~ 100k |
| **P1** | 5 个领域工具（含 1 个审批） | ~380 行 | 说"评估张三对这个岗位的匹配度"能出结构化结果 | 100k ~ 120k |
| **P2** | 结果落地 + 前端面板 | ~520 行 | 刷新页面分数还在；能导出 CSV | 140k ~ 160k |
| **P3** | 场景评测集 | ~320 行 | 10 道匹配题有断言，且 20 题回归不退化 | 45k ~ 60k |
| 合计 | | **~1500 行** | | **375k ~ 440k** |

顺序不能换：P0 不过，P1 的过滤是假的；P1 不过，P2 没有东西可展示；P3 最后做，因为它要断言的是前三个阶段的产物。

---

## 1. 现状：代码里的四个业务假设

这四个假设决定了它现在只能服务"单用户个人助手"，也解释了为什么看不出业务：

| 假设 | 证据 | 后果 |
|---|---|---|
| 单用户、单租户 | 全项目只有 `sessionId`，无 `userId` / `tenantId` | 做不了需要数据隔离的产品 |
| 知识库全局共享 | `/api/documents` 返回全库，`/api/documents/delete` 无鉴权 | "销售部看不到财务文档"这类需求无法满足 |
| 服务端无状态 | `index.js` 注释明确"历史以客户端 `RunAgentInput.messages` 为准" | 刷新即丢，无法审计与追溯 |
| 无鉴权 | 6 个端点全部裸奔 | 不能部署到公网 |

**本计划不解决第 3、4 条**（它们属于"上线"而非"场景"），只解决第 1、2 条中与招聘场景直接相关的部分。

---

## 2. P0 数据隔离与领域标记

### 2.1 文档元数据加三个字段

| 项 | 内容 |
|---|---|
| 落点 | `server/rag-vector.js` → `batchInsertEmbedding(chunks, fileName, meta)` |
| 改法 | 签名从 `(chunks, fileName)` 扩为 `(chunks, fileName, meta = {})`，metadata 里写入 `docType`（`jd` / `resume` / `policy`）、`jobId`、`candidateId` |
| 兼容 | `meta` 缺省时行为完全不变，`eval/ingest-corpus.js` 不用改 |
| 验收 | 入库后 `getDocuments()` 能按 `docType` 分组；旧语料 `docType` 为 `undefined` 不报错 |

> 为什么不直接把类型编进文件名：文件名是给人看的，过滤要的是结构化字段。
> 靠 `fileName.includes('简历')` 判断类型，第一天能用，第十个客户就崩。

### 2.2 检索支持业务过滤

| 项 | 内容 |
|---|---|
| 落点 | `server/rag-vector.js` → `retrieveCandidates` / `fuseRRF` / `hybridSearch` |
| 改法 | 三条链路都加可选 `filter` 参数：向量路透传给 `index.queryItems(vector, query, pool, filter)`；**BM25 路要手写过滤**（在 `bm25Search` 里按 `doc.meta` 跳过不匹配的片段） |
| 关键点 | BM25 是自己实现的，Vectra 的 `filter` 管不到它。这处最容易漏，漏了就会出现"过滤了却仍召回别的候选人" |
| 验收 | `searchVector(q, 5, { candidateId: 'c1' })` 的结果里不含其他候选人的片段 |

### 2.3 上传接口收业务参数

| 项 | 内容 |
|---|---|
| 落点 | `server/index.js` → `POST /api/upload-doc` |
| 改法 | 接收 `docType` / `jobId` / `candidateId`（multipart 的 `fields`）；`docType === 'resume'` 时 `candidateId` 必填，缺失返回 400 |
| 验收 | 不带 `candidateId` 上传简历返回 400；带上则入库后能在候选人的检索里被搜到 |

### 2.4 文档列表分组

| 项 | 内容 |
|---|---|
| 落点 | `server/index.js` → `GET /api/documents`；`web/src/components/DocPanel.vue` |
| 改法 | 返回结构从 `{ data: [...] }` 改为带 `group` 的数组或按 `docType` 分组；前端文档栏分为「岗位 JD」「候选人简历」「制度文档」三块 |
| 验收 | 上传 2 份简历 + 1 份 JD，面板上分区正确 |

### 2.5 简历脱敏（**硬性要求**）

| 项 | 内容 |
|---|---|
| 落点 | `server/rag-utils.js`，切块前加 `redactPII(text)` |
| 改法 | 正则替换：手机号 `1[3-9]\d{9}`、身份证 `\d{17}[\dXx]`、邮箱、住址（含"XX路/XX号"）→ 替换为 `[手机号已脱敏]` 等占位 |
| 为什么必须做 | 简历是 PII。未脱敏的简历进向量库、进模型上下文、进日志，是这类产品最常见的合规事故 |
| 验收 | 上传一份带真实手机号的简历，`vector-index/index.json` 里搜不到那串数字 |

> 这条不是"优化"，是准入门槛。做了它，面试时能主动讲"我知道简历场景的第一个坑是 PII"。

---

## 3. P1 领域工具

现有工具只有 `getCurrentTime` / `calculator` / `searchKnowledgeBase` / `deleteSessionFile`（审批）。
全部是通用能力，没有一个动作属于招聘业务。以下 5 个补上业务身份。

### 3.1 工具清单

| # | 工具名 | 类型 | 入参 → 出参 | 说明 |
|---|---|---|---|---|
| 1 | `scoreResumeAgainstJD` | 服务端 | `{ candidateId, jobId }` → `{ total, items[], gaps[] }` | 核心工具，见 3.2 |
| 2 | `listCandidates` | 服务端 | `{ jobId?, status? }` → 候选人数组 | 支撑"哪些人值得面" |
| 3 | `compareCandidates` | 服务端 | `{ candidateIds[] }` → 对比表 | 复用现有 `Promise.all` 取多份材料 |
| 4 | `updateCandidateStatus` | **审批** | `{ candidateId, status }` → interrupt → resume 后执行 | 改状态有副作用，必须人确认。**直接复制 `deleteSessionFile` 的模式** |
| 5 | `exportCandidateReport` | **前端** | `{ jobId }` → 浏览器生成 CSV 下载 | 复用现有前端工具透传机制，服务端不落盘 |

### 3.2 评分工具的设计（最关键的一条）

**不要**让模型"给个 0~100 分"。原因：不可复现（同一份简历两次跑出 78 和 85）、不可解释（面试官问"为什么"答不上来）、不可评测（没法写断言）。

**做法**：rubric 拆项，模型只做**逐项判断**，分数由代码加总。

| 维度 | 权重 | 判定依据 | 取值 |
|---|---|---|---|
| 技术栈匹配 | 30 | JD 要求的技术，简历里是否有对应项目（不是关键词堆砌） | 0 / 1 / 2 |
| 年限匹配 | 20 | 总工作年限 vs JD 要求 | 0 / 1 / 2 |
| 项目复杂度 | 20 | 是否有主导过的完整项目（规模、角色） | 0 / 1 / 2 |
| 行业经验 | 15 | 是否有 JD 所属行业经历 | 0 / 1 / 2 |
| 硬性门槛 | 15 | 学历、证书等一票否决项 | 0 / 1 / 2 |

- 输出必须是 JSON：`{ items: [{ dimension, score, evidence, chunkRef }], gaps: [...] }`
- `evidence` 必须引用原文片段（`chunkRef` 指向检索命中片段的 id）——**没有证据的评分一律记 0**
- `total = Σ(score × weight)` 由代码算，模型不碰

这样同一份简历两次评分一致，且每条扣分都能点开看原文。

### 3.3 落点

| 文件 | 动作 |
|---|---|
| `server/hr-tools.js` | 新增，约 260 行：5 个工具 + rubric 提示词 + 结果校验（Zod 或手写） |
| `server/index.js` | `createTools()` 里挂载，约 30 行 |
| `web/src/` | `exportCandidateReport` 的浏览器实现，约 60 行 |

### 3.4 验收

- 问"张三对这个岗位匹配度如何" → 返回逐项分数 + 证据
- 问"把李四标为已面试" → 触发审批中断，拒绝则状态不变，同意则变更且**重复 resume 不重复执行**（幂等，复用现有机制）
- 问"导出这个岗位的报告" → 浏览器下载 CSV

---

## 4. P2 结果落地

现在的问题是：回答完就没了，刷新即失忆，无法演示"工作台"。

| # | 内容 | 落点 | 说明 |
|---|---|---|---|
| 1 | 候选人数据持久化 | `server/candidates-store.js`（新增，~110 行） | JSON 文件读写，带简单的写入串行化（避免并发覆盖） |
| 2 | 候选人 CRUD 端点 | `server/index.js`（+90 行） | `GET /api/candidates`、`POST /api/candidates/status` |
| 3 | 候选人表格组件 | `web/src/components/CandidateTable.vue`（新增，~180 行） | 列表：姓名 / 岗位 / 总分 / 状态 / 展开看五项依据 |
| 4 | 会话绑定上下文 | `server/index.js` + 前端 | `sessionId → { jobId, candidateId }`，让"他有没有 Vue 经验"里的"他"有指向 |
| 5 | 状态与聊天联动 | `App.vue` + store（~80 行） | 审批通过后表格实时更新 |

**为什么存 JSON 而不是向量库**：评分结果要整体读出、按岗位筛选、按分数排序，这是关系型需求；向量库擅长的是"相似"，不是"列表"。

---

## 5. P3 场景评测

| # | 内容 | 说明 |
|---|---|---|
| 1 | `eval/hr-dataset.json`（新，10 题） | 每题：`{ candidateId, jobId, expectGaps: [...], expectScoreRange: [min,max] }` |
| 2 | `eval/run-eval-hr.js`（新，~150 行） | 断言从 `hit@3` 换成结构化断言：缺口识别对没对、分数是否落在区间、`evidence` 是否真有原文 |
| 3 | 20 题回归 | 现有 `npm run eval` 必须保持 `hit@3` 100%，否则说明改动破坏了通用检索 |

**注意**：结构化断言的容错要放宽。比如"期望识别出缺少 Kubernetes 经验"，模型可能表述为"未提及容器编排经验"——断言要基于 `gaps[].dimension` 这种**枚举值**，不要匹配自由文本。

---

## 6. 明确不做

| 不做 | 原因 |
|---|---|
| 多租户（`tenantId`） | 除非真要卖给第二家公司。加它要做租户管理、计费、数据迁移，一周打不住 |
| OCR | 当前样本 PDF 都有文本层；扫描件识别是独立工程 |
| 自动投递 / 简历爬虫 | 法律风险高，且与"AI 应用能力"无关 |
| 面试排期、消息通知 | 这是 HR SaaS 的活，不是 AI 应用的活 |
| 用户体系与登录 | 属于"上线"阶段，不是"场景"阶段 |

---

## 7. 里程碑与提交粒度

| 阶段 | 建议提交 | 说明 |
|---|---|---|
| P0 | 3 个 commit | ①元数据+过滤 ②上传参数+列表分组 ③脱敏 |
| P1 | 3 个 commit | ①评分工具+rubric ②列表/对比工具 ③审批状态+导出 |
| P2 | 2 个 commit | ①存储+端点 ②前端面板 |
| P3 | 1 个 commit | 场景评测集 |

每个 commit 后跑一次 `npm run eval`，确认 20 题不退化。

---

## 附录 A：token 消耗估算

### A.1 口径

- 这里算的是**写代码过程中消耗的模型 token**（读文件 + 写代码 + 看测试输出 + 修错），不是 BM25 里说的"token"（那个是文本切词单位），也不是运行时调 DeepSeek 的费用（评测只做检索，几乎不花钱）。
- 换算比例：本项目中英混杂且注释密集，实测约 **2.3 字符 ≈ 1 token**。
- 现有可读面（全部读一遍的成本）：

| 文件 | 行数 | 字符 | ≈ tokens |
|---|---|---|---|
| `server/index.js` | 855 | 31,003 | 13.5k |
| `server/rag-vector.js` | 403 | 12,617 | 5.5k |
| `server/chat-core.js` | 332 | 11,182 | 4.9k |
| `server/rag-utils.js` | 197 | 7,125 | 3.1k |
| `server/session-files.js` | 158 | ~4,500 | 2.0k |
| `server/eval/run-eval.js` | 166 | ~5,000 | 2.2k |
| `web/src/App.vue` | 1,950 | 60,929 | 26.5k |
| `web/src/components/DocPanel.vue` | 243 | 6,597 | 2.9k |
| `web/src/store/chat.ts` | 94 | 2,704 | 1.2k |
| **合计** | **4,398** | — | **61.8k** |

### A.2 分阶段消耗

消耗 = 读（文件 × 重复次数）+ 写（新增代码）+ 迭代（跑测 → 报错 → 修）。

| 阶段 | 读 | 写 | 迭代 | 小计 |
|---|---|---|---|---|
| P0 | 44k（`index.js`×2、`rag-vector`×2、`rag-utils`×1.5、`DocPanel`×2） | 4.5k（280 行） | 35k（6~8 轮） | **90k ~ 100k** |
| P1 | 33k（`index.js`、`chat-core` 的工具模式、`run-eval`） | 7k（380 行，含 rubric 提示词） | 65k（10~12 轮，工具调试最费） | **100k ~ 120k** |
| P2 | 71k（`App.vue`×2 = 53k，这是最大单项） | 8k（520 行） | 60k（10 轮） | **140k ~ 160k** |
| P3 | 12k（`run-eval`、数据集） | 5k（320 行） | 30k（评测反复跑） | **45k ~ 60k** |
| **合计** | **160k** | **24.5k** | **190k** | **375k ~ 440k** |

中位估计：**约 40 万 token**。

### A.3 三个必须知道的偏差

1. **单会话累计会更高。** 每轮对话都要带上历史，同一个会话里做完四个阶段，实际消耗约是上表的 **1.3~1.5 倍**（500k~600k）。建议按阶段分 4 次会话，用 `PROJECT-MAP.md` 和记忆文件承接上下文，能省 30% 左右。
2. **`App.vue` 是成本黑洞。** 1,950 行、2.6 万 token，只要完整读两次就是 5 万。改前端时应先 `grep` 定位到具体函数再局部读，不要整份读。
3. **迭代成本远大于代码量。** 1500 行代码本身只有 2.5 万 token，但调试占了 19 万——**写得快不如一次写对**。先在纸面把接口定清楚（本文件就是干这个的），能砍掉一半迭代。

### A.4 换算成体感

- 40 万 token ≈ 200k 上下文窗口装满两次
- ≈ 35~45 轮对话（每轮平均 10k~12k）
- ≈ 8~9 个 commit 的开发量

### A.5 降本做法

| 做法 | 省多少 |
|---|---|
| 分 4 次会话，每阶段一次 | 30% |
| 前端只局部读，不整份读 | P2 阶段省 30k~50k |
| 先定接口再写实现（本文件的作用） | 迭代减少 30%~50% |
| 评测只跑相关子集（`--case`） | P3 的迭代省一半 |

---

## 附录 B：每阶段的验收命令

```bash
cd ~/Desktop/ai智能体练习/AI-Server/server

# P0：过滤是否真生效（结果里不应出现别的候选人）
node eval/inspect.js "张三有没有 Vue 经验" --topk 5

# P1：工具是否能被模型正确调用（起服务后在网页里问）
#   "评估张三对这个岗位的匹配度" → 应出五项分数 + 证据
#   "把李四标为已面试" → 应弹审批

# P2：持久化是否生效
curl -s http://127.0.0.1:3000/api/candidates | head -c 300

# P3：场景评测 + 20 题回归
node eval/run-eval-hr.js
npm run eval -- after-hr && node eval/compare.js baseline-v2 after-hr
```
