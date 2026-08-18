import { useEffect } from 'react'
import Icon from './Icon'
import OverlayPortal from './OverlayPortal'
import {
  quantModelStore,
  useQuantModelStore,
} from '../quantModelStore'

function StatusBadge({ control }) {
  if (!control) return <span className="qmc-status muted">读取中</span>
  if (control.selected === 'default') {
    return <span className="qmc-status ready">直接可用</span>
  }
  if (control.v2Starting) {
    return <span className="qmc-status pending">服务启动中</span>
  }
  if (control.v2Stopping) {
    return <span className="qmc-status pending">服务停止中</span>
  }
  return (
    <span className={'qmc-status ' + (control.v2Enabled ? 'ready' : 'off')}>
      {control.v2Enabled ? '服务运行中' : '服务已停止'}
    </span>
  )
}

function ProductionAccuracyPanel({
  productionAccuracy,
  productionModel,
  loading,
}) {
  const days = productionAccuracy && Array.isArray(productionAccuracy.days)
    ? productionAccuracy.days
    : []
  const hasSamples = Number(productionAccuracy?.overall?.total) > 0
  const strong = productionAccuracy?.strongSignals || {}
  const nextDirection = productionAccuracy?.nextTradeDayDirection || {}
  const nextRange = productionAccuracy?.nextTradeDayRange || {}
  return (
    <section className="qmc-effect qmc-production-metrics">
      <div className="qmc-section-head">
        <div>
          <b>生产模型实际回测</b>
          <span>只统计训练截止日后、已完成未来5日标签的前向样本</span>
        </div>
        {hasSamples && (
          <strong>
            {productionAccuracy.overall.accuracyPct}%
          </strong>
        )}
      </div>
      {hasSamples ? (
        <>
          <div className="qmc-days">
            <div className="qmc-day">
              <span>5日目标命中</span>
              <b>{productionAccuracy.overall.accuracyPct}%</b>
              <small>
                {productionAccuracy.overall.correct}/
                {productionAccuracy.overall.total} 正确
              </small>
            </div>
            <div className="qmc-day">
              <span>次日方向</span>
              <b>
                {productionAccuracy.nextTradeDayDirection?.accuracyPct != null
                  ? `${productionAccuracy.nextTradeDayDirection.accuracyPct}%`
                  : '—'}
              </b>
              <small>{nextDirection.correct || 0}/{nextDirection.total || 0} 正确</small>
            </div>
            <div className="qmc-day">
              <span>次日区间覆盖</span>
              <b>
                {productionAccuracy.nextTradeDayRange?.coveragePct != null
                  ? `${productionAccuracy.nextTradeDayRange.coveragePct}%`
                  : '—'}
              </b>
              <small>
                {nextRange.covered || 0}/{nextRange.total || 0} 落入 P10–P90
              </small>
            </div>
          </div>
          <div className="qmc-days qmc-days-spaced qmc-secondary-metrics">
            <div className="qmc-day">
              <span>平衡准确率</span>
              <b>
                {productionAccuracy.overall.balancedAccuracyPct != null
                  ? `${productionAccuracy.overall.balancedAccuracyPct}%`
                  : '—'}
              </b>
              <small>同时平衡达标与未达标样本</small>
            </div>
            <div className="qmc-day">
              <span>强信号命中</span>
              <b>
                {strong.accuracyPct != null
                  ? `${strong.accuracyPct}%`
                  : '—'}
              </b>
              <small>
                {strong.correct || 0}/{strong.total || 0} 正确
                {strong.coveragePct != null
                  ? ` · 覆盖 ${strong.coveragePct}%`
                  : ''}
              </small>
            </div>
          </div>
          {days.length > 0 && (
            <div className="qmc-days qmc-days-spaced">
              {days.slice(0, 6).map((day) => (
                <div className="qmc-day" key={day.date}>
                  <span>{day.date}</span>
                  <b>{day.accuracyPct}%</b>
                  <small>{day.correct}/{day.total} 正确</small>
                </div>
              ))}
            </div>
          )}
          <div className="qmc-backtest-meta">
            <span>
              回测窗口 {productionAccuracy.sampleWindow?.from || '—'}
              {' 至 '}
              {productionAccuracy.sampleWindow?.to || '—'}
            </span>
            <span>
              {productionAccuracy.sampleWindow?.tradingDates || 0} 个成熟交易日
            </span>
            <span>
              训练截止 {productionAccuracy.model?.dataEndDate || '—'}
            </span>
          </div>
          <div className="qmc-metric-note">
            AUC仅衡量排序能力，不计入上述实际命中率
            {productionModel?.holdoutAucPct != null
              ? `；当前样本外 AUC ${productionModel.holdoutAucPct.toFixed(2)}%`
              : ''}
          </div>
        </>
      ) : (
        <div className="qmc-empty">
          <Icon name="gauge" size={18} />
          <div>
            <b>{loading ? '正在读取实际回测' : '前向样本积累中'}</b>
            <span>每日重训会回测当前冠军训练截止日之后的成熟样本，并自动更新这里。</span>
          </div>
        </div>
      )}
    </section>
  )
}

