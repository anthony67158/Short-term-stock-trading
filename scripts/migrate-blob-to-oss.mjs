// ============ 数据迁移：Vercel Blob → 阿里云 OSS ============
// 把线上已存的三类数据整体搬到 OSS，keys 原样保留，确保迁移后代码能读到旧数据：
//   accounts/     账号 + 同步数据
//   sectorflow/   板块资金分时快照
//   dailyreport/  每日策略日报缓存
//
// 用法（本地 Node 18+ 执行一次即可）：
//   1) npm i @vercel/blob ali-oss
//   2) 配好环境变量后运行：
//      BLOB_READ_WRITE_TOKEN=xxx \
//      OSS_REGION=oss-cn-hangzhou OSS_BUCKET=你的桶 \
//      OSS_ACCESS_KEY_ID=xxx OSS_ACCESS_KEY_SECRET=xxx \
//      node scripts/migrate-blob-to-oss.mjs
//
//   可选：只迁某个前缀 → node scripts/migrate-blob-to-oss.mjs accounts/
//   可选：DRY_RUN=1 只列出不写入
//
// 幂等：重复运行会覆盖同名 key（内容一致，安全）。

import { list as blobList } from '@vercel/blob';
import OSS from 'ali-oss';

const PREFIXES = process.argv[2] ? [process.argv[2]] : ['accounts/', 'sectorflow/', 'dailyreport/'];
const DRY = process.env.DRY_RUN === '1';

function ossClient() {
  const { OSS_REGION, OSS_BUCKET, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_ENDPOINT } = process.env;
  if (!OSS_BUCKET || !OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) {
    throw new Error('缺少 OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
  }
  const cfg = { accessKeyId: OSS_ACCESS_KEY_ID, accessKeySecret: OSS_ACCESS_KEY_SECRET, bucket: OSS_BUCKET, secure: true };
  if (OSS_ENDPOINT) cfg.endpoint = OSS_ENDPOINT; else cfg.region = OSS_REGION;
  return new OSS(cfg);
}

// 列出某前缀下全部 blob（分页翻完）
async function listAll(prefix) {
  const all = [];
  let cursor;
  do {
    const r = await blobList({ prefix, limit: 1000, cursor });
    all.push(...(r.blobs || []));
    cursor = r.cursor;
    if (r.hasMore && cursor) continue;
    cursor = null;
  } while (cursor);
  return all;
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('缺少 BLOB_READ_WRITE_TOKEN（Vercel Blob 只读令牌即可）');
  const oss = DRY ? null : ossClient();
  let total = 0, done = 0, failed = 0;

  for (const prefix of PREFIXES) {
    const blobs = await listAll(prefix);
    console.log(`\n[${prefix}] 共 ${blobs.length} 个对象`);
    total += blobs.length;

    // 适度并发，避免打爆
    const CONC = 8;
    for (let i = 0; i < blobs.length; i += CONC) {
      const batch = blobs.slice(i, i + CONC);
      await Promise.all(batch.map(async (b) => {
        const key = b.pathname;                       // ★ 原样保留 key
        try {
          const url = b.downloadUrl || b.url;
          const buf = Buffer.from(await fetch(url, { cache: 'no-store' }).then((r) => r.arrayBuffer()));
          if (DRY) { console.log('  [dry] ' + key + ` (${buf.length}B)`); done++; return; }
          await oss.put(key, buf, {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          });
          done++;
          if (done % 25 === 0) console.log(`  已迁移 ${done}/${total} ...`);
        } catch (e) {
          failed++;
          console.warn('  ✗ 失败:', key, String(e.message || e));
        }
      }));
    }
  }

  console.log(`\n完成：成功 ${done} / 共 ${total}，失败 ${failed}${DRY ? '（DRY_RUN，未真正写入）' : ''}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('迁移中止:', e); process.exit(1); });
