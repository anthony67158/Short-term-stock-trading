# Free-StockDB v0.3.5 静态研究

> 研究日期：2026-09-09
> 样本：`/tmp/free-stockdb-v0.3.5/package.zip`
> 初始审计仅静态解包；用户随后明确授权在本机运行 macOS ARM64 v0.3.5
> 客户端、同步其自有数据并用于一次性 V3 历史回填。

## 结论

用户已确认该数据由其本人记录、验证并仅供本人使用，因此数据准确性与个人
使用许可不再作为接入阻断项。接入时仍需执行 point-in-time 和字段完整性
校验，避免盘后字段或当前板块成员进入历史盘中样本。

它可以作为 V3 的主要本地批量源，覆盖原始 1 分钟行情、日线、复权因子和自
2019-08-01 起的日资金流；SDK 可由 1 分钟线合成 5 分钟线。以下字段仍需由
现有数据链补齐或通过实际查询验证：

- 历史板块成员是 point-in-time 版本；
- 停牌、ST、上市/退市和涨跌停规则能组成完整的逐日状态；
- 资金流具有可审计的 `available_at`；
- 有带原始链接和精确发布时间的公司公告；
- 2026-08-07 之后的分钟数据仅覆盖少量股票，不能用于全市场历史训练。

因此，当前判定是：**行情/资金流可以进入 V3 历史回放，但必须先通过缺口、
重复、时区、复权和可见时间校验；历史板块和公告仍由项目现有链路补齐。**

## 实际回填结果

macOS ARM64 v0.3.5 已在本机隔离目录完成运行，主历史库和增量库合计约 24 GiB。
服务只监听 `127.0.0.1:7899`。二进制内置授权地址会从 HTTP 302 到 HTTPS，
本次仅通过隔离的 `CURL_HOME/.curlrc` 启用 curl 的合法重定向跟随，没有修改
二进制或伪造授权响应。

HTTP 服务默认返回 MessagePack；批量客户端必须显式追加 `json=1`。实测日线
换手字段为 `turnover`，资金字段为以元计价的 `main_net` 和 `small_net`，
主力占比按 `main_net / amount * 100` 计算。

完整性检查发现 2026-08-07 之后的分钟数据不足以覆盖全市场，最终采用
2026-04-17 至 2026-07-22 的 65 个信号日，并保留至 2026-07-30 的结果路径。
每个信号日从前一交易日可见数据中选取 1,000 只股票，按 10:20、13:40、
15:10 三个时点回放生产扫描器。结果为：

- 195 个历史扫描批次；
- 38,863 条反事实路径，其中 38,862 条成熟、1 条未成熟并排除；
- 与线上 157 条成熟结果合并后得到 39,019 条训练样本；
- 22,010 条完整成交标签、69 个独立交易日；
- 历史训练基线压缩为 7,277,234 字节并发布到 OSS，摘要校验通过。

训练样本数量门槛已经满足，但模型未通过 walk-forward、Top5 命中率和净R
下置信界闸门，因此没有发布 shadow 或 production 模型。线上继续返回
`MODEL_NOT_READY`，不会用不合格模型扩大仓位。

## macOS 可用性

同版本 macOS ARM64 包已确认存在：

```text
https://www.app.workbuddy.link/downloads/free-stockdb-macos-arm64-v0.3.5-more-power.zip
```

- ZIP SHA-256：
  `6263b9d73dd2bb5a37cf3d3d447a51b318af0f244bf8e55054443212c79e7e4a`
- 包含 ARM64 `stockdb.app`、`数据更新.app` 和 universal2 Python 扩展。
- 数据清单包含 666 个对象，预计同步总量约 21.31 GiB；当前磁盘可用空间约
  182 GiB，容量足够。
- 两个 App 和 Python 扩展只有 ad-hoc 签名，Gatekeeper 当前拒绝直接启动。
  包内 `双击修复并启动.command` 会执行 `xattr -cr`、递归加执行权限并重新
  ad-hoc 签名后启动两个 App。

因此无需 Windows，也不需要使用公共远程 MCP。推荐在独立目录运行 macOS
本地服务，完成数据同步后，由本项目通过 `127.0.0.1:7899` 或 Python SDK
执行一次性历史导出。

## 安全检查

- ZIP SHA-256：
  `5f8e08cc27fbab7ac263d1c75a1eb368e96c1758614cee80c3a2bff97c15cbcc`。
