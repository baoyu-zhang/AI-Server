// test-long-chat.js
const axios = require('axios');
const BASE_URL = 'http://localhost:3000/api/chat';

function buildMassMessages() {
  const messages = [];
  // 改成8轮，不要一次性塞超大消息
  for (let i = 1; i <= 8; i++) {
    messages.push({
      role: 'user',
      content: `【第${i}轮】请简单回答。下面是填充文本：人工智能智能体开发，Vue3前端，TDesign聊天组件，Function Calling，ReAct循环，RAG知识库，向量检索，文档分块，Embedding，流式输出，思考过程折叠面板，工具调用可视化，token裁剪，上下文管理。`
    });
    messages.push({
      role: 'assistant',
      content: `收到，第${i}轮回复：智能体开发核心就是ReAct循环，大模型思考、调用工具、拿到结果再继续回答。`
    });
  }
  // 最新提问
  messages.push({
    role: 'user',
    content: "帮我算 1234 * 5678，并且获取当前时间"
  })
  return messages;
}

async function runTest() {
  try {
    const messages = buildMassMessages();
    console.log('发送请求，消息条数：', messages.length);
    const res = await axios.post(BASE_URL, { messages }, {
      responseType: 'stream'
    });

    let buffer = ''
    res.data.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? ''
      for(const line of lines) {
        const trimLine = line.trim()
        if(!trimLine || !trimLine.startsWith('data: ')) continue
        const jsonStr = trimLine.replace('data: ','');
        try{
          const payload = JSON.parse(jsonStr);
          console.log('👉 流事件：', payload);
        }catch(e){
          console.log('解析失败', jsonStr)
        }
      }
    })

    res.data.on('end', ()=>{
      console.log('✅ 流结束，剩余buffer：', buffer)
    })
    res.data.on('error',(err)=>{
      console.error('❌ stream error', err)
    })
  } catch (err) {
    console.error('请求失败：', err?.response?.data || err.message)
  }
}

runTest();
