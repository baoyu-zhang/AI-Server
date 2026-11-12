/**
 * export-markdown.ts —— 把模型回答（Markdown）导出成可读文件 / 可打印页面
 *
 * ===== 为什么自己写转换器而不引 marked =====
 * 只需要覆盖模型实际会产出的语法子集（标题/列表/表格/代码块/加粗/链接），
 * 一份 100 行的转换器换掉一个依赖；更重要的是导出场景对"安全"要求不同：
 * 这里的输入可能包含用户上传文档的内容，绝不能把其中的 HTML 原样注入——
 * 所以先整体转义再按规则还原，标签只由本文件生成。
 *
 * 输出目标是 Word（.doc 用 HTML 载体，Word/WPS/Pages 都能打开并继续编辑）
 * 与打印（独立窗口 + 打印专用 CSS，只打正文，不打聊天界面）。
 */

/** HTML 转义：先做，保证后面所有替换都是"从转义文本上还原结构" */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内语法：行内代码 → 加粗 → 斜体 → 删除线 → 链接 */
function inline(text: string): string {
  const codes: string[] = []
  // 先把行内代码抽出来占位，否则 `a_b_c` 里的下划线会被当斜体处理
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = escapeHtml(out)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  // 占位符还原（占位符本身不含 HTML 特殊字符，escape 不会破坏它）
  return out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codes[Number(index)] || '')
}

/** 表格：把连续的 | 行转成 <table>，第二行是分隔行（|---|） */
function renderTable(rows: string[]): string {
  const cellsOf = (line: string) =>
    line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
  const head = cellsOf(rows[0])
  const body = rows.slice(2).map(cellsOf)
  const th = head.map(cell => `<th>${inline(cell)}</th>`).join('')
  const trs = body
    .map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`
}

/**
 * Markdown → HTML 片段
 * 支持：标题、段落、有序/无序列表、引用、代码块、表格、分隔线、行内语法
 */
export function markdownToHtml(markdown: string): string {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 代码块：整块原样保留（不走 inline 处理），语言标记用作 class
    if (/^```/.test(line.trim())) {
      const lang = line.trim().replace(/^```/, '').trim()
      const buffer: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buffer.push(lines[i])
        i += 1
      }
      i += 1 // 跳过收尾的 ```
      html.push(
        `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(buffer.join('\n'))}</code></pre>`
      )
      continue
    }

    // 空行
    if (!line.trim()) {
      i += 1
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i += 1
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      html.push('<hr />')
      i += 1
      continue
    }

    // 表格：当前行是 |...| 且下一行是分隔行
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i])
        i += 1
      }
      if (rows.length >= 2) html.push(renderTable(rows))
      continue
    }

    // 引用块：连续 > 行合并
    if (/^\s*>\s?/.test(line)) {
      const buffer: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buffer.push(inline(lines[i].replace(/^\s*>\s?/, '')))
        i += 1
      }
      html.push(`<blockquote>${buffer.join('<br />')}</blockquote>`)
      continue
    }

    // 列表：连续同类型行合并成一个 ul/ol（缩进层级简化为单层，导出场景够用）
    const listMatch = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!m || /\d/.test(m[1]) !== ordered) break
        items.push(`<li>${inline(m[2])}</li>`)
        i += 1
      }
      html.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }

    // 普通段落：连续非空行合并（保留软换行为 <br />，模型常用它做紧凑排版）
    const paragraph: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      paragraph.push(inline(lines[i]))
      i += 1
    }
    if (paragraph.length) html.push(`<p>${paragraph.join('<br />')}</p>`)
  }

  return html.join('\n')
}

/** 导出用样式：Web 与 Word 共用（Word 只认内联/内部样式，不认现代 CSS 变量） */
const DOC_STYLE = `
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f1f1f; line-height: 1.75; font-size: 14px; }
  h1 { font-size: 22px; margin: 22px 0 12px; }
  h2 { font-size: 19px; margin: 20px 0 10px; border-left: 4px solid #0052d9; padding-left: 10px; }
  h3 { font-size: 16px; margin: 16px 0 8px; }
  h4, h5, h6 { font-size: 14px; margin: 14px 0 6px; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 24px; }
  li { margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #dcdcdc; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f5f7fa; }
  code { background: #f2f3f5; border-radius: 3px; padding: 1px 4px; font-family: Consolas, Monaco, monospace; font-size: 12.5px; }
  pre { background: #f7f7f9; border: 1px solid #ececec; border-radius: 6px; padding: 12px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 10px 0; padding: 6px 12px; border-left: 3px solid #dcdcdc; color: #555; background: #fafafa; }
  hr { border: none; border-top: 1px solid #e7e7e7; margin: 16px 0; }
  @page { margin: 18mm 16mm; }
`

/** 包一层完整 HTML 文档（下载与打印共用，保证两边版式一致） */
export function buildHtmlDocument(title: string, markdown: string, meta?: string): string {
  const body = markdownToHtml(markdown)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>${DOC_STYLE}</style>
</head>
<body>
${meta ? `<p style="color:#888;font-size:12px;margin:0 0 12px;">${escapeHtml(meta)}</p>` : ''}
${body}
</body>
</html>`
}

/** 取标题：优先回答里的一级标题，其次首行，最后回落到时间戳文件名 */
export function suggestTitle(markdown: string, fallbackPrefix = 'AI回答'): string {
  const headingLine = String(markdown || '')
    .split('\n')
    .map(line => line.trim())
    .find(line => /^#{1,3}\s+/.test(line))
  const firstLine = String(markdown || '').split('\n').map(line => line.trim()).find(Boolean) || ''
  const raw = (headingLine ? headingLine.replace(/^#{1,3}\s+/, '') : firstLine)
    .replace(/[\\/:*?"<>|]/g, '') // 文件名非法字符
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[\\/:*?"<>|\s]/g, '-')
  return raw ? `${raw}` : `${fallbackPrefix}-${stamp}`
}

/** 触发浏览器下载 */
export function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 延迟释放：立即 revoke 在部分浏览器（Safari）会让下载中断
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 打印：写进隐藏 iframe 再调用 print()
 * 为什么不用 window.open：会被弹窗拦截器拦掉，用户以为"点了没反应"；
 * iframe 还顺带解决了"打印整个聊天界面"的问题——打印的是干净文档。
 */
export function printHtml(html: string) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow?.document
  if (!doc) {
    document.body.removeChild(iframe)
    return
  }
  doc.open()
  doc.write(html)
  doc.close()
  // 等一帧让样式与字体落地，否则偶发打印出空白页
  setTimeout(() => {
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    // 打印对话框是同步阻塞的（多数浏览器），关闭后再移除节点
    setTimeout(() => document.body.removeChild(iframe), 1000)
  }, 120)
}
