import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/space-grotesk/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import App from './App.jsx'
import './styles.css'
import './styles/precision.css'
import { registerSW } from './push'

// 注册 Service Worker(用于 Web Push 后台推送);失败静默降级为纯前端预警
registerSW()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// D-15 首屏挂载后淡出启动闪屏(消除白屏);双 rAF 确保首帧已绘制
function hideSplash() {
  const sp = document.getElementById('app-splash')
  if (!sp) return
  sp.classList.add('hide')
  setTimeout(() => { try { sp.remove() } catch { /* ignore */ } }, 360)
}
requestAnimationFrame(() => requestAnimationFrame(hideSplash))
// 兜底:极端情况下 rAF 未触发也不至于卡住闪屏
setTimeout(hideSplash, 4000)
