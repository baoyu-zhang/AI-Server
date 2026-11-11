const fs = require('fs') // 引入 Node 内置文件系统模块，用于读写文件、创建目录
const path = require('path') // 引入 Node 内置路径模块，用于拼接路径、获取文件后缀
const markdownIt = require('markdown-it') // 引入 markdown-it，用于把 Markdown 渲染成 HTML
const pdfParse = require('pdf-parse') // 引入 pdf-parse，用于解析 PDF 文本
const { PDFParse } = pdfParse // pdf-parse v2 不再导出函数，需要从导出对象中取出 PDFParse 类
const mammoth = require('mammoth') // 引入 mammoth，用于解析 Word（.docx）文本

const md = new markdownIt() // 创建 Markdown 渲染器实例，模块级复用避免重复初始化

// 允许上传的文件后缀，路由层的白名单校验也复用这份定义
// 注意 .docx ≠ .doc：mammoth 只认 OOXML（2007 之后的 docx，本质是 zip+XML），
// 老版 .doc 是二进制 OLE 格式，解析它需要 LibreOffice 之类的重型依赖，所以不收。
const ALLOWED_EXTS = ['.md', '.pdf', '.docx'] // Markdown / PDF / Word

// 解析时提示用户「请另存为」的格式：doc 能上传但不解析，是最容易踩的坑
const LEGACY_EXTS = ['.doc']

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
 * HTML → 纯文本。
 *
 * 为什么不能只做 `html.replace(/<[^>]+>/g, '')`：
 * 剥标签不产生任何分隔符，`<p>甲</p><p>乙</p>` 会变成「甲乙」，
 * `<td>2020-2023</td><td>某某公司</td>` 会变成「2020-2023某某公司」。
 * 简历几乎全是表格排版，一旦粘连，切块按句号/换行切不动，
 * 一整份简历就变成几个巨块，检索时命中率断崖式下降，而且不报任何错。
 *
 * 所以先把块级标签换成换行、表格单元格换成 ` | `，再剥标签、解实体。
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  // 表格必须单独处理，且要在全局规则之前：
  // mammoth 输出的每个单元格里还包着 <p>，若先按「</p> → 换行」处理，
  // 表格会变成一格一行、` | ` 全被挤到行首（实测就是「时间\n | 公司\n | 职位」）。
  // 所以表格范围内先把段落压成空格，再让 </td> 当列分隔、</tr> 当换行。
  const flattened = html.replace(/<table[\s\S]*?<\/table>/gi, table =>
    table
      .replace(/<br\s*\/?>/gi, ' ') // 单元格内换行 → 空格，保住这一行的完整性
      .replace(/<\/(p|div|li|h[1-6])>/gi, ' ') // 单元格内段落 → 空格
      .replace(/<\/(td|th)>\s*(?=<\/(tr|tbody|thead)>)/gi, '') // 行尾最后一个单元格不要分隔符
      .replace(/<\/(td|th)>/gi, ' | ') // 列分隔，保住表格的行列语义
      .replace(/<\/tr>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+$/gm, '') // 清掉行尾空格（最后一格的段落被压成空格后残留）
  )
  return flattened
    .replace(/<br\s*\/?>/gi, '\n') // 换行标签
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n') // 块级结束 → 换行
    .replace(/<[^>]+>/g, '') // 剩余标签直接剥掉
    .replace(/&nbsp;/g, ' ') // 常见实体：不换行空格
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&') // 必须最后解：否则 "&amp;lt;" 会被还原成 "<"，把原文改坏
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
 * PII 脱敏规则表。
 *
 * 为什么必须在切块前做：简历一旦入库，同一份手机号会同时出现在
 * 向量库文件、检索回填给模型的上下文、服务端日志、以及用户点开的【引用来源】里。
 * 事后清理要同时改四个地方，而入口只有这一处——脱敏放在入口，成本最低、漏得最少。
 *
 * 每条规则都带边界断言（(?<!\d) / (?!\d)），这不是洁癖：
 * 缺了它，"纳税人识别号 91310000MA1FL1XX2Y" 里的片段、
 * 或 20 位发票号码里的 11 位，都会被误判成手机号/身份证，把业务数据打坏。
 *
 * 顺序有意义：先长后短。18 位身份证必须先于 16~19 位银行卡匹配，
 * 否则身份证会被当成银行卡，占位符写错（信息没丢，但会误导排查）。
 */
