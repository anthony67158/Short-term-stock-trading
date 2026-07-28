// AI 助手对话按「日期」持久化（本地 localStorage，按当前账号隔离）
// 结构：chat_v1__<user> = { '2026-07-27': [ {role,kind,content,...}, ... ], ... }
// - 当天对话自动保存；可按天查看历史、按天删除
// - 发问时传当天完整上下文给后端，保证单日对话连贯

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function storeKey() {
  let u = ''
  try { const s = JSON.parse(localStorage.getItem('cloud_session_v1') || 'null'); u = s?.nick || '' } catch { /* ignore */ }
  return 'chat_v1__' + u
}

function loadAll() {
  try { return JSON.parse(localStorage.getItem(storeKey()) || '{}') } catch { return {} }
}
function saveAll(obj) {
  try { localStorage.setItem(storeKey(), JSON.stringify(obj)) } catch { /* ignore */ }
}

export const chatStore = {
  today: todayKey,
  // 读取某天对话（默认今天）
  load(day = todayKey()) {
    const all = loadAll()
    return all[day] || []
  },
  // 保存某天对话（默认今天）
  save(msgs, day = todayKey()) {
    const all = loadAll()
    if (!msgs || msgs.length === 0) delete all[day]
    else all[day] = msgs
    saveAll(all)
  },
  // 所有有对话的日期（新→旧）
  days() {
    return Object.keys(loadAll()).sort((a, b) => (a < b ? 1 : -1))
  },
  // 删除某天对话
  removeDay(day) {
    const all = loadAll()
    delete all[day]
    saveAll(all)
  },
  // 某天摘要（供历史列表展示）
  summary(day) {
    const msgs = this.load(day)
    const firstUser = msgs.find((m) => m.role === 'user')
    return { count: msgs.length, first: firstUser ? String(firstUser.content).slice(0, 30) : '（无）' }
  },
}
