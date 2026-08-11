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

function AccuracyPanel({ accuracy }) {
  const days = Array.isArray(accuracy?.days) ? accuracy.days : []
  return (
    <section className="qmc-effect">
      <div className="qmc-section-head">
        <div>
          <b>模型效果数据</b>
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

export default function QuantModelControl() {
  const { open, loading, error, control, accuracy } = useQuantModelStore()
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
            生产环境默认沿用当前模型。切到 V2 后，只有服务运行中才会调用分钟 Transformer；两种模型不会同时给交易结论。
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
                <b>分钟 Transformer V2</b>
                <small>真实 5 分钟序列，预测下一交易日止盈 / 止损 / 超时概率</small>
              </span>
              {selected === 'v2' && <StatusBadge control={control} />}
            </button>
          </div>

          {selected === 'v2' && (
            <section className="qmc-service">
              <div className="qmc-service-copy">
                <b>V2 模型在线服务</b>
                <span>
                  {control?.canControlV2
                    ? '按需启停；停止后不产生 CPU 算力费用，V2 调用会明确提示不可用。'
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
          {error && <div className="qmc-error" role="alert"><Icon name="info" size={13} />{error}</div>}
          {loading && <div className="qmc-loading"><Icon name="refresh" size={13} className="spin" /> 正在同步模型状态…</div>}
        </div>
      </div>
      </div>
    </OverlayPortal>
  )
}
