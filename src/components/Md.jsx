// 轻量 Markdown 渲染（无三方依赖）：标题 # / 加粗 ** / 列表 - 1. / 行内代码 ` / 分隔线
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

export default function Md({ text }) {
  const src = String(text || '')
  const lines = src.split('\n')
  const blocks = []
  let list = null // { ordered, items: [] }

  const flush = () => {
    if (list) { blocks.push({ type: 'list', ...list }); list = null }
  }

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { flush(); continue }
    // 标题 #..######
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flush(); blocks.push({ type: 'h', level: Math.min(h[1].length, 4), text: h[2] }); continue }
    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flush(); blocks.push({ type: 'hr' }); continue }
    // 有序列表
    const ol = line.match(/^\s*(\d+)[.、)]\s+(.*)$/)
    if (ol) { if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] } } list.items.push(ol[2]); continue }
    // 无序列表
    const ul = line.match(/^\s*[-*·•]\s+(.*)$/)
    if (ul) { if (!list || list.ordered) { flush(); list = { ordered: false, items: [] } } list.items.push(ul[1]); continue }
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
        if (b.type === 'list') {
          const T = b.ordered ? 'ol' : 'ul'
          return <T key={i} className="md-list">{b.items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inline(it) }} />)}</T>
        }
        return <p key={i} className="md-p" dangerouslySetInnerHTML={{ __html: inline(b.text) }} />
      })}
    </div>
  )
}
