import { useStockTag } from '../stockTagStore'

function visibleTags(info, fallbackIndustry, max) {
  const tags = Array.isArray(info?.displayTags)
    ? info.displayTags.filter((tag) => tag?.name)
    : []
  const industry = String(info?.industry || fallbackIndustry || '').trim()
  if (
    industry
    && industry !== '其他'
    && !tags.some((tag) => tag.name === industry)
  ) {
    tags.push({ name: industry, kind: 'industry' })
  }
  return tags.slice(0, max)
}

export default function StockTags({
  code,
  fallbackIndustry = '',
  variant = 'inline',
  max = 2,
  className = '',
}) {
  const info = useStockTag(code)
  const tags = visibleTags(info, fallbackIndustry, max)
  if (!tags.length) return null
  const concepts = Array.isArray(info?.concepts)
    ? info.concepts.join('、')
    : ''
  const verified = !!info?.conceptVerified
  const evidenceLabel = verified
    ? '东方财富 F10 精确题材'
    : '东方财富个股资料（回退）'
  const title = concepts
    ? `${evidenceLabel}：${concepts}`
    : `所属行业：${info?.industry || fallbackIndustry}`
  return (
    <span
      className={`stock-theme-tags ${variant} ${className}`.trim()}
      data-verified={verified ? 'true' : 'false'}
      aria-label={`${verified ? '已核验' : '回退'}题材与行业：${tags.map((tag) => tag.name).join('、')}`}
      title={title}
    >
      {tags.map((tag) => (
        <span
          key={`${tag.kind}-${tag.name}`}
          className={`stock-theme-tag ${tag.kind === 'concept' ? 'concept' : 'industry'}`}
        >
          {tag.name}
        </span>
      ))}
    </span>
  )
}
