#!/usr/bin/env node
/**
 * mcp-demo-server.js —— 一个最小的 MCP Server（stdio 传输）
 *
 * ===== 这个文件的作用 =====
 * 有了它，「MCP 客户端」这条链路可以完全离线跑通：不需要 npx 拉第三方 server，
 * 也不需要外网。它同时是一个可抄的模板——把 registerTool 换成你自己的能力，
 * 就是一个能被本项目的 Agent 直接调用的工具服务。
 *
 * ===== 怎么被用到 =====
 * server/mcp.json 里有一项 command: "node", args: ["mcp-demo-server.js"]。
 * 主服务启动时通过 stdio 把它拉起来，listTools 拿到 echo / add / server_time，
 * 再转成 AI SDK 的 tool 交给模型——模型全程不知道对面是个子进程。
 *
 * 注意：这个脚本往 stdout 写的东西必须是协议数据，日志一律走 stderr，
 * 否则会污染 JSON-RPC 流（这是写 MCP Server 最常见的坑）。
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const server = new McpServer({ name: 'demo-server', version: '1.0.0' })

// 工具 1：原样回显。用来验证"参数能不能正确穿过协议"
server.registerTool(
  'echo',
  {
    title: '回声',
    description: '把你传入的文本原样返回，用于测试 MCP 链路是否连通',
    inputSchema: { text: z.string().describe('要回显的文本') }
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] })
)

// 工具 2：加法。用来验证"结构化参数 + 结果解析"
server.registerTool(
  'add',
  {
    title: '加法',
    description: '计算两个数字之和',
    inputSchema: {
      a: z.number().describe('第一个加数'),
      b: z.number().describe('第二个加数')
    }
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: `${a} + ${b} = ${a + b}` }] })
)

// 工具 3：服务端时间。用来验证"工具结果与模型自身知识无关"的场景
server.registerTool(
  'server_time',
  {
    title: '服务端时间',
    description: '返回运行 MCP Server 的这台机器当前的本地时间'
  },
  async () => ({ content: [{ type: 'text', text: new Date().toLocaleString('zh-CN', { hour12: false }) }] })
)

const transport = new StdioServerTransport()
server.connect(transport).catch(err => {
  console.error('[demo-mcp] 启动失败：', err)
  process.exit(1)
})
// stderr 打一行启动日志方便排查；stdout 留给协议
console.error('[demo-mcp] 已启动，工具：echo / add / server_time')
