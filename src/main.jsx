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
