// 全站通用：AI 研判(ReAct/CoT 推理链)展示。
// 后端把推理链塞进一个字符串里，用 ①②③④⑤ 标记步骤(有时用 → 连接)。
// 以前直接平铺成一坨，扫读困难；这里按步骤序号拆成独立行，每步一行、序号高亮。
// 用法：<Reasoning text={adv.reasoning} /> ；style 透传到最外层容器(供个别处调 margin)。

const STEP_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

// 把一段 reasoning 拆成步骤数组。兼容三种写法：
//   1) 带 ①②③ 圈号标记(主流)
//   2) 无圈号但用 → 分隔
//   3) 完全无分隔 → 整段作为一条
function splitSteps(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  // 有圈号：按圈号切，保留圈号本身作为该步的标号
  if (STEP_MARKS.some((m) => raw.includes(m))) {
    const parts = []
    // 用正则在每个圈号处断开
    const re = /([①②③④⑤⑥⑦⑧⑨⑩])/g
    let lastIdx = 0, m, cur = null
    while ((m = re.exec(raw)) !== null) {
      if (cur !== null) parts.push({ mark: cur, body: raw.slice(lastIdx, m.index).trim() })
      cur = m[1]
      lastIdx = m.index + m[1].length
    }
    if (cur !== null) parts.push({ mark: cur, body: raw.slice(lastIdx).trim() })
    // 圈号前如果有前缀文字(如"研判：")，忽略；只保留有 body 的步骤
    return parts.filter((p) => p.body).map((p, i) => ({ mark: STEP_MARKS[i] || p.mark, body: p.body.replace(/^→\s*/, '') }))
  }
  // 无圈号但有 → ：按箭头切
  if (raw.includes('→')) {
    return raw.split('→').map((s) => s.trim()).filter(Boolean).map((body, i) => ({ mark: STEP_MARKS[i] || '·', body }))
  }
  // 兜底：整段一条
  return [{ mark: '', body: raw }]
}

export default function Reasoning({ text, style }) {
  const steps = splitSteps(text)
  if (!steps.length) return null
  // 单条(无法拆分)时退化成一行紧凑样式，避免"一步"也占满结构
  if (steps.length === 1 && !steps[0].mark) {
    return (
      <div className="ai-reasoning" style={style}>
        <span className="ai-reasoning-k">研判</span>
        <span className="ai-reasoning-body">{steps[0].body}</span>
      </div>
    )
  }
  return (
    <div className="ai-reasoning-steps" style={style}>
      <div className="ai-reasoning-head"><span className="ai-reasoning-k">研判思路</span></div>
      <ol className="ai-reasoning-list">
        {steps.map((s, i) => (
          <li className="ai-reasoning-step" key={i}>
            <span className="ai-reasoning-mark">{s.mark || (i + 1)}</span>
            <span className="ai-reasoning-text">{s.body}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
