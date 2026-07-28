import { Component } from 'react'

// 轻量错误边界：某个子模块渲染崩溃时，不拖垮整页，显示可重试的占位
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) { /* 可上报；此处静默 */ }
  reset = () => this.setState({ err: null })
  render() {
    if (this.state.err) {
      return (
        <div className="panel" style={{ padding: 20 }}>
          <div className="empty">
            {this.props.label || '该模块'}加载出错了。
            <button className="btn" style={{ marginLeft: 10 }} onClick={this.reset}>重试</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
