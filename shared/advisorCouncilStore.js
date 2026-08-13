export function councilRecordsFromData(data = {}) {
  return (Array.isArray(data.advisorCouncilShadow)
    ? data.advisorCouncilShadow
    : [])
    .filter((record) =>
      record?.schemaVersion === 'advisor-council-shadow.v1'
      && record.shadowOnly === true
      && record.actionable !== true
    )
    .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))
}

export function addCouncilShadowRecord(
  data,
  record,
  {
    totalLimit = 200,
    perCodeLimit = 20,
  } = {},
) {
  if (
    !data
    || typeof data !== 'object'
    || record?.schemaVersion !== 'advisor-council-shadow.v1'
    || record.shadowOnly !== true
    || record.actionable === true
  ) return false
  const codeCounts = new Map()
  const output = []
  const records = [record, ...councilRecordsFromData(data)]
  const seen = new Set()
  for (const item of records) {
    const key = [
      item.code,
      item.at,
      item.evidenceSnapshotId,
      item.baseAdviceAction,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    const code = String(item.code || 'unknown')
    const count = codeCounts.get(code) || 0
    if (count >= Math.max(1, perCodeLimit)) continue
    codeCounts.set(code, count + 1)
    output.push(item)
    if (output.length >= Math.max(1, totalLimit)) break
  }
  data.advisorCouncilShadow = output
  return true
}
