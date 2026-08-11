# 实验量化环境

本目录只服务于 `lab` 环境，不能替代或修改现有生产 `quant-score` 服务。

## 环境变量

复制模板后再填写实验 RAM 用户的 AccessKey：

```bash
cp qlib-service/cloud/env.lab.example qlib-service/.env.lab
```

`qlib-service/.env.lab` 已被 `.gitignore` 忽略，不能提交到仓库或发送到聊天中。

## 写入前校验

训练或上传候选模型前，必须运行：

```bash
set -a
. qlib-service/.env.lab
set +a
python3 qlib-service/cloud/isolation_guard.py --check
```

校验只接受：

- `QUANT_ENVIRONMENT=lab`
- 配置中的实验 Bucket `stock-quant-lab-1730034925594178`
- `models/challengers/<run-id>/` 格式的模型前缀

生产 Bucket、空值和生产 `quantmodel/` 前缀都会导致命令失败。校验只读取本地环境变量，不连接 OSS。

## 基线代码包

在项目根目录运行：

```bash
python3 qlib-service/cloud/build_baseline_bundle.py \
  --output qlib-service/quant-lab-baseline.zip
```

生成的 ZIP 使用显式白名单，只包含基线数据构建、36 因子训练、现役参考模型和隔离护栏。
它不包含 `.env`、`upload_model.py`、`retrain_daily.py`、`promote_p1.py` 或部署描述。

当前包不包含训练数据，也不包含 Tushare Token。Token 后续只能通过 PAI 的安全环境变量或密钥
管理能力注入，不能写入 ZIP、代码、OSS 文件或聊天记录。

Tushare 网关固定使用 `https://ts.gyzcloud.top/api`，客户端只允许该公开入口及其已知重定向
主机。默认调用频率为每分钟 90 次，硬上限为 135 次；收到 HTTP 429 后所有并发线程共享暂停
305 秒，匹配网关文档的 5 分钟冷却规则。不要使用包含 Token 的 MCP URL：URL 容易进入浏览器
历史、代理日志和监控日志。

在 DSW 终端中临时注入 Token：

```bash
read -rsp "Tushare Token: " TUSHARE_TOKEN
echo
export TUSHARE_TOKEN
```

命令不会回显 Token，也不会把 Token 本身写入 shell 历史。任务完成后执行：

```bash
unset TUSHARE_TOKEN
```
