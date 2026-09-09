import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import AdviceGenerationStatus from '../../src/components/AdviceGenerationStatus.jsx'

if (!import.meta.env.DEV || location.hostname !== '127.0.0.1') {
  throw new Error('Local fixture only')
}

const reasoning = Array.from(
  { length: 40 },
  (_, index) => `第${index + 1}项：正在核对量价、资金、技术与账户风险约束。`,
).join('\n')

ReactDOM.createRoot(document.getElementById('root')).render(
  <main style={{ maxWidth: 960, margin: '32px auto', padding: '0 16px' }}>
    <AdviceGenerationStatus
      code="600000"
      variant="detail"
      detailState={{
        loading: true,
        deepMode: true,
        phase: '模型仍在完整研判，尚未返回可发布结论；已等待180秒',
        reasoning,
        sources: [
          { label: '今日实时行情', ok: true },
          { label: '个股资金流', ok: true },
          { label: '量化预测', ok: true },
        ],
      }}
    />
  </main>,
)
