const fs = require('fs') // 引入 Node 内置文件系统模块，用于读写文件、创建目录
const path = require('path') // 引入 Node 内置路径模块，用于拼接路径、获取文件后缀
const markdownIt = require('markdown-it') // 引入 markdown-it，用于把 Markdown 渲染成 HTML
const pdfParse = require('pdf-parse') // 引入 pdf-parse，用于解析 PDF 文本
const { PDFParse } = pdfParse // pdf-parse v2 不再导出函数，需要从导出对象中取出 PDFParse 类

const md = new markdownIt() // 创建 Markdown 渲染器实例，模块级复用避免重复初始化

// 允许上传的文件后缀，路由层的白名单校验也复用这份定义
const ALLOWED_EXTS = ['.md', '.pdf'] // 当前仅支持 Markdown 与 PDF 两种格式

// 图片附件后缀：不做文本解析与向量化，直接作为多模态内容交给视觉模型
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

// 确保uploads文件夹存在
const UPLOAD_DIR = path.join(__dirname, 'uploads') // 上传文件的落盘目录：当前文件所在目录下的 uploads
if (!fs.existsSync(UPLOAD_DIR)) { // 检查 uploads 目录是否已经存在
  fs.mkdirSync(UPLOAD_DIR, { recursive: true }) // 不存在则递归创建，避免父目录缺失时报错
}

/**
 * 还原竖排文本：电子发票等 PDF 会把「购买方信息」「备注」这类竖排标签
 * 按单个汉字拆成多行，这里把连续的单字行拼回一行，避免引用来源里一个字占一行。
 * 只在单字行占比达到阈值时才处理，正常文档（如 Markdown）不受影响。
 * @param {string} text 按行分隔的文本
 * @returns {string}
 */
function mergeVerticalCharLines(text) {
  const lines = text.split('\n')
  const contentLines = lines.filter(line => line.trim())
  if (!contentLines.length) return text
  const singleCharCount = contentLines.filter(line => Array.from(line.trim()).length === 1).length
  if (singleCharCount / contentLines.length < 0.2) return text // 单字行少，属于正常换行，不处理

  const merged = []
  let buffer = '' // 累积连续的单字行
  for (const line of lines) {
    const trimmed = line.trim()
    if (Array.from(trimmed).length === 1) { // 单字行先缓存，等遇到整行再一起输出
      buffer += trimmed
      continue
    }
    if (buffer) {
      merged.push(buffer)
      buffer = ''
    }
    merged.push(line) // 空行也会在这里中断单字合并
  }
  if (buffer) merged.push(buffer)
  return merged.join('\n')
}

/**
 * 清洗文本：去除多余空行、空格，并还原 PDF 竖排产生的单字行
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  const normalized = text // 在原始文本上做链式替换，返回清洗后的结果
    .replace(/\r\n/g, '\n') // 先把 Windows 的 \r\n 统一成 \n，方便后续按行处理
    .replace(/[ \t]+/g, ' ') // 只把行内连续的空格/制表符压缩成一个空格，保留换行结构
    .replace(/^-- \d+ of \d+ --$/gm, '') // 去掉 pdf-parse 自动插入的分页标记，如「-- 1 of 1 --」
  return mergeVerticalCharLines(normalized) // 合并「购\n买\n方\n信\n息」这类竖排单字行
    .replace(/\n{3,}/g, '\n\n') // 连续 3 个以上换行压缩成 1 个空行，最多保留段落分隔
    .trim() // 去掉首尾空白字符（含换行与空格）
}

// 中英文句末标点后的位置作为切分点
const SENTENCE_SPLIT_RE = /(?<=[。！？；!?;\n])/ // 零宽后行断言：在句号/问号/感叹号/分号/换行之后切分，且不消耗标点本身

/**
 * 超长单句的兜底切分：按字符窗口硬切，保留 overlap 重叠
 * @param {string} text 超长句子
 * @param {number} chunkSize 单块最大字符
 * @param {number} overlap 重叠字符
 * @returns string[]
 */
function hardSplit(text, chunkSize, overlap) {
  const pieces = [] // 存放按字符切出来的片段
  let startIndex = 0 // 当前窗口的起始下标
  while (startIndex < text.length) { // 只要还没切到文本结尾就继续
    const endIndex = Math.min(startIndex + chunkSize, text.length) // 窗口结束位置，最后一块可能不足 chunkSize
    pieces.push(text.slice(startIndex, endIndex)) // 截取当前窗口的内容并收集
    if (endIndex === text.length) break // 已经到结尾，直接结束，避免在尾部原地循环
    const nextIndex = endIndex - overlap // 下一块回退 overlap 个字符，形成上下文重叠
    if (nextIndex <= startIndex) break // 重叠大于等于块长时的兜底，防止死循环
    startIndex = nextIndex // 把窗口起点前移，继续下一轮
  }
  return pieces // 返回所有硬切片段
}

/**
 * 文本分块：段落 → 句子 → 字符 三级回退，尽量在语义边界处断开
 * @param {string} text 原始文本
 * @param {number} chunkSize 单块最大字符
 * @param {number} overlap 重叠字符
 * @returns string[]
 */
