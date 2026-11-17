---
name: add-tool
description: 在 AI-Server 项目中新增一个模型可调用的 Function Calling 工具时使用。当用户要求"加一个工具 / 新增工具 / 加个 function / 让模型能查 X / 接一个外部 API / 加个绘图或进度工具"等需求时触发。覆盖工具定义、UI 联动、回归测试、文档同步、重启生效的完整流程，避免漏步骤和踩"改了不报错但功能静默失效"的雷区。
---

# 新增工具（AI-Server 项目）

给这个项目加一个模型能调用的工具，不是只写一个函数就完事。按下面五步走，每步都有坑，跳步会出"看着成功、实际不生效"的问题。

## 何时使用

- 用户说"加一个工具 / 新增工具 / 让模型能查天气 / 接一个 API / 加个图表工具"
- 要给模型增加一项新能力，且这个能力需要结构化入参或要影响前端界面
- 不要在"只是改某个工具的返回文案 / 调参数"时用——那是小改，直接改对应文件即可

## 前置确认（先判断工具类型）

在 `server/index.js` 的 `createTools()` 里有三类工具，先确认新工具属于哪类，处理方式不同：

| 类型 | 特征 | 放哪 | 例子 |
|---|---|---|---|
| 服务端工具 | 有 `execute`，模型调完立刻拿到结果 | `createTools()` 直接定义 | `calculator` / `getCurrentTime` / `getWeather` |
| 生成式 UI 工具 | 不产数据，把模型意图变成 UI spec | `createTools()` 定义 + 前端 `web/src/ui/registry.ts` 注册组件 | `renderChart` |
| 带 UI 联动的工具 | 执行中要播报进度 / 驱动计划状态 | `createTools()` 定义 + hooks 注入 | `getWeather`（进度）/ `planSteps`（计划） |

纯外部能力的逻辑（HTTP 请求、复杂计算）**抽到独立文件**（如 `weather.js`），工具定义里只做参数校验和调用——这样能脱离模型单测，也是本项目的既有风格。

## 五步流程

### 第 1 步：写工具定义（`server/index.js` 的 `createTools()`）

用 AI SDK 的 `tool()`，三件套缺一不可：

```js
myTool: tool({
  // description 是模型判断"要不要调用"的唯一依据，不是给人看的注释。
  // 必须写清「什么情况调用 / 什么情况不要调用」，只写"获取XX"这种同义反复会让模型乱调。
  description: '查询XX。当用户问XX、要做XX安排时调用。只支持XX，不支持YY。',
  // zod 声明入参，AI SDK 转成 JSON Schema 下发给模型。
  // 类型/enum 约束写在这里；无参数也要显式 z.object({})，等于告诉模型不要编参数。
  // .describe() 会一起下发，是给模型看的参数说明。
  inputSchema: z.object({
    city: z.string().min(2).max(20).describe('城市名，如"杭州"'),
    days: z.number().int().min(1).max(7).optional().describe('查几天，默认 3')
  }),
  // 注意：出错时"返回错误文本"而不是抛异常。
  // 抛异常会让这一轮对话直接失败；返回错误文本，模型能读到并自己换参数重试。
  async execute({ city, days = 3 }, execCtx) {
    return someLib(city, days)
  }
})
```

要点：
- 工具名用驼峰，和 description 里提到的名字保持一致
- 返回**可读文本**而不是裸时间戳/裸 JSON——返回值直接进模型上下文
- 生成式 UI 工具特殊：spec 放在**工具参数**里（前端读 `step.input` 渲染），`execute` 只返回"已生成 + 别重复"的一句提示；真正的 props 校验在前端 `web/src/ui/spec.ts`，服务端只做轻校验

### 第 2 步：UI 联动（仅"带 UI 联动 / 生成式 UI"两类需要做）

工具通过 `createTools(sessionId, userId, hooks)` 的 hooks 把意图透出，端点层决定怎么发事件（不要把 SSE 编码塞进工具层，`/v1` 端点不依赖 AG-UI）：

- **阶段进度**：在 `execute` 里调 `hooks.onToolProgress?.({ toolCallId, message })`，`toolCallId` 从第二个参数 `execCtx.toolCallId` 取；`/agui` 端点会转成 `CUSTOM tool_progress`，前端按 `toolCallId` 挂到对应工具卡片
- **驱动计划**：需要推进计划步骤时调 `hooks.onPlan`，端点发 `STATE_DELTA replace /plan`；步骤声明的 `tool` 字段必须是真实工具名，否则进度不会自动推进
- **生成式 UI**：前端在 `web/src/ui/registry.ts` 用白名单注册组件，`spec.ts` 写校验；未注册组件一律不渲染，props 校验失败降级成"原因 + 原始入参"

### 第 3 步：加回归测试

- 复杂逻辑（HTTP/计算/状态机）抽成独立模块后，写独立单测（参考 `server/test-weather.cjs`，用假 fetch / 注入依赖，不联网不调模型）
- 纯函数行为（图片挂载、计划推进等）加进 `server/eval/behavior-golden.json`，runner 是 `eval/run-behavior.js`
- 在 `server/package.json` 的 scripts 里登记新测试命令（风格对齐已有的 `test:weather` / `eval:behavior`）

### 第 4 步：同步文档

- `server/PROJECT-MAP.md`：工具集合表、相关说明段落
- `CHANGELOG.md`：在 `[Unreleased] → 新增` 加一条，写清工具作用与关键设计取舍
- 若工具影响前端渲染，同步更新 `web` 侧组件说明

### 第 5 步：验证 + 重启生效

在 `server/` 目录跑：

```bash
npm run test:weather      # 若新增了天气类外部调用测试，或对应单测
npm run eval:quick        # 行为 golden + spec 自测，秒级
npm run eval:all          # 四层全量：行为 / 天气 / RAG 检索 / UI spec
```

**后端必须重启 3000 才会加载新工具**——只改文件不重启，工具不会出现在模型可用列表里。前端无需重启（Vite 热更新）。

## 三个"改了不报错但功能静默失效"的雷区

这三条在 `PROJECT-MAP.md` 里被专门标记，改动相关文件时重点检查：

1. **`chat-core.js` 的 `streamText` 不能加 `await`**——一旦 await 就等全量生成完，流式失效，表现为前端卡很久然后一次性刷出全文
2. **`rag-vector.js` 里新增/删除片段必须调 `invalidateBm25()`**——否则 BM25 索引不更新，检索结果不反映变化
3. **`index.js` 里前端工具与服务端工具同名时，以服务端为准**——同名会被服务端定义覆盖，前端版本静默失效

## 验收清单

- [ ] 工具在 `createTools()` 里定义，`description` 写清何时用/何时不用
- [ ] `inputSchema` 用 zod 约束，无参数也声明 `z.object({})`
- [ ] `execute` 出错返回错误文本而非抛异常
- [ ] 复杂逻辑已抽独立文件并有单测（不联网、不调模型）
- [ ] 需要 UI 联动的已接 hooks，前端组件已注册到白名单
- [ ] `server/PROJECT-MAP.md` 与 `CHANGELOG.md` 已同步
- [ ] `npm run eval:all` 全绿
- [ ] 已提醒用户重启后端 3000
