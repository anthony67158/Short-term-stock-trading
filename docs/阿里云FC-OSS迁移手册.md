# 阿里云 FC 3.0 + OSS 迁移与部署手册

本项目已从 Vercel 改造为 **阿里云函数计算 FC 3.0（承载前端 + 12 个 API）+ OSS（替代 Vercel Blob 存数据）**。
大模型 API 不变，仍用原来的 `LLM_BASE_URL` / `LLM_API_KEY`。

---

## 一、代码改了什么（已完成）

| 变更 | 文件 |
|---|---|
| 新增 OSS 存储抽象层（对齐 @vercel/blob 的 put/list/del/readJson） | `api/_blob.js` |
| 4 个用 Blob 的文件改为走 OSS，**key 前缀原样保留** | `api/account.js`、`api/_sector_snapshots.js`、`api/_daily_summary.js`、`api/daily_report.js` |
| FC 自定义运行时入口：一个进程同时托管前端 dist/ + /api/*（含 SSE 流式） | `server.js` |
| Serverless Devs 部署描述 | `s.yaml` |
| 数据迁移脚本 Blob → OSS | `scripts/migrate-blob-to-oss.mjs` |
| 依赖新增 `ali-oss`；脚本新增 `start` / `migrate:oss` | `package.json` |
| 环境变量模板 | `.env.oss.example` |

存储 key 前缀不变（`accounts/`、`sectorflow/`、`dailyreport/`），所以数据迁过去后代码能直接读到。

---

## 二、你需要开通的阿里云服务

1. **对象存储 OSS**：建一个 Bucket（如 `stock-dashboard-data`），地域就近（如华东1-杭州 `oss-cn-hangzhou`）。用于存账号/快照/日报数据。读写权限**私有**即可（代码用 AK 直连读写；若走公网 URL 读取才需公共读，本项目已改为 SDK 直读，保持私有更安全）。
2. **函数计算 FC 3.0**：承载前端 + API。
3. **RAM 用户 + AccessKey**：给 FC/迁移脚本用。授权 `AliyunOSSFullAccess`（或最小化到该桶）。
4.（可选）**CDN + 域名 + 免费 DV 证书**：加速 + HTTPS。不绑也能用 FC 自带的 HTTP 触发器地址。

---

## 三、操作步骤

### 步骤 0：准备本机工具
```bash
npm i -g @serverless-devs/s        # Serverless Devs CLI
s config add                       # 按提示填阿里云 AK/SK，别名用 default
```

### 步骤 1：先迁数据（务必在切流量前做，保证不丢）
```bash
cd stock-dashboard
npm install                        # 确保 @vercel/blob 和 ali-oss 都在

# 先干跑看清单（不写入）
DRY_RUN=1 BLOB_READ_WRITE_TOKEN=你的Vercel令牌 \
OSS_REGION=oss-cn-hangzhou OSS_BUCKET=你的桶 \
OSS_ACCESS_KEY_ID=xxx OSS_ACCESS_KEY_SECRET=xxx \
node scripts/migrate-blob-to-oss.mjs

# 确认无误后真正迁移（去掉 DRY_RUN）
BLOB_READ_WRITE_TOKEN=你的Vercel令牌 \
OSS_REGION=oss-cn-hangzhou OSS_BUCKET=你的桶 \
OSS_ACCESS_KEY_ID=xxx OSS_ACCESS_KEY_SECRET=xxx \
node scripts/migrate-blob-to-oss.mjs
```
输出会显示三个前缀各迁了多少个对象、成功/失败数。

> Vercel Blob 令牌在 Vercel 项目 → Storage → Blob → `.env.local` 里的 `BLOB_READ_WRITE_TOKEN`。

### 步骤 2：构建前端
```bash
npm run build      # 产出 dist/
```

### 步骤 3：配置并部署 FC
1. 编辑 `s.yaml` 顶部 `vars.region` 为你的地域。
2. 在部署环境里导出所有环境变量（见 `.env.oss.example`），`s.yaml` 用 `${env.XXX}` 读取。
   最简单：把它们写进 shell 后再部署：
   ```bash
   set -a; source .env; set +a       # 你的 .env 参照 .env.oss.example 填好
   s deploy
   ```
3. 部署成功后，`s deploy` 会输出 HTTP 触发器地址（形如
   `https://<random>.<region>.fcapp.run` 或 `https://<account>.<region>.fc.aliyuncs.com/...`）。

### 步骤 4：验证
```bash
# 健康检查
curl -i https://<你的FC地址>/__health          # 期望 200 ok
# 首页
curl -i https://<你的FC地址>/                   # 期望 200 text/html
# 任一 API（板块）
curl -i "https://<你的FC地址>/api/sectors?type=industry&sort=main"   # 期望 200 JSON
# 账号读（迁移后应能读到旧账号）
curl -sX POST https://<你的FC地址>/api/account -H 'Content-Type: application/json' \
  -d '{"action":"login","nick":"你的昵称","pw":"你的密码"}'
```
账号能登录且看到历史持仓/计划 = 数据迁移成功。

### 步骤 5（可选）：绑 CDN + 自定义域名 + HTTPS
- CDN 源站指向 FC 触发器域名；申请免费 DV 证书绑到你的域名；开启强制 HTTPS。
- 若前端静态资源改由 OSS+CDN 直出（进一步省 FC 费用），把 `dist/` 上传到一个开启「静态网站托管」的 OSS 桶，CDN 分两路：`/api/*` 回源 FC、其余回源 OSS。当前 `server.js` 已能一体托管，此步为优化项，非必需。

---

## 四、环境变量清单（FC 控制台 / s.yaml）

大模型：`LLM_BASE_URL` `LLM_API_KEY` `LLM_MODEL` `ADVISOR_MODEL` `AGENT_MODEL` `DAILY_MODEL`
数据源：`FINNHUB_KEY` `QUANT_URL` `QUANT_KEY`
OSS：`OSS_REGION` `OSS_BUCKET` `OSS_ACCESS_KEY_ID` `OSS_ACCESS_KEY_SECRET`（可选 `OSS_ENDPOINT` `OSS_PUBLIC_BASE`）

> `BLOB_READ_WRITE_TOKEN` 只在迁移脚本用，**FC 运行时不需要**。

---

## 五、成本预估（去掉模型费用后）

- FC：按量付费，个人自用调用量小，约 **¥5–20/月**（含少量免费额度）。
- OSS：标准存储 ¥0.12/GB/月，数据量极小 → **≈¥1/月**。
- CDN：用量小，几元/月；不绑可省。
- 域名（可选）：¥60–90/年。

合计约 **¥5–25/月** + 可选域名。

---

## 六、注意

- FC 与 OSS 建议**同地域**，并配 `OSS_ENDPOINT` 内网地址，读写走内网免流量费更快。
- 迁移脚本**幂等**，可重复跑；`DRY_RUN=1` 只列不写。
- 切到阿里云并验证无误后，Vercel 项目可暂停/删除。**记得轮换所有暴露过的令牌**（Vercel Token、Blob Token、GitHub PAT）。