- `stockdb.exe` SHA-256：
  `a8df43aa3d14f79b5a99a6f4e826a4efdf227f4a9f9fcad9d60a1b8a73985a90`。
- `数据更新.exe` SHA-256：
  `ee833769e9b2d8765e5919d93c73cb0f5f7732b4971ee31746eb6e733b910fc8`。
- 两个 EXE 均为 Windows x86-64 GUI PE。PE Security Directory 为零，未见
  Authenticode 签名；包内也没有供应商签名或校验清单，所以上述哈希只能标识
  本次样本，不能证明发布者身份。
- `bsdtar` 看到 35 个普通文件，无符号链接、设备文件或越界路径。macOS
  `unzip` 只枚举/测试前三项并以 141 退出，存在 ZIP 兼容性异常。
- 已隔离解包到 `/tmp/free-stockdb-v0.3.5-inspect`，并移除全部普通文件的
  执行位。未执行二进制。

## Windows 启动方式

包内说明给出的本地流程是：

1. 解压到本地目录。
2. 双击 `数据更新.exe`，等待数据同步完成；可重复启动直到完成。
3. 双击 `stockdb.exe`，服务默认监听 `127.0.0.1:7899`。
4. 双击 `数据网页版.html` 查看，或使用 HTTP/Python/MCP 客户端。

定时更新语法为：

```powershell
数据更新.exe -run 15:50:00
```

更新程序的静态帮助还接受 `HHMM`、`HH:MM`、`HHMMSS`、`HH:MM:SS`。服务
PE 内嵌帮助为：

```text
stockdb.exe [-d] /path/to/stockdb.conf [-s start|stop|restart]
```

同时明确写有 native Windows 不支持 `stop`/pidfile 进程控制，应关闭进程或
服务。双击启动依赖同目录默认 `stockdb.conf`。

默认配置：

```ini
work_dir = ./
server:
    port: 7899
    ip: 127.0.0.1
    #auth: this-is-a-very-strong-password-32ch
    #readonly: yes
```

默认只绑定回环地址且认证关闭。若改为局域网监听，应同时启用强密码、只读模式
和主机防火墙；不要把 7899 直接暴露到公网。

## 本地 HTTP API

### 路由和协议

服务使用单一根路由：

```text
GET http://127.0.0.1:7899/?cmd=...&t=...&k1=...&k2=...
```

PE 字符串确认：

- 只声明 `GET` 和 `Access-Control-Allow-Origin: *`；
- 支持 `get`、`vals`、`keys`、`len`、`reload`；
- 可返回 JSON 或 MessagePack；
- 可选认证通过 `token=`，失败返回 `{"error":"noauth"}`；
- 其他命令返回 `only get/vals/keys/len/reload commands supported`。

包内 HTML 客户端统一追加 `json=1`。已证实的参数有：

| 参数 | 含义 |
|---|---|
| `cmd` | `get` 原值/键值对、`vals` 仅值、`keys` 仅完整键、`len` 计数、`reload` 重载 |
| `t` | 表名，如 `日k`、`分钟k`、`复权`、`资金流` |
| `k1`、`k2` | 分层键查询；常见为代码和日期 |
| `num` | 服务端截取；示例 `-100` 表示最近 100 条 |
| `json=1` | 强制 JSON 响应 |
| `token` | 配置 `server.auth` 后的 HTTP 认证值 |

查询表达式：

| 表达式 | 含义 |
|---|---|
| `key:600633` | 精确层键 |
| `all:` | 当前层全部 |
| `fwd:20260620,20260626` | 正序闭区间 |
| `*` / `202606*` / `6*` | 整层、日期前缀、代码前缀 |

SDK 的简写中，`20260620<20260626` 为正序，`20260620>20260626` 为反序，
`N` 表示开放端点。SDK 可用 `.url()` 输出最终 URL，复杂查询应以它生成的 URL
为准，不应自行猜测参数。

示例：

```text
/?cmd=get&t=日k:600702:20260623
/?cmd=vals&t=日k&k1=key:600633&k2=fwd:20260620,20260626
```

### 本地表和字段

本地 K-V 主键：

```text
日k:code:YYYYMMDD
分钟k:code:YYYYMMDDhhmmss
复权:code:YYYYMMDD
资金流:code:YYYYMMDD
```

日线示例字段：

