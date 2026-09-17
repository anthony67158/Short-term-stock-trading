// 排序模型分快照读取：加载离线发布的 ranking-score-snapshot.v1（真实 LightGBM 模型分）。
// 优先 OSS(stockpick/ranking-score-snapshot.json)，本地回落 RANKING_SNAPSHOT_PATH 指定文件。
// 缺失/格式无效时返回 null，召回层据此回落规则分并标注（不伪装模型分）。
import { readFile } from 'node:fs/promises'
import { readJson, hasStorage } from './_blob.js'

const OSS_PATH = 'stockpick/ranking-score-snapshot.json'
const SNAPSHOT_SCHEMA = 'ranking-score-snapshot.v1'
const CACHE_TTL_MS = 5 * 60 * 1000

let cache = { at: 0, value: null }

function validSnapshot(raw) {
  if (!raw || raw.schemaVersion !== SNAPSHOT_SCHEMA) return null
  if (!raw.scores || typeof raw.scores !== 'object') return null
  return raw
}

async function readFromDisk() {
  const path = process.env.RANKING_SNAPSHOT_PATH
  if (!path) return null
  try {
    const text = await readFile(path, 'utf8')
    return validSnapshot(JSON.parse(text))
  } catch {
    return null
  }
}

export async function loadRankingScoreSnapshot({ now = Date.now() } = {}) {
  if (cache.value && now - cache.at < CACHE_TTL_MS) return cache.value
  let snapshot = null
  if (hasStorage()) {
    snapshot = validSnapshot(await readJson(OSS_PATH).catch(() => null))
  }
  if (!snapshot) snapshot = await readFromDisk()
  cache = { at: now, value: snapshot }
  return snapshot
}

// 把快照转成 code -> { state:'READY', rankingScore, expectedNetR, modelVersion }。
// rankingScore 用 0~1 的 rankPercentile（跨全市场同日相对分），与规则分不同量纲但同为降序更优。
export function rankingScoreLookup(snapshot) {
  if (!snapshot?.scores) return () => null
  const modelVersion = snapshot.modelVersion || snapshot.bundleId || ''
  return (code) => {
    const entry = snapshot.scores[String(code)]
    if (!entry) return null
    return {
      state: 'READY',
      rankingScore: Number(entry.rankPercentile),
      pFill: null,
      pWinGivenFill: null,
      expectedNetR: Number(entry.expectedGrossReturn),
      modelVersion,
    }
  }
}

export function resetRankingSnapshotCache() {
  cache = { at: 0, value: null }
}
