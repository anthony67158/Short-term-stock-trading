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

export function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