```text
date,code,name,open,high,low,close,pre_close,volume,amount,
turnover,pct_chg,amplitude,is_st,vol_ratio,total_share,float_share,
total_mv,float_mv,pe_ttm,pb
```

原始分钟线示例字段：

```text
date,code,open,high,low,close,volume,amount
```

官方第一方 API 目录对本地资金流表给出的范围是 **2019-08-01 至今**、盘后
更新，字段为：

```text
code,date,main_net,jumbo_net,big_net,mid_net,small_net,
main_in,main_out,retail_in,retail_out
```

金额单位为元。记录没有 `available_at`。

### 时间范围和周期

- 第一方目录声称本地 `rd.get_data()` 为 2005 年至今，盘后 15:30 更新。
- 日期可用 8 位 `YYYYMMDD`；分钟键为 14 位 `YYYYMMDDhhmmss`。
- `start=None,end=None` 查询全量；分钟整日查询需把同一 8 位日期同时传给
  `start` 和 `end`，SDK会补成 `000000` 至 `235959`。
- 支持 `1d`、`1m`、`5m`、`15m`、`30m`、`60m`、`1w`、`1M`。
- **本地实际存储的是 1 分钟线**。`5m/15m/30m/60m` 由
  `stock_sdk.py::_merge_minutes_to_period()` 按 A 股上午/下午交易分钟聚合；
  周/月线也由客户端聚合。

分钟聚合输出 `date,code,name,open,high,low,close,volume,amount,pre_close,
pct_chg,amplitude`，并可能复制 `vol_ratio/pe_ttm/pb/市值/is_st`。代码未检查
每个 5 分钟桶必须恰有 5 根，也未拒绝缺分钟桶，所以 V3 必须另做完整性校验。

### 复权

`rd.get_data()` 默认 `fq="qfq"`，支持：

- `qfq`：前复权；
- `hfq`：后复权；
- `None`：不复权。

复权不是 HTTP 服务端直接生成，而是 SDK 启动时读取全量“复权”表，在内存中
按累计因子折算 OHLC/`pre_close`。前复权使用**当前因子表最后一个因子**作为
基准，因此会随未来除权事件变化，不是 point-in-time 固定序列。包内网页还明确
提到为规避“数据库二次复权 Bug”而额外拉前一交易日并覆盖 `pre_close`。

V3 执行结算必须使用 `fq=None` 的原始价；技术特征应自行保存信号时点可见的
因子版本和原始价映射，不能直接把默认 `qfq` 当作可回放真值。

## MCP

### 配置

包内 MCP 是 Python stdio 服务，配置示例：

```json
{
  "mcpServers": {
    "stockdb-native": {
      "command": "python",
      "args": [
        "-u",
        "C:/absolute/path/stockdb/调用方式/ai_mcp/stockdb_full_mcp.py"
      ]
    }
  }
}
```

前提是：

- `stockdb.exe` 已启动并监听 7899；
- Python 可从 PATH 启动；
- 包内 `pybao/安装.py` 已把 `pybao` 写入用户 `site-packages/*.pth`。

`安装.py` 会永久修改 Python 搜索路径；更稳妥的评估方式是隔离虚拟机/虚拟
环境并显式设置 `PYTHONPATH`。MCP 依赖闭源 Windows `.pyd`，不是纯 Python
方案；`native_mcp.py` 只是 stdio JSON-RPC/MCP 实现。

### 工具

该版本注册 **41 个工具**，没有 MCP resource 或 prompt：

```text
stockdb_get_industry
stockdb_get_data
stockdb_get_all_securities
stockdb_get_security_info
stockdb_get_trade_days
stockdb_get_money_flow
stockdb_get_ticks
stockdb_get_last_tick
stockdb_get_bars
stockdb_get_price
stockdb_get_marginsec_stocks
stockdb_get_margincash_stocks
stockdb_get_mtss
stockdb_get_extras
stockdb_get_call_auction
stockdb_get_billboard_list
stockdb_bk_get
stockdb_get_fundamentals_valuation_legacy
stockdb_get_fundamentals_income_legacy
stockdb_get_fundamentals_continuously
stockdb_get_fundamentals_generic_legacy
stockdb_get_fundamentals_cash_flow_legacy
stockdb_get_history_fundamentals
stockdb_get_valuation
stockdb_get_fundamentals_indicator_legacy
stockdb_get_fundamentals
stockdb_get_locked_shares
stockdb_get_future_contracts
stockdb_get_dominant_future
stockdb_get_index_weights
stockdb_get_index_stocks
stockdb_get_all_alpha_101
stockdb_get_all_alpha_191
stockdb_alpha
stockdb_get_factor_kanban_values
stockdb_MACD
stockdb_get_factor_values
stockdb_get_factor_values_legacy
stockdb_get_index_style_exposure
stockdb_list_query_tables
stockdb_run_query
```