function splitTextIntoChunks(text, chunkSize = 800, overlap = 150) {
  // 一级：按空行切段落；二级：段落内按句末标点切句子
  const units = [] // 存放切分后的句子单元，作为拼块的最小单位
  for (const paragraph of String(text).split(/\n{2,}/)) { // 一级：用空行把全文切成段落（兼容非字符串入参）用「连续两个或更多换行符」作为分隔符，把字符串切割成数组
    const trimmed = paragraph.trim() // 去掉段落首尾空白
    if (!trimmed) continue // 空段落直接跳过，避免产生空块
    for (const sentence of trimmed.split(SENTENCE_SPLIT_RE)) { // 二级：把段落按句末标点切成句子
      const s = sentence.trim() // 去掉句子首尾空白（含拆分产生的空行）
      if (s) units.push(s) // 非空句子才收集为单元
    }
  }

  const chunks = [] // 最终输出的块列表
  let current = [] // 当前块已累积的句子单元
  let currentLen = 0 // 当前块拼接后的字符长度（含换行），用于快速判断是否超限

  // 结算当前块，并把尾部若干完整句子作为下一块的重叠前缀
  const flush = () => { // 结算函数：输出当前块，并保留重叠前缀
    if (!current.length) return // 当前块为空则无需结算
    chunks.push(current.join('\n')) // 用换行拼接句子，作为一块输出
    const tail = [] // 下一块要复用的重叠句子
    let tailLen = 0 // 重叠句子累计长度
    for (let i = current.length - 1; i >= 0; i--) { // 从当前块末尾往前取，保证是完整的句子
      const unit = current[i] // 取出一个句子单元
      if (unit.length > overlap || tailLen + unit.length > overlap) break // 单句超过重叠长度或累加超限就停止
      tail.unshift(unit) // 放到重叠数组头部，保持原有顺序
      tailLen += unit.length // 累加重叠长度
    }
    current = tail // 下一块以重叠句子开头
    currentLen = current.length ? current.join('\n').length : 0 // 重算当前块长度
  }

  for (const unit of units) { // 逐个句子单元组装成块
    // 三级：单句仍超长时，先结算存量，再按字符硬切
    if (unit.length > chunkSize) { // 单句本身就超过块长上限
      if (current.length) { // 如果前面还有积累的内容
        chunks.push(current.join('\n')) // 先把存量单独结算成一块
        current = [] // 清空累积区
        currentLen = 0 // 长度同步清零
      }
      chunks.push(...hardSplit(unit, chunkSize, overlap)) // 用字符窗口硬切这个超长句并追加
      continue // 该句子已处理完，进入下一个单元
    }
    if (current.length && currentLen + unit.length + 1 > chunkSize) { // 加上换行后已超过块长上限
      flush() // 结算当前块，并把尾部句子留作重叠前缀
      // 重叠前缀 + 新句子仍超限时，放弃重叠，避免块超长
      if (currentLen + unit.length + 1 > chunkSize) { // 重叠前缀太长仍放不下新句子
        current = [] // 丢弃重叠前缀
        currentLen = 0 // 长度同步清零
      }
    }
    current.push(unit) // 把当前句子放入块中
    currentLen = current.join('\n').length // 重算当前块长度（含换行）
  }
  if (current.length) chunks.push(current.join('\n')) // 循环结束后把最后一块也输出
  return chunks // 返回全部分块结果
}

/**
 * 根据文件后缀，读取并提取文档纯文本
 * @param {string} filePath 文件本地路径
 * @param {string} ext 文件后缀，取值见 ALLOWED_EXTS
 * @returns {Promise<string>}
 */
async function extractFileText(filePath, ext) { // 按后缀分发到不同的解析逻辑
  if (!ALLOWED_EXTS.includes(ext)) { // 后缀不在白名单内直接拒绝
    throw new Error(`不支持的文件类型：${ext || '未知'}，仅支持 ${ALLOWED_EXTS.join(' / ')}`) // 抛出可读的类型错误
  }
  const rawBuffer = fs.readFileSync(filePath) // 同步读取文件内容为 Buffer，上传文件通常很小
  let text // 存放解析出来的原始文本
  if (ext === '.md') { // Markdown 分支：先渲染成 HTML 再剥标签
    const rawMarkdown = rawBuffer.toString('utf8') // 按 UTF-8 解码成 Markdown 字符串
    const html = md.render(rawMarkdown) // 调用 markdown-it 把 Markdown 渲染成 HTML
    text = html.replace(/<[^>]+>/g, '') // 用正则去掉所有 HTML 标签，只保留纯文本
  } else { // 剩余情况只可能是 .pdf（已被白名单保证）
    const parser = new PDFParse({ data: rawBuffer }) // pdf-parse v2 用 Buffer 实例化解析器
    try { // try/finally 保证解析器一定被释放
      const pdfData = await parser.getText() // 异步提取 PDF 全部页面文本
      text = pdfData.text // 取出纯文本内容
    } finally { // 无论成功失败都要执行
      await parser.destroy() // 释放 pdfjs 资源，避免内存泄漏
    }
  }
  const cleaned = cleanText(text) // 统一做空白与空行清洗
  // 扫描版 PDF / 空白文档会解析出空字符串，显式报错避免下游拿到空块
  if (!cleaned) { // 清洗后没有任何有效字符
    throw new Error('未提取到文本内容，若为扫描版 PDF 需要先做 OCR') // 抛出明确原因，便于前端提示
  }
  return cleaned // 返回可直接用于切块的纯文本
}

module.exports = { // 导出模块对外能力
  UPLOAD_DIR, // 上传目录，供 multer 指定落盘位置
  ALLOWED_EXTS, // 后缀白名单，供路由层 fileFilter 复用
  IMAGE_EXTS, // 图片附件后缀，会话附件上传时走多模态分支
  cleanText, // 文本清洗函数
  splitTextIntoChunks, // 文本切块函数
  extractFileText // 文档解析入口
}