const PII_RULES = [
  // 邮箱必须排在第一位：z15021890501@163.com 这种「手机号 + 域名」的邮箱，
  // 先跑手机号规则会把中间挖掉，剩下 z[手机号已脱敏]@163.com —— 邮箱地址没盖住，反而更难读。
  { label: '邮箱', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, mask: '[邮箱已脱敏]' },
  // 身份证：17 位数字 + 1 位数字或 X
  { label: '身份证', pattern: /(?<![\dA-Za-z.])\d{17}[\dXx](?![\dA-Za-z])/g, mask: '[身份证已脱敏]' },
  // 银行卡：边界必须把字母和小数点也算进去。
  //   只写 (?<!\d) 时："91310115336433060T" 这类「数字 + 校验位字母」的纳税人识别号会被打掉半截；
  //   而 "0.9999999999999999" 这种浮点数，小数部分正好 16 位，会被当成银行卡——
  //   技术文档里全是这种数，误伤之后检索质量会悄悄下降，却不报任何错。
  { label: '银行卡', pattern: /(?<![\dA-Za-z.])\d{16,19}(?![\dA-Za-z])/g, mask: '[银行卡已脱敏]' },
  // 手机号：允许 138 1234 5678 / 138-1234-5678 这类分隔写法
  { label: '手机号', pattern: /(?<![\dA-Za-z.])1[3-9]\d(?:[\s-]?\d){8}(?![\dA-Za-z])/g, mask: '[手机号已脱敏]' },
  // 门牌级地址：只抹掉"门牌号"，路名与城市/区县都保留。
  // 为什么不整段抹：JD 里的工作地点要用来判断"候选人现居地是否匹配"，
  // 把城市抹了，location 这道硬门槛就没法判；而"某路 969 号"这种精确门牌才是关键隐私。
  // 为什么用后行断言锚在路名之后、而不是整段匹配：整段匹配必然带一个贪婪的字符类，
  // 它会把"西湖区文三路"从"区"开始吃进去（实测就是这样），城市信息跟着一起没了。
  // 只匹配后面的门牌号，就没有"吃多长"的自由度。
  {
    label: '门牌地址',
    // 路名用变长后行断言：V8 支持变长 lookbehind，这是唯一能"只替换后缀"的写法
    pattern: /(?<=[\u4e00-\u9fa5]{2,6}(?:路|街|大道|巷|弄|胡同))\s*\d{1,5}\s*号/g,
    mask: '[门牌已脱敏]'
  }
]

/**
 * 对文本做 PII 脱敏
 * @param {string} text
 * @returns {{ text: string, hits: Array<{label: string, count: number}> }}
 *   hits 只用于日志与验收（"这次传的简历里有 2 个手机号"），不返回原文片段，
 *   否则日志本身又成了泄露渠道。
 */
function redactPII(text) {
  let output = String(text || '')
  const hits = []
  for (const rule of PII_RULES) {
    const matched = output.match(rule.pattern)
    if (!matched || !matched.length) continue
    hits.push({ label: rule.label, count: matched.length })
    output = output.replace(rule.pattern, rule.mask)
  }
  return { text: output, hits }
}

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
    // .doc 单独给一句「请另存为」：用户手上十有八九就是这种老格式，
    // 只说"不支持"会让人以为整个 Word 都不支持。
    const hint = LEGACY_EXTS.includes(ext) ? '；.doc 是 2003 之前的老格式，请用 Word 另存为 .docx 后重试' : ''
    throw new Error(`不支持的文件类型：${ext || '未知'}，仅支持 ${ALLOWED_EXTS.join(' / ')}${hint}`) // 抛出可读的类型错误
  }
  const rawBuffer = fs.readFileSync(filePath) // 同步读取文件内容为 Buffer，上传文件通常很小
  let text // 存放解析出来的原始文本
  if (ext === '.md') { // Markdown 分支：先渲染成 HTML 再剥标签
    const rawMarkdown = rawBuffer.toString('utf8') // 按 UTF-8 解码成 Markdown 字符串
    text = htmlToText(md.render(rawMarkdown)) // 渲染成 HTML 后转纯文本，保住段落与表格结构
  } else if (ext === '.docx') { // Word 分支：mammoth 把 OOXML 转成语义化 HTML
    try {
      const result = await mammoth.convertToHtml({ buffer: rawBuffer }) // 只取正文，图片等非文本内容自动忽略
      text = htmlToText(result.value) // 同样走 HTML → 纯文本，与 md 分支共用一套分隔规则
    } catch (err) {
      // 损坏文件 / 加密文档 / 把 .doc 改后缀成 .docx 都会走到这里，
      // 原始报错是 "Can't find end of central directory" 之类，用户看不懂
      throw new Error(`Word 文档解析失败：${err.message}。若文件已加密或实为 .doc 格式，请解密或用 Word 另存为 .docx`)
    }
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
  // 脱敏放在解析的最后一步：清洗之后再抹，避免占位符被 cleanText 的空格压缩改形
  const { text: redacted, hits } = redactPII(cleaned)
  if (hits.length) {
    // 只记类型和数量，不记原文——日志本身就是常见的泄露渠道
    console.log(`🔒 PII 脱敏：${hits.map(item => `${item.label}×${item.count}`).join('，')}`)
  }
  return redacted // 返回可直接用于切块的纯文本
}

module.exports = { // 导出模块对外能力
  UPLOAD_DIR, // 上传目录，供 multer 指定落盘位置
  ALLOWED_EXTS, // 后缀白名单，供路由层 fileFilter 复用
  LEGACY_EXTS, // 需要提示「另存为新格式」的老格式（.doc），供 fileFilter 拼错误信息
  IMAGE_EXTS, // 图片附件后缀，会话附件上传时走多模态分支
  cleanText, // 文本清洗函数
  htmlToText, // HTML → 纯文本，导出给单元测试单独验证表格与段落分隔
  redactPII, // PII 脱敏，导出给单元测试与入库脚本单独调用
  splitTextIntoChunks, // 文本切块函数
  extractFileText // 文档解析入口
}
