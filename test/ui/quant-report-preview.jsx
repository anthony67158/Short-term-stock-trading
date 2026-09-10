import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import QuantReport from '../../src/components/QuantReport.jsx'
import { quantReportUiStore, useQuantReportOpen } from '../../src/quantReportUiStore.js'

if (!import.meta.env.DEV) throw new Error('Local fixture only')
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'light'
quantReportUiStore.open()

function Preview() {
  const open = useQuantReportOpen()
  return open ? <QuantReport /> : <button onClick={() => quantReportUiStore.open()}>打开量化汇报</button>
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />)
