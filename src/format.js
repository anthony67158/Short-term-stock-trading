// 格式化工具
export function fmtYi(v) {
  // 元 -> 亿
  const yi = v / 1e8;
  if (Math.abs(yi) >= 100) return yi.toFixed(0);
  if (Math.abs(yi) >= 1) return yi.toFixed(2);
  return (v / 1e4).toFixed(0) + 'w';
}

export function fmtInflow(v) {
  const yi = v / 1e8;
  const s = (yi >= 0 ? '+' : '') + yi.toFixed(2);
  return s + '亿';
}

export function pctClass(v) {
  if (v > 0) return 'red';
  if (v < 0) return 'green';
  return '';
}

export function fmtPct(v) {
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

export function fmtNum(v, d = 2) {
  return Number(v).toFixed(d);
}

// 原样显示价格：接口/用户录入是多少就显示多少，绝不四舍五入。
// 仅去掉浮点误差产生的多余尾数（如 10.2300000001 → 10.23），不改变真实精度。
export function fmtRaw(v) {
  if (v == null || v === '' || isNaN(Number(v))) return '--';
  const n = Number(v);
  // 用足够高精度还原，再去掉尾部多余的 0，保留原始有效位
  let s = n.toPrecision(12);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  // 处理科学计数法回退
  if (s.indexOf('e') >= 0 || s.indexOf('E') >= 0) s = String(n);
  return s;
}

export function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

// 算账/建议字段取值净化：AI 在"持有/观望"时返回 "0"/"0手"/"不变"/"-" 等占位，
// 字符串在 JSX 里是真值会渲染出空的 0 格子(挨一起显示成"00")。hasVal 把这些统一判为无值。
export function hasVal(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s || s === '-' || s === '--' || s === '不变' || s === '无' || s === '/' || s === '无需操作' || s === '不操作') return false;
  // 把“持有0 / 观望0 / 加仓0手 / 减仓0手”等动作前缀去掉后再判断是否为 0
  const num = s
    .replace(/[手股元%,，\s]/g, '')
    .replace(/^(持有|观望|无需操作|不操作|操作|加仓|减仓|买入|卖出|做T|清仓)/, '');
  if (/^0+(\.0+)?$/.test(num)) return false;
  return true;
}

// 操作字段标准化：不能显示“持有0/操作0/资金0”这类含糊值。
// 无动作 => “无需操作”；有动作但只有数字 => 根据 action 补成“加仓X手/减仓X手/做T X手”。
export function opText(v, action = '') {
  if (!hasVal(v)) return '无需操作';
  const raw = String(v).trim();
  if (/^(加仓|减仓|买入|卖出|做T|清仓)/.test(raw)) return raw;
  const n = raw.match(/\d+(?:\.\d+)?/);
  if (!n) return raw;
  const qty = n[0];
  const a = String(action || '');
  if (a.includes('加') || a.includes('买')) return `加仓${qty}手`;
  if (a.includes('减') || a.includes('卖')) return `减仓${qty}手`;
  if (a.includes('清')) return `清仓${qty}手`;
  if (/T/i.test(a)) return `做T ${qty}手`;
  return raw;
}
