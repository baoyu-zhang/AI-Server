import { HttpAgent } from '@ag-ui/client'

const $ = (id) => document.getElementById(id)
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

const agent = new HttpAgent({ url: '/agui', threadId: uid() })

let view = emptyView()

function emptyView() {
  return { reasoning: '', tool: null, answer: '', state: {}, custom: [] }
}

function setText(id, value, emptyText = '（空）') {
  const el = $(id)
  const text = value || emptyText
  el.textContent = text
  el.classList.toggle('muted', !value)
}

function render() {
  setText('reasoning', view.reasoning)
  setText(
    'tool',
    view.tool
      ? `${view.tool.name}(${view.tool.args || '...'})\n状态: ${view.tool.status}${view.tool.result ? `\n结果: ${view.tool.result}` : ''}`
      : '',
  )
  setText('answer', view.answer)
  setText('state', Object.keys(view.state).length ? JSON.stringify(view.state, null, 2) : '')
  setText('custom', view.custom.length ? JSON.stringify(view.custom, null, 2) : '')
}

async function send() {
  const input = $('input')
  const status = $('status')
  view = emptyView()
  render()

  agent.addMessage({ id: uid(), role: 'user', content: input.value })
  status.textContent = '运行中...'

  try {
    await agent.runAgent(
      {},
      {
        onReasoningMessageContentEvent: ({ event }) => {
          view.reasoning += event.delta
          render()
        },
        onToolCallStartEvent: ({ event }) => {
          view.tool = { name: event.toolCallName, args: '', status: 'running' }
          render()
        },
        onToolCallArgsEvent: ({ event }) => {
          if (view.tool) view.tool.args += event.delta
          render()
        },
        onToolCallResultEvent: ({ event }) => {
          if (view.tool) {
            view.tool.status = 'done'
            view.tool.result = event.content
          }
          render()
        },
        onTextMessageContentEvent: ({ event }) => {
          view.answer += event.delta
          render()
        },
        onStateChanged: ({ agent: current }) => {
          view.state = current.state || {}
          render()
        },
        onCustomEvent: ({ event }) => {
          view.custom.push({ name: event.name, value: event.value })
          render()
        },
        onRunErrorEvent: ({ event }) => {
          status.textContent = `错误: ${event.message}`
        },
      },
    )
    status.textContent = `完成，消息数 ${agent.messages.length}`
  } catch (err) {
    status.textContent = `失败: ${err?.message || err}`
  }
}

$('send').addEventListener('click', send)
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send()
})
