import { humanizeUserFacingText } from '../../shared/userFacingLanguage.js';

// ============ 自由文本关键信息高亮(HL)============
// 军师 AI 操作建议里,价格/价格区间/百分比/手数/金额/时间点常常藏在整句叙述里
// (如「跌破10.20分时均价再减2手」「9:45 前站回13.50~13.80」),与普通文字同级、
// 一眼扫不出重点。HL 把这些「数值型关键信息」自动加粗+放大,让用户第一眼锁定重点。
//
// 匹配优先级(正则 alternation 有序,靠前者优先):
//   1) 时间点          09:30 / 9:45 / 14:55
//   2) 价格/百分比区间  10.20~10.50 / 13.50-13.80元 / 9.5%~11%(允许 ~ - – 至)
//   3) 货币前缀价格     ¥10.23 / ￥10
//   4) 带单位数值       +3.5% / -2% / 2手 / 500股 / 2000元 / 1.8倍 / 3.2亿 / 50万
//   5) 裸小数(多为价)  10.23(交易语境里裸小数几乎都是价格)
// 用单个「外层捕获组 + 内部全 (?:) 非捕获」保证 split 结果里奇数下标恒为命中片段,
// 从而无状态、无 lastIndex 副作用地稳定切分。
const HL_RE = /(\d{1,2}:\d{2}|[¥￥]?\d+(?:\.\d+)?\s*[~\-–至]\s*[¥￥]?\d+(?:\.\d+)?(?:\s*(?:元|%|手|股))?|[¥￥]\d+(?:\.\d+)?|[+\-]?\d+(?:\.\d+)?\s*(?:元|%|手|股|倍|亿|万)|\d+\.\d+)/g;

// HL：把一段自由文本渲染成「单个内联 <span> 」,命中片段用 <b class="hl-key"> 包裹。
// 传入非字符串/空串时安全返回 null,可直接用于 {cond && <HL text={x} />} 或作为子节点。
//
// 关键:外层必须包一层 <span class="hl">,不能直接返回片段数组。
// 因为很多容器是 display:flex + gap(如 .advice-timing 操作时机行),若返回裸片段数组,
// 每个「文本/<b>」都会成为独立 flex item,gap 被插进每个词/数字之间 —— 句子被拆成
// 锯齿状、逐段换行(窄屏尤甚)。用一层 inline 的 <span> 包住,它在 flex 里只算 1 个
// item(gap 不再插进词间),在普通文本流里 inline 也不改变原有换行行为,一处根治。
export function HL({ text }) {
  if (text == null) return null;
  const s = humanizeUserFacingText(text);
  if (!s) return null;
  const parts = s.split(HL_RE);
  return (
    <span className="hl">
      {parts.map((p, i) =>
        (i % 2 === 1)
          ? <b className="hl-key" key={i}>{p}</b>
          : (p || null)
      )}
    </span>
  );
}

export default HL;