重要边界：

- `stockdb_get_data` 走本地 `rd`。
- 资金流工具 `stockdb_get_money_flow` 走在线代理；本地资金流应直接查询
  `rd.get("资金流", ...)`，但 MCP 没有暴露通用本地 `rd.get` 工具。
- `stockdb_bk_get` 读取本地当前板块快照，没有日期参数。
- `stockdb_get_industry(date=...)`、`stockdb_get_index_stocks(date=...)` 等走
  在线代理。
- `stockdb_get_industry(date=...)` 只是“股票在该日期所属行业”，不能导出
  带生效区间的全量板块成员历史；`stockdb_get_index_stocks(date=...)` 是指数
  成分，不是概念/行业板块成员。源码中的旧
  `_legacy_stockdb_get_industry_stocks(industry_code, date)` 既未注册为 MCP
  工具，函数体也完全忽略 `date`，只查询当前 `bk` 快照。故“历史板块按 date
  查询”在该 MCP 中并未真正实现。
- `stockdb_get_bars` 的签名声称支持列表和 `skip_paused`，实现却只取列表第一
  个代码，且明确不把 `skip_paused` 传给底层。不能仅按 docstring 认定行为。
- `stockdb_run_query` 只允许白名单中的 `bond`、`finance`、`opt` 表。

## 授权、联网和数据来源

### 明确依赖

- 初次/增量同步依赖 `sync_url.txt` 中的
  `https://ah.123128.xyz` 和 `https://ad.123128.xyz always`；本次 HEAD 请求
  均在 20 秒超时，未验证可用性。
- 更新程序静态字符串显示它会读取同步清单、下载数据并调用本地
  `/?cmd=reload&t=...`。
- `stockdb.exe` 内嵌 `https://a.123128.xyz/version?v=` 和站点根 URL，说明
  启动时至少可能做版本/在线检查；因未执行，无法确认触发条件。
- 在线 API 由闭源 `.pyd` 的 `RemoteProxy` 提供，需联网；静态字符串包含
  `XStockSign`、HWID 文件、`pro_api_token` 和认证错误。
- 包内混淆 JS 有设备指纹、远程授权校验和 `__pxLicense` guard；授权失败会阻止
  API 使用。

第一方首页明确说明：公共无鉴权服务器仅供测试，连续批量拉取会触发风控并
返回随机 mock 数据。包内 `sdk_test.py` 进一步警告，远程暴力拉取 5 分钟数据
可能导致设备永久封禁。因此远程体验端点绝不能用于训练或质量验收。

### 未解决风险

- 包内没有 LICENSE/EULA、数据授权范围、原始供应商清单、字段血缘或修订政策。
- 35 个压缩包条目中没有签名文件、SBOM、许可证或安全说明；核心服务、同步器
  和 Python 扩展均为不可审计的本机代码。
- 第一方目录的“来源”仅写 `接口目录.json`；除申万分类及个别交易所字段说明
  外，不能追溯行情、资金流、概念成员和公告到原始供应商。
- 第一方首页截至 2026-09-04 仍把 v0.3.2 标为最新，而样本 PE 自报
  `0.3.5-stockdb` 且时间戳为 2026-09-08，版本发布信息不一致。
- 包内 PE 无发布者签名。若后续必须验证，应在无生产凭证、无共享盘、限制出站
  的 Windows 沙箱中进行，并先向提供方取得正式校验值和许可文本。
- 包内文档与第一方网页对 `<`/`>` 的范围排序方向存在相反描述；批量回填不能
  依赖隐式顺序，必须按返回记录的时间字段重排并检测边界、重复和缺口。

## V3 适配矩阵

