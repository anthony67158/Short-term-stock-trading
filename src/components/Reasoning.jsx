import { humanizeUserFacingText } from '../../shared/userFacingLanguage.js'
import { splitAdviceReasoningSteps } from '../../shared/adviceReasoning.js'

// 全站通用研判摘要展示。兼容圈号、箭头和按证据维度换行的摘要，
// 统一拆成独立步骤，避免长文本堆叠或重复字段影响扫读。
// 用法：<Reasoning text={adv.reasoning} /> ；style 透传到最外层容器(供个别处调 margin)。

export default function Reasoning({ text, style }) {
  const steps = splitAdviceReasoningSteps(
    humanizeUserFacingText(text || ''),
  )
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
