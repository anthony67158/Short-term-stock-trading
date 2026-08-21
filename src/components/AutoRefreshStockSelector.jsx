import { useMemo, useState } from 'react'
import Icon from './Icon'
import StockGroupFilter from './StockGroupFilter'
import {
  buildStockGroups,
  selectBatchGroupCodes,
  toggleBatchGroupSelection,
} from '../../shared/stockGroupFilter.js'

function uniqueItems(items = []) {
  const seen = new Set()
  return items.filter((item) => {
    const code = String(item?.code || '').trim()
    if (!code || seen.has(code)) return false
    seen.add(code)
    return true
  })
}

export default function AutoRefreshStockSelector({
  scope,
  items = [],
  selectedCodes = [],
  quoteMap = {},
  tagMap = {},
  onChange,
}) {
  const [dimension, setDimension] = useState('concept')
  const [activeGroups, setActiveGroups] = useState(['全部'])
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const stocks = useMemo(() => uniqueItems(items), [items])
  const selectedSet = useMemo(
    () => new Set(selectedCodes),
    [selectedCodes],
  )
  const groups = useMemo(() => buildStockGroups(stocks, {
    dimension,
    tagMap,
    quoteMap,
  }), [stocks, dimension, tagMap, quoteMap])
  const pinnedCount = scope === 'watch'
    ? stocks.filter((item) => item?.star === true).length
    : 0
  const selectionScope = scope === 'hold' ? 'holding' : 'watchlist'
  const selectionInput = {
    holdings: scope === 'hold' ? stocks : [],
    watchlist: scope === 'watch' ? stocks : [],
    scope: selectionScope,
    dimension,
    tagMap,
    quoteMap,
  }
  const filteredCodes = selectBatchGroupCodes({
    ...selectionInput,
    pinnedOnly,
    groups: activeGroups.length ? activeGroups : ['全部'],
  })
  const visibleSet = new Set(filteredCodes)
  const visibleStocks = stocks.filter((item) => visibleSet.has(item.code))
  const tagsLoading = dimension === 'concept'
    && stocks.some((item) => tagMap[item.code] == null)

  const selectGroups = (group) => {
    const nextGroups = group === '全部' && pinnedOnly
      ? ['全部']
      : toggleBatchGroupSelection(activeGroups, group)
    const nextPinnedOnly = group === '全部' ? false : pinnedOnly
    const codes = selectBatchGroupCodes({
      ...selectionInput,
      pinnedOnly: nextPinnedOnly,
      groups: nextGroups,
    })
    setPinnedOnly(nextPinnedOnly)
    setActiveGroups(nextGroups)
    onChange?.(codes)
  }

  const selectPinned = () => {
    const nextPinnedOnly = !pinnedOnly
    const groupsToUse = activeGroups.length
      ? activeGroups
      : ['全部']
    const codes = selectBatchGroupCodes({
      ...selectionInput,
      pinnedOnly: nextPinnedOnly,
      groups: groupsToUse,
    })
    setPinnedOnly(nextPinnedOnly)
    setActiveGroups(groupsToUse)
    onChange?.(codes)
  }

  const changeDimension = (nextDimension) => {
    setDimension(nextDimension)
    setPinnedOnly(false)
    setActiveGroups([])
    onChange?.([])
  }

  const toggleStock = (code) => {
    const next = new Set(selectedSet)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    setPinnedOnly(false)
    setActiveGroups([])
    onChange?.(stocks
      .map((item) => item.code)
      .filter((itemCode) => next.has(itemCode)))
  }

  return (
    <div className="arp-stock-selector">
      <StockGroupFilter
        compact
        multiSelect
        label="选择股票"
        dimension={dimension}
        onDimensionChange={changeDimension}
        groups={groups}
        active={activeGroups}
        onActiveChange={selectGroups}
        total={stocks.length}
        loading={tagsLoading}
        pinnedOption={scope === 'watch'
          ? {
              active: pinnedOnly,
              count: pinnedCount,
              onChange: selectPinned,
            }
          : null}
      />
      <div
        className="arp-stock-list"
        role="group"
        aria-label={`${scope === 'hold' ? '持仓' : '自选'}持续复核股票`}
      >
        {visibleStocks.map((item) => {
          const selected = selectedSet.has(item.code)
          return (
            <button
              type="button"
              key={item.code}
              className={'arp-stock-item' + (selected ? ' on' : '')}
              aria-pressed={selected}
              onClick={() => toggleStock(item.code)}
            >
              <Icon
                name={selected ? 'checkSquare' : 'square'}
                size={14}
              />
              <span>
                <b>{item.name || item.code}</b>
                <small>{item.code}</small>
              </span>
              {item.star === true && (
                <Icon name="starFill" size={12} />
              )}
            </button>
          )
        })}
        {!visibleStocks.length && (
          <span className="arp-stock-empty">当前筛选下没有股票</span>
        )}
      </div>
    </div>
  )
}
