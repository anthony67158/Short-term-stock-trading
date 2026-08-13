// ============ 存储抽象层：阿里云 OSS 版（对齐 @vercel/blob 的 put/list/del 接口）============
// 目的：把原来散落在 account.js / _sector_snapshots.js / _daily_summary.js / daily_report.js
// 里对 @vercel/blob 的调用，收敛到本模块，底层换成阿里云 OSS（ali-oss）。
//
// 对外暴露与 @vercel/blob 语义一致的三个函数：
//   put(pathname, body, opts)  → { url, pathname, downloadUrl }
//   list({ prefix, limit })    → { blobs: [{ pathname, url, downloadUrl, uploadedAt, size }] }
//   del(urlOrPathname)         → void
// 另外补充一个便捷读取：readJson(blobOrUrl) → 解析后的对象 | null
//
// 环境变量（在 FC 控制台或 s.yaml 里配置）：
//   OSS_REGION            如 oss-cn-hangzhou
//   OSS_BUCKET            数据桶名（存 accounts/ sectorflow/ dailyreport/）
//   OSS_ACCESS_KEY_ID     RAM 用户 AK
//   OSS_ACCESS_KEY_SECRET RAM 用户 SK
//   OSS_ENDPOINT          可选，自定义内网/外网 endpoint（FC 与 OSS 同区可用内网省流量）
//   OSS_PUBLIC_BASE       可选，读取用的公网基址（绑了 CDN/自定义域名时填），默认用 bucket 外网域名
//
// 说明：@vercel/blob 的 addRandomSuffix 会在文件名后追加随机串以保证唯一 URL；
// 这里同样在写入时追加随机后缀，行为对齐（调用方仍传原始 pathname）。

import OSS from 'ali-oss';
import { randomBytes } from 'crypto';
import {
  allowOssPublicNetwork,
  resolveOssEndpoint,
} from '../shared/ossNetworkPolicy.js';

let _client = null;
function client() {
  if (_client) return _client;
  const {
    OSS_REGION, OSS_BUCKET, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_ENDPOINT,
  } = process.env;
  if (!OSS_BUCKET || !OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) return null;
  const cfg = {
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET,
    secure: true,
  };
  const endpoint = resolveOssEndpoint(process.env, OSS_ENDPOINT);
  if (endpoint) cfg.endpoint = endpoint;
  else cfg.region = OSS_REGION;
  _client = new OSS(cfg);
  return _client;
}

// 是否已配置存储（对齐原 process.env.BLOB_READ_WRITE_TOKEN 的开关判断）
export function hasStorage() {
  return !!(process.env.OSS_BUCKET && process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET);
}

// 读取用的公网基址
function publicBase() {
  if (!allowOssPublicNetwork(process.env)) return '';
  if (process.env.OSS_PUBLIC_BASE) return process.env.OSS_PUBLIC_BASE.replace(/\/$/, '');
  const region = process.env.OSS_REGION;
  const bucket = process.env.OSS_BUCKET;
  if (bucket && region) return `https://${bucket}.${region}.aliyuncs.com`;
  return '';
}
function urlOf(pathname) {
  const base = publicBase();
  return base ? `${base}/${pathname}` : pathname;
}

// 从 URL 反解出 OSS object key（pathname）
function keyFromUrl(u) {
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) return u.replace(/^\//, ''); // 传的本就是 pathname
  try {
    const p = new URL(u).pathname.replace(/^\//, '');
    return decodeURIComponent(p);
  } catch { return u.replace(/^\//, ''); }
}

// put：写入对象。opts 兼容 @vercel/blob（access/contentType/addRandomSuffix/cacheControlMaxAge）
export async function put(pathname, body, opts = {}) {
  const c = client();
  if (!c) throw new Error('OSS 未配置');
  let key = String(pathname).replace(/^\//, '');
  if (opts.addRandomSuffix) {
    const rnd = randomBytes(6).toString('hex');
    key = key.replace(/(\.[^.\/]+)?$/, (ext) => `-${rnd}${ext || ''}`);
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const headers = {};
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  const maxAge = opts.cacheControlMaxAge;
  headers['Cache-Control'] = (maxAge === 0 || maxAge) ? `max-age=${maxAge}` : 'no-cache';
  await c.put(key, buf, { headers });
  return { url: urlOf(key), downloadUrl: urlOf(key), pathname: key };
}

// list：按前缀列出对象。返回结构对齐 @vercel/blob 的 { blobs:[...] }
export async function list({ prefix = '', limit = 1000 } = {}) {
  const c = client();
  if (!c) return { blobs: [] };
  const blobs = [];
  let marker = null;
  do {
    const r = await c.list({ prefix, 'max-keys': Math.min(1000, limit - blobs.length), marker }, {});
    const objs = (r && r.objects) || [];
    for (const o of objs) {
      blobs.push({
        pathname: o.name,
        url: urlOf(o.name),
        downloadUrl: urlOf(o.name),
        uploadedAt: o.lastModified,   // ISO 字符串，new Date() 可解析，对齐原用法
        size: o.size,
      });
      if (blobs.length >= limit) break;
    }
    marker = (r && r.nextMarker) || null;
  } while (marker && blobs.length < limit);
  return { blobs };
}

// del：删除对象。接受完整 url 或 pathname
export async function del(urlOrPathname) {
  const c = client();
  if (!c) return;
  const key = keyFromUrl(urlOrPathname);
  if (!key) return;
  await c.delete(key);
}

// 便捷读取：默认只通过 SDK 内网读取；仅显式允许公网时才可回退 fetch(url)。
export async function readJson(blobOrUrl) {
  const key = keyFromUrl(typeof blobOrUrl === 'string' ? blobOrUrl : (blobOrUrl && (blobOrUrl.pathname || blobOrUrl.url)));
  const c = client();
  if (c && key) {
    try {
      const r = await c.get(key);
      const content = r && r.content;
      if (content) return JSON.parse(content.toString('utf-8'));
    } catch {
      if (!allowOssPublicNetwork(process.env)) return null;
    }
  }
  if (!allowOssPublicNetwork(process.env)) return null;
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : (blobOrUrl && (blobOrUrl.downloadUrl || blobOrUrl.url));
  if (url && /^https?:\/\//i.test(url)) {
    try { return await fetch(url, { cache: 'no-store' }).then((x) => x.ok ? x.json() : null); } catch { return null; }
  }
  return null;
}

// 账号等关键数据使用严格读取：对象不存在返回 null，OSS 连接/鉴权/解析异常必须抛出，
// 避免把存储故障误判成“账号不存在”。
export async function readJsonStrict(blobOrPathname) {
  const key = keyFromUrl(typeof blobOrPathname === 'string'
    ? blobOrPathname
    : (blobOrPathname && (blobOrPathname.pathname || blobOrPathname.url)));
  const c = client();
  if (!c) throw new Error('OSS 未配置');
  if (!key) return null;
  try {
    const r = await c.get(key);
    const content = r && r.content;
    return content ? JSON.parse(content.toString('utf-8')) : null;
  } catch (error) {
    if (error && (error.status === 404 || error.code === 'NoSuchKey' || error.name === 'NoSuchKeyError')) {
      return null;
    }
    throw error;
  }
}
