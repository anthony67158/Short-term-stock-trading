// 军师推理流「实时思考小标题」中文化
// 背景:gpt-5.6-terra 的 reasoning_content 分步小标题由服务方生成、语言锁定为英文,
// 任何 system/prompt 指令都无法改写(实测多次均为英文)。而最终 result.reasoning
// (JSON) 是中文的。为满足「思考过程用中文打印展示」,在后端 emit 前对这些
// 有界的金融/量化领域小标题做「词/短语级」静态翻译,零额外 LLM 调用、零新增延迟,
// 且不触碰任何在线 /predict 打分口径。

// —— 多词短语优先(长匹配),避免被逐词拆散 ——
const PHRASES = [
  ['based on', '基于'],
  ['due to', '因'],
  ['pending account info', '待账户信息'],
  ['pending account', '待账户'],
  ['risk-reward ratios', '盈亏比'],
  ['risk-reward ratio', '盈亏比'],
  ['risk-reward', '盈亏比'],
  ['moving averages', '均线'],
  ['moving average', '均线'],
  ['smart money', '主力资金'],
  ['smartmoney', '主力资金'],
  ['fund signals', '资金信号'],
  ['fund flow', '资金流'],
  ['buy conditions', '买入条件'],
  ['buy condition', '买入条件'],
  ['buy price', '买入价'],
  ['buy-sell timing', '买卖时点'],
  ['buy-stop-target', '买入/止损/目标价'],
  ['buy zone', '买入区间'],
  ['buy plan', '买入计划'],
  ['buy viability', '买入可行性'],
  ['buy entry', '买入入场'],
  ['no-buy', '不买入'],
  ['stop and target', '止损与目标价'],
  ['stop and watch', '止损与观察价'],
  ['stop-target', '止损/目标价'],
  ['target levels', '目标价位'],
  ['target price', '目标价'],
  ['watch price', '观察价'],
  ['stop price', '止损价'],
  ['stop loss', '止损'],
  ['stop rules', '止损规则'],
  ['price range', '价格区间'],
  ['price condition', '价格条件'],
  ['price conditions', '价格条件'],
  ['price data', '价格数据'],
  ['volume metrics', '成交量指标'],
  ['technical indicators', '技术指标'],
  ['technical signals', '技术信号'],
  ['technical bands', '技术通道'],
  ['technical and market indicators', '技术与市场指标'],
  ['market context', '市场环境'],
  ['market environment', '市场环境'],
  ['market signals', '市场信号'],
  ['market indicators', '市场指标'],
  ['macro trends', '宏观趋势'],
  ['sector sentiment', '板块情绪'],
  ['sector outlook', '板块前景'],
  ['entry conditions', '入场条件'],
  ['exit conditions', '离场条件'],
  ['exit condition', '离场条件'],
  ['trade entry', '入场'],
  ['trade parameters', '交易参数'],
  ['trade risk-reward', '交易盈亏比'],
  ['trading conditions', '交易条件'],
  ['trading rules', '交易规则'],
  ['plan quantity', '计划手数'],
  ['plan details', '计划细节'],
  ['plan quantity and key naming', '计划手数与键名'],
  ['purchase quantity', '买入手数'],
  ['purchase plan', '买入计划'],
  ['position and plan', '仓位与计划'],
  ['lot size', '每手股数'],
  ['total assets', '总资产'],
  ['account assumptions', '账户假设'],
  ['account info', '账户信息'],
  ['account data', '账户数据'],
  ['data inconsistencies', '数据不一致'],
  ['data contradictions', '数据矛盾'],
  ['data differences', '数据差异'],
  ['data consistency', '数据一致性'],
  ['data quality', '数据质量'],
  ['fund data', '资金数据'],
  ['null handling', '空值处理'],
  ['language constraints', '语言约束'],
  ['language requirements', '语言要求'],
  ['gate logic', '闸门逻辑'],
  ['gatelogic', '闸门逻辑'],
  ['formatting requirements', '格式要求'],
  ['json output', 'JSON输出'],
  ['asset thresholds', '资产阈值'],
  ['quantity limits', '手数上限'],
  ['confidence level', '置信度档位'],
  ['confidence and buy conditions', '置信度与买入条件'],
  ['confidence and buy', '置信度与买入'],
  ['field values', '字段值'],
  ['field value', '字段值'],
  ['key naming', '键名'],
  ['event signals', '事件信号'],
  ['event signal', '事件信号'],
  ['json keys', 'JSON键'],
  ['json key', 'JSON键'],
  ['json values', 'JSON字段值'],
];

