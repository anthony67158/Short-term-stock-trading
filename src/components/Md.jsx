// 轻量 Markdown 渲染（无三方依赖）：标题 # / 加粗 ** / 列表 - 1. / 行内代码 ` / 分隔线 / 引用 > / GFM 表格
// 面向 AI 短答，安全转义后再套用有限标记
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function inline(s) {
  let t = esc(s)
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
  t = t.replace(/`([^`]+?)`/g, '<code>$1</code>')
  return t
}

// 是否是表格分隔行： |---|:--:|---| 之类（允许冒号对齐）
function isTableDivider(line) {
  const s = line.trim()
  if (!s.includes('-')) return false
  // 去掉首尾管道后，每个单元格必须是 只含 - : 空格 的形式
  const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|')
  if (cells.length < 1) return false
  return cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c))
}
// 拆分一行表格为单元格（去掉首尾管道）
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}
// 解析对齐：:--- 左 / :--: 中 / ---: 右
function parseAligns(divider) {
  return splitRow(divider).map((c) => {
    const s = c.trim()
    const l = s.startsWith(':'), r = s.endsWith(':')
    if (l && r) return 'center'
    if (r) return 'right'
    if (l) return 'left'
    return 'left'
  })
}

export default function Md({ text }) {
  const src = String(text || '')
  const lines = src.split('\n')
  const blocks = []
  let list = null // { ordered, items: [] }
  let quote = null // { lines: [] }

  const flush = () => {
    if (list) { blocks.push({ type: 'list', ...list }); list = null }
    if (quote) { blocks.push({ type: 'quote', text: quote.lines.join(' ') }); quote = null }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flush(); continue }

    // GFM 表格：当前行像表格行(含 |) 且下一行是分隔行 → 收集整段表格
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flush()
      const header = splitRow(line)
      const aligns = parseAligns(lines[i + 1])
      const rows = []
      let j = i + 2
      for (; j < lines.length; j++) {
        const r = lines[j]
        if (!r.trim() || !r.includes('|')) break
        rows.push(splitRow(r))
      }
      blocks.push({ type: 'table', header, aligns, rows })
      i = j - 1
      continue
    }

    // 标题 #..######
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flush(); blocks.push({ type: 'h', level: Math.min(h[1].length, 4), text: h[2] }); continue }
    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flush(); blocks.push({ type: 'hr' }); continue }
    // 引用块 >
    const bq = line.match(/^\s*>\s?(.*)$/)
    if (bq) { if (list) flush(); if (!quote) quote = { lines: [] } ; quote.lines.push(bq[1]); continue }
    // 有序列表
    const ol = line.match(/^\s*(\d+)[.、)]\s+(.*)$/)
    if (ol) { if (quote) flush(); if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] } } list.items.push(ol[2]); continue }
    // 无序列表
    const ul = line.match(/^\s*[-*·•]\s+(.*)$/)
    if (ul) { if (quote) flush(); if (!list || list.ordered) { flush(); list = { ordered: false, items: [] } } list.items.push(ul[1]); continue }
    // 普通段落
    flush()
    blocks.push({ type: 'p', text: line })
  }
  flush()

  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.type === 'h') { const T = 'h' + b.level; return <T key={i} className={'md-h md-h' + b.level} dangerouslySetInnerHTML={{ __html: inline(b.text) }} /> }
        if (b.type === 'hr') return <hr key={i} className="md-hr" />
        if (b.type === 'quote') return <blockquote key={i} className="md-quote" dangerouslySetInnerHTML={{ __html: inline(b.text) }} />
        if (b.type === 'table') {
          return (
            <div className="md-table-wrap" key={i}>
              <table className="md-table">
                <thead>
                  <tr>{b.header.map((c, j) => <th key={j} style={{ textAlign: b.aligns[j] || 'left' }} dangerouslySetInnerHTML={{ __html: inline(c) }} />)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr key={ri}>
                      {b.header.map((_, ci) => <td key={ci} style={{ textAlign: b.aligns[ci] || 'left' }} dangerouslySetInnerHTML={{ __html: inline(row[ci] != null ? row[ci] : '') }} />)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (b.type === 'list') {
          const T = b.ordered ? 'ol' : 'ul'
          return <T key={i} className="md-list">{b.items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inline(it) }} />)}</T>
        }
        return <p key={i} className="md-p" dangerouslySetInnerHTML={{ __html: inline(b.text) }} />
      })}
    </div>
  )
}