| V3 数据 | 包中能力 | 判定 |
|---|---|---|
| 5 分钟 OHLCV | 本地 1 分钟表可合成 5 分钟；字段含 OHLC、量、额 | **条件可用**。必须用 `fq=None`，自行校验每桶、午休、重复键、缺口、时区及 800 股覆盖；不能使用远程体验端 |
| 日线 | 本地 `日k`，声称 2005 至今；含 OHLC、量额、换手、量比、ST、市值 | **条件可用**。缺少本地样本实测；本地示例无 `limit_up/limit_down` |
| 资金流 | 本地 `资金流` 自 2019-08-01；主力/超大/大/中/小单及流入流出额 | **条件可用**。只有盘后更新且无 `available_at`，盘中回放应至少滞后到下一交易日 |
| 历史板块成员 | `bk` 只有当前 `symbols` 快照，无 `effective_from/to`；在线仅部分接口接收日期 | **不满足**。不能用当前成员回填历史；概念历史成员尤其缺失 |
| 停牌 | 本地 SDK 注释称停牌日通常不写记录；在线 `get_price/get_bars` 有 `paused` | **不完整**。缺记录不等于可审计停牌状态，且 MCP 的 `get_bars` 不传 `skip_paused` |
| 历史 ST | 本地日线有 `is_st`；在线 `get_extras("is_st")` 声称 2005 至今 | **候选可用**。需与历史简称区间交叉校验，不能只看当前名称 |
| 上市/退市 | 在线 `get_all_securities(date)`、`finance.STK_LIST`、`STK_STATUS_CHANGE` | **候选可用但联网**。需验证退市样本完整性和首次可见时间 |
| 涨跌停规则/价格 | 在线行情字段有 `high_limit/low_limit`，本地日线示例没有 | **不满足本地闭环**。还缺按板块/ST/制度变更的 `limit_rule` |
| 公告时间 | 财务表有若干 `pub_date`；`STK_REPORT_DISCLOSURE` 只是定期报告预约披露表 | **不满足**。没有通用公告标题、类型、精确 `published_at` 和交易所原始链接 |
| 盘中 10:20/13:40 截面 | 可从原始分钟线累计计算 price/high/low/量/额/VWAP | **可派生**，但必须只使用截面时刻以前的分钟数据 |

## 实际接入约束

1. macOS 数据库存放于项目外的一次性目录，只监听 `127.0.0.1:7899`。
2. HTTP 适配器只允许 `get/vals` 和 `日k`、`分钟k`、`资金流`、`股票代码`
   四张表，拒绝外部主机、写命令和任意查询表达式。
3. 先验证日线、分钟、资金单位、缺口、重复、交易时区和样本覆盖，再执行完整
   历史回放。
4. 回放不使用当前板块成员填充历史；历史板块和公告缺项由项目现有链路补齐。
5. 原始数据不上传 OSS。仅成熟反事实样本以 gzip、SHA-256 和版本化对象保存，
   供后续定时训练复用。
6. 训练、受控晋级和线上验收结束后，删除本机 StockDB、分钟中间文件、训练集
   和临时模型。

## 来源

### 包内一手材料

- `stockdb/先看！这个！！使用说明.txt`：Windows 启动、更新与定时参数。
- `stockdb/stockdb.conf`：监听地址、端口、认证和只读配置。
- `stockdb/sync_url.txt`：同步源。
- `stockdb/调用方式/http/http_api.py`、`rd_test.py`：HTTP 路由、查询表达式和
  日/分钟字段示例。
- `stockdb/pybao/stock_sdk.py`：本地查询、分钟聚合和复权实际实现。
- `stockdb/pybao/zhibiao.py`：当前板块索引结构。
- `stockdb/调用方式/ai_mcp/README.md`、`stockdb_full_mcp.py`：MCP 配置、
  工具清单和在线代理边界。
- `stockdb/调用方式/python/AI策略python开发接口文档.md`：SDK 参数和返回结构。
- `stockdb.exe`、`数据更新.exe`：仅通过 `file`、`objdump`、`strings` 静态检查。

### 第一方网页

- [Free-StockDB 首页](https://a.123128.xyz/)：版本公告、本地资金流公告、公共
  体验服务器 mock 风险。
- [官方 API 浏览器](https://a.123128.xyz/docs/index.html)：接口范围、字段、
  时间范围和更新频率。
- [官方 30 秒开始](https://www.app.workbuddy.link/tabs/start.html)：本地与
  在线启动方式。
- [官方 Python 接入说明](https://www.app.workbuddy.link/tabs/ai-py.html)：
  本地/在线边界、批量能力与目录职责。

### 项目验收口径

- `docs/v3-opportunity-history-data.md`：V3 最小时间/股票范围、字段、
  point-in-time、复权和公告要求。