function AccuracyPanel({ accuracy }) {
  const days = Array.isArray(accuracy?.days) ? accuracy.days : []
  return (
    <section className="qmc-effect">
      <div className="qmc-section-head">
        <div>
          <b>V2 日终效果数据</b>
          <span>按信号日统计下一交易日三重障碍分类正确率</span>
        </div>
        {accuracy?.overall?.total > 0 && (
          <strong>{accuracy.overall.accuracyPct}%</strong>
        )}
      </div>
      {days.length ? (
        <div className="qmc-days">
          {days.map((day) => (
            <div className="qmc-day" key={day.date}>
              <span>{day.date}</span>
              <b>{day.accuracyPct}%</b>
              <small>{day.correct}/{day.total} 正确</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="qmc-empty">
          <Icon name="gauge" size={18} />
          <div>
            <b>效果样本积累中</b>
            <span>V2 产生预测并走完下一交易日后，这里会自动按日展示正确率。</span>
          </div>
        </div>
      )}
    </section>
  )
}

function V21AccuracyPanel({ accuracy }) {
  const heads = accuracy?.heads || {}
  const sessions = accuracy?.sessions || {}
  const hasSamples = Number(accuracy?.total) > 0
  const sessionLabels = {
    morning: '早盘',
    noon: '午间',
    afternoon: '午后',
  }
  return (
    <section className="qmc-effect">
      <div className="qmc-section-head">
        <div>
          <b>V2.1 盘中双头效果</b>
          <span>未来30分钟与截至收盘分别结算，不与V2日终正确率混用</span>
        </div>
        {heads.next30m?.accuracyPct != null && (
          <strong>{heads.next30m.accuracyPct}%</strong>
        )}
      </div>
      {hasSamples ? (
        <>
          <div className="qmc-days">
            <div className="qmc-day">
              <span>未来30分钟</span>
              <b>{heads.next30m?.accuracyPct ?? '—'}%</b>
              <small>{heads.next30m?.correct || 0}/{heads.next30m?.total || 0} 正确</small>
            </div>
            <div className="qmc-day">
              <span>截至收盘</span>
              <b>{heads.sessionClose?.accuracyPct ?? '—'}%</b>
              <small>{heads.sessionClose?.correct || 0}/{heads.sessionClose?.total || 0} 正确</small>
            </div>
          </div>
          <div className="qmc-days qmc-days-spaced">
            {Object.entries(sessionLabels).map(([key, label]) => sessions[key] && (
              <div className="qmc-day" key={key}>
                <span>{label}</span>
                <b>{sessions[key].heads?.next30m?.accuracyPct ?? '—'}%</b>
                <small>30分钟 · 收盘 {sessions[key].heads?.sessionClose?.accuracyPct ?? '—'}%</small>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="qmc-empty">
          <Icon name="activity" size={18} />
          <div>
            <b>V2.1 样本尚未结算</b>
            <span>盘中预测产生后，30分钟路径和当日收盘路径会分别结算。</span>
          </div>
        </div>
      )}
    </section>
  )
}

export default function QuantModelControl() {
  const {
    open,
    loading,
    error,
    control,
    productionModel,
    productionAccuracy,
    accuracy,
    v21Accuracy,
  } = useQuantModelStore()
  useEffect(() => {
    if (open && !control && !loading) quantModelStore.refresh()
  }, [open, control, loading])
  if (!open) return null

  const selected = control?.selected || 'default'
  return (
    <OverlayPortal>
      <div className="modal-mask qmc-mask" onClick={() => quantModelStore.close()}>
      <div
        className="qmc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="量化模型配置"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-bar qmc-header">
          <div className="modal-title"><Icon name="activity" size={18} /> 量化模型配置</div>
          <button className="modal-close" aria-label="关闭" onClick={() => quantModelStore.close()}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="qmc-body">
          <div className="qmc-note">
            默认沿用当前生产模型。V2.0 与 V2.1 由你手动选择、不会混用；V2.1 未达生产门槛，界面和军师会持续标记为实验模型。
          </div>

          <div className="qmc-options" role="radiogroup" aria-label="模型版本">
            <button
              role="radio"
              aria-checked={selected === 'default'}
              className={'qmc-option' + (selected === 'default' ? ' selected' : '')}
              disabled={loading}
              onClick={() => quantModelStore.select('default')}
            >
              <span className="qmc-radio" />
              <span className="qmc-copy">
                <b>当前生产模型</b>
                <small>日线 36 因子 LightGBM + GARCH，保持现有线上口径</small>
              </span>
              {selected === 'default' && <StatusBadge control={control} />}
            </button>
            <button
              role="radio"
              aria-checked={selected === 'v2'}
              className={'qmc-option' + (selected === 'v2' ? ' selected' : '')}
              disabled={loading}
              onClick={() => quantModelStore.select('v2')}
            >
              <span className="qmc-radio" />
              <span className="qmc-copy">
                <b>分钟 Transformer V2.0</b>
                <small>稳定日终模型，始终基于15:00完整分钟序列预测下一交易时段</small>
              </span>
              {selected === 'v2' && <StatusBadge control={control} />}
            </button>
            <button
              role="radio"
              aria-checked={selected === 'v2.1'}
              className={
                'qmc-option experimental'
                + (selected === 'v2.1' ? ' selected' : '')
              }
              disabled={loading}
              onClick={() => quantModelStore.select('v2.1')}
            >
              <span className="qmc-radio" />
              <span className="qmc-copy">
                <b>分钟 Transformer V2.1 <em>实验</em></b>
                <small>盘中双头：未来30分钟 / 截至收盘；离线平衡准确率53.92% / 54.58%，未达58%门槛</small>
              </span>
              {selected === 'v2.1' && <StatusBadge control={control} />}
            </button>
          </div>

          <ProductionAccuracyPanel
            productionAccuracy={productionAccuracy}
            productionModel={productionModel}
            loading={loading}
          />

          {selected !== 'default' && (
            <section className="qmc-service">
              <div className="qmc-service-copy">
                <b>V2.0 / V2.1 共用在线服务</b>
                <span>
                  {control?.canControlV2
                    ? '按需启停；服务同时保留两个检查点，实际调用严格服从上方手动选择。'
                    : '当前账号只能选择模型，在线服务启停由授权账号管理。'}
                </span>
              </div>
              <button
                type="button"
                className={
                  'qmc-switch'
                  + (control?.v2Enabled ? ' on' : '')
                  + (control?.v2Transitioning ? ' pending' : '')
                }
                role="switch"
                aria-checked={!!control?.v2Enabled}
                disabled={
                  loading
                  || control?.v2Transitioning
                  || !control?.canControlV2
                }
                onClick={() => {
                  if (control?.canControlV2) {
                    quantModelStore.setV2Enabled(!control?.v2Enabled)
                  }
                }}
              >
                <span />
                {control?.v2Starting
                  ? '启动中'
                  : control?.v2Stopping
                    ? '停止中'
                    : control?.v2Enabled
                      ? '已开启'
                      : '已停止'}
              </button>
              {control?.v2Transitioning && (
                <div className="qmc-transition" role="status">
                  <Icon name="refresh" size={12} className="spin" />
                  {control.v2Starting
                    ? '启动通常需要 3～6 分钟，状态会自动刷新，可先关闭弹窗。'
                    : '服务正在停止，状态会自动刷新。'}
                </div>
              )}
            </section>
          )}

          <AccuracyPanel accuracy={accuracy} />
          <V21AccuracyPanel accuracy={v21Accuracy} />
          {error && <div className="qmc-error" role="alert"><Icon name="info" size={13} />{error}</div>}
          {loading && <div className="qmc-loading"><Icon name="refresh" size={13} className="spin" /> 正在同步模型状态…</div>}
        </div>
      </div>
      </div>
    </OverlayPortal>
  )
}
