// 统一 API 基址：前端部署在 Vercel(静态)，后端在阿里云 FC。
// - 生产构建：优先使用 VITE_API_BASE；缺失时回退稳定 FC 地址，避免请求误发 Vercel 404。
//   前端浏览器直连后端(后端已开 CORS: Access-Control-Allow-Origin *)。
//   直连而非走 Vercel 反代——因为 Vercel 外部 rewrite 不稳定支持 SSE 流式。
// - 本地开发：VITE_API_BASE 为空，走 vite.config.js 的 /api 代理到 localhost:3000。
export const PRODUCTION_API_BASE = 'https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run'
export const PRODUCTION_SITE_HOST = 'www.tedixtf.cn'

export function resolveApiBase(env = {}, runtime = {}) {
  const hostname = String(runtime.hostname || '').trim().toLowerCase()
  if (hostname === PRODUCTION_SITE_HOST) return ''
  const configured = String(env.VITE_API_BASE || '').trim()
  const fallback = env.PROD ? PRODUCTION_API_BASE : ''
  return (configured || fallback).replace(/\/+$/, '')
}

const runtime = typeof window === 'undefined' ? {} : window.location
export const API_BASE = resolveApiBase(import.meta.env, runtime)

// 把以 /api 开头的相对路径拼上后端基址；其它路径原样返回。
export function api(path) {
  if (API_BASE && typeof path === 'string' && path.startsWith('/api')) {
    return API_BASE + path
  }
  return path
}