// —— 单词映射 ——
const WORDS = {
  // 动名词(句首动词)
  abandoning: '放弃', adjusting: '调整', analyzing: '分析', applying: '应用',
  assessing: '评估', calculating: '计算', clarifying: '厘清', confirming: '确认',
  deciding: '确定', defining: '界定', determining: '判定', evaluating: '评估',
  finalizing: '敲定', formulating: '制定', identifying: '识别', planning: '规划',
  refining: '优化', resolving: '解决', setting: '设定', summarizing: '汇总',
  verifying: '核验', validating: '校验', recommending: '建议', checking: '检查',
  reviewing: '复核', considering: '权衡', estimating: '估算', comparing: '对比',
  selecting: '选取', observing: '观察', detailing: '细化', revising: '修订',
  revised: '修订后', mapping: '映射', reconciling: '调和', preparing: '准备',
  ensuring: '确保', weighing: '权衡', interpreting: '解读', flagging: '标记',
  deriving: '推导', prioritizing: '排序',
  // 名词/形容词
  plan: '计划', structure: '结构', fails: '失效', fail: '失效', confidence: '置信度',
  buy: '买入', sell: '卖出', conditions: '条件', condition: '条件', price: '价格',
  range: '区间', volume: '成交量', metrics: '指标', metric: '指标', mixed: '混合',
  technical: '技术', indicators: '指标', indicator: '指标', strict: '严格',
  chinese: '中文', tone: '语气', quant: '量化', phrasing: '措辞', pullback: '回调',
  viability: '可行性', stock: '个股', fund: '资金', signals: '信号', signal: '信号',
  ratio: '比率', ratios: '比率', trade: '交易', trading: '交易', quantity: '手数',
  account: '账户', assumptions: '假设', assumption: '假设', position: '仓位',
  details: '细节', detail: '细节', sector: '板块', sentiment: '情绪', neutral: '中性',
  slight: '轻微', negative: '偏空', positive: '偏多', stop: '止损', target: '目标价',
  market: '市场', context: '环境', environment: '环境', entry: '入场', exit: '离场',
  purchase: '买入', near: '接近', zone: '区间', high: '高位', low: '低位',
  default: '默认', without: '缺少', limits: '上限', limit: '上限', minimum: '最小',
  minimal: '最小', watch: '观察', key: '键', keys: '键', naming: '命名',
  parameters: '参数', parameter: '参数', conflicting: '冲突', conflict: '冲突',
  conflicts: '冲突', data: '数据', inconsistencies: '不一致', contradictions: '矛盾',
  differences: '差异', difference: '差异', macro: '宏观', trends: '趋势', trend: '趋势',
  recede: '规避', action: '动作', inadequate: '不足', conditional: '条件式',
  future: '未来', lot: '每手', size: '规模', rules: '规则', rule: '规则', total: '总',
  assets: '资产', asset: '资产', active: '主动', classification: '分类',
  language: '语言', constraints: '约束', constraint: '约束', requirements: '要求',
  requirement: '要求', json: 'JSON', values: '字段值', value: '字段值', zero: '零',
  pending: '待定', info: '信息', consistency: '一致性', null: '空值', handling: '处理',
  accuracy: '准确性', quality: '质量', thresholds: '阈值', threshold: '阈值',
  valuation: '估值', 'valuation-based': '基于估值', reward: '收益', risk: '风险',
  moving: '移动', averages: '均线', average: '均线', flow: '流向', stale: '过期',
  outlook: '前景', cautious: '谨慎', pure: '纯', timing: '时点', output: '输出',
  criteria: '标准', criterion: '标准', bands: '通道', band: '通道',
  vwap: 'VWAP', nasdaq: '纳指', event: '事件', events: '事件', field: '字段',
  fields: '字段', level: '档位', levels: '价位', observation: '观察', watchlist: '自选',
  formatting: '格式', format: '格式', 'medium-low': '中低', 'medium-high': '中高',
  medium: '中等', gate: '闸门', logic: '逻辑', new: '新', no: '无',
  planqty: '计划手数', 'buy-stop-target': '买入/止损/目标价',
  // 连接词/介词
  and: '与', or: '或', to: '至', at: '于', for: '用于', of: '的', on: '基于',
  as: '为', after: '在', with: '含', by: '按', from: '自', in: '于',
  the: '', a: '', an: '',
};

const PLACEHOLDER = ''; // 私有区字符做占位,绝不与正文冲突

function mapWord(raw) {
  const key = raw.toLowerCase().replace(/[.,;:]+$/, '');
  if (WORDS[key] != null) return WORDS[key];
  if (/^\d[\d.,%]*$/.test(key)) return raw;        // 数字/价格原样保留
  return raw;                                       // 未知词:原样保留(优雅降级)
}

function hasHan(s) { return /[一-鿿]/.test(s || ''); }

// 主入口:把一段(可能含 **标题**)英文推理小标题转成中文;已是中文则原样返回
export function zhReasonPiece(text) {
  if (!text) return text;
  if (hasHan(text)) return text;                   // 已是中文(如 phase 文案)不动
  return text.replace(/\*\*([^*]+)\*\*|([^*]+)/g, (m, bold, plain) => {
    const seg = bold != null ? bold : plain;
    if (!seg || !seg.trim()) return m;             // 保留空白/分隔
    const zh = translateSeg(seg);
    return bold != null ? `**${zh}**` : zh;
  });
}

function translateSeg(seg) {
  const orig = seg.trim();
  // 1) 多词短语(长优先)替换为占位符
  const holders = [];
  let work = orig;
  for (const [en, zh] of PHRASES) {
    const re = new RegExp(en.replace(/[-]/g, '\\-').replace(/\s+/g, '\\s+'), 'ig');
    work = work.replace(re, () => {
      holders.push(zh);
      return ` ${PLACEHOLDER}${holders.length - 1}${PLACEHOLDER} `;
    });
  }
  // 2) 逐词映射;两个「未翻译英文词」之间保留空格,避免粘连
  const tokens = work.split(/\s+/).filter((x) => x !== '');
  let out = '';
  let prevLatin = false;
  for (const tok of tokens) {
    const hm = tok.match(new RegExp(`^${PLACEHOLDER}(\\d+)${PLACEHOLDER}$`));
    let piece;
    if (hm) piece = holders[+hm[1]];
    else piece = mapWord(tok);
    if (piece === '') continue;                     // 冠词等被译空,跳过
    const isLatin = /[A-Za-z]/.test(piece) && piece === tok;
    if (out && prevLatin && isLatin) out += ' ';    // 两个英文词间补空格
    out += piece;
    prevLatin = isLatin;
  }
  return out || orig;
}

export default zhReasonPiece;
