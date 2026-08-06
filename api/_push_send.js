// ============ web-push 下发封装(服务端私有) ============
// 用 VAPID 私钥给一批订阅发同一条通知。返回失效(410/404)的 endpoint,供调用方从账号里剔除。
// 环境变量:VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT(mailto:...)
import webpush from 'web-push';

let _ready = false;
function ensure() {
  if (_ready) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const sub = process.env.VAPID_SUBJECT || 'mailto:admin@stock-dashboard.local';
  if (!pub || !priv) return false;
  try { webpush.setVapidDetails(sub, pub, priv); _ready = true; } catch { _ready = false; }
  return _ready;
}

export function pushConfigured() { return ensure(); }

// subs: [{endpoint, keys:{p256dh,auth}}]  payload:{title,body,tag,code,url,icon}
// → { sent, failed, deadEndpoints:[] }
export async function sendPush(subs, payload) {
  const out = { sent: 0, failed: 0, deadEndpoints: [] };
  if (!ensure() || !Array.isArray(subs) || !subs.length) return out;
  const data = JSON.stringify(payload || {});
  await Promise.all(subs.map(async (s) => {
    if (!s || !s.endpoint || !s.keys) return;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, data, { TTL: 3600 });
      out.sent++;
    } catch (e) {
      out.failed++;
      const code = e && e.statusCode;
      if (code === 404 || code === 410) out.deadEndpoints.push(s.endpoint); // 订阅已失效 → 标记删除
    }
  }));
  return out;
}
