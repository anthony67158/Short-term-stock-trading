import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const PROTECTED_SITE_HOST = 'www.tedixtf.cn';
export const SITE_ACCESS_PATH = '/api/site_access';
export const SITE_ACCESS_COOKIE = '__Host-tedixtf_access';
export const SITE_ACCESS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const TOKEN_VERSION = 'v1';
const PUBLIC_SITE_ASSETS = new Set([
  '/manifest.json',
  '/sw.js',
  '/favicon-32.png',
  '/favicon-48.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-v2.png',
  '/apple-touch-icon-v5.png',
  '/apple-touch-icon-v6.png',
  '/apple-touch-icon-v7.png',
  '/app-icon-source.webp',
  '/app-icon-192.png',
  '/app-icon-512.png',
  '/app-icon-1024.png',
  '/app-icon-maskable-512.png',
]);

function sign(value, secret, context) {
  if (!secret) return '';
  return createHmac('sha256', secret)
    .update(`${context}:${value}`)
    .digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeSiteHost(host) {
  const first = String(host || '').split(',')[0].trim().toLowerCase();
  return first.replace(/\.$/, '').replace(/:\d+$/, '');
}

export function isProtectedSiteHost(host) {
  return normalizeSiteHost(host) === PROTECTED_SITE_HOST;
}

export function isPublicSiteAsset(pathname) {
  return PUBLIC_SITE_ASSETS.has(String(pathname || ''));
}

export function siteAccessCodeDigest(code, secret) {
  return sign(String(code || ''), secret, 'site-access-code:v1');
}

export function verifySiteAccessCode(
  code,
  { expectedDigest, secret } = {},
) {
  const normalized = String(code || '').trim();
  if (!/^\d{8}$/.test(normalized) || !expectedDigest || !secret) return false;
  return safeEqual(
    siteAccessCodeDigest(normalized, secret),
    expectedDigest,
  );
}

export function createSiteAccessToken({
  secret,
  deviceId = randomBytes(24).toString('base64url'),
  now = Date.now(),
  maxAgeSeconds = SITE_ACCESS_MAX_AGE_SECONDS,
} = {}) {
  if (!secret) throw new Error('site access secret is missing');
  const expiresAt = Math.floor(now / 1000) + maxAgeSeconds;
  const payload = `${TOKEN_VERSION}.${expiresAt}.${deviceId}`;
  return `${payload}.${sign(payload, secret, 'site-access-token:v1')}`;
}

export function verifySiteAccessToken(
  token,
  { secret, now = Date.now() } = {},
) {
  if (!token || !secret) return false;
  const parts = String(token).split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false;
  const [version, expiresRaw, deviceId, signature] = parts;
  const expiresAt = Number(expiresRaw);
  if (
    !Number.isInteger(expiresAt)
    || expiresAt <= Math.floor(now / 1000)
    || !/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)
  ) return false;
  const payload = `${version}.${expiresAt}.${deviceId}`;
  return safeEqual(
    sign(payload, secret, 'site-access-token:v1'),
    signature,
  );
}

export function cookieValue(cookieHeader, name) {
  const pair = String(cookieHeader || '')
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  if (!pair) return '';
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return '';
  }
}

export function siteAccessCookie(token) {
  return [
    `${SITE_ACCESS_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${SITE_ACCESS_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

export function createSiteAccessLimiter({
  maxAttempts = 5,
  windowMs = 10 * 60 * 1000,
} = {}) {
  const failures = new Map();

  function current(key, now) {
    const entry = failures.get(key);
    if (!entry || now - entry.startedAt >= windowMs) {
      failures.delete(key);
      return null;
    }
    return entry;
  }

  return {
    canAttempt(key, now = Date.now()) {
      const entry = current(key, now);
      return !entry || entry.count < maxAttempts;
    },
    recordFailure(key, now = Date.now()) {
      const entry = current(key, now);
      failures.set(key, entry
        ? { ...entry, count: entry.count + 1 }
        : { count: 1, startedAt: now });
    },
    retryAfterSeconds(key, now = Date.now()) {
      const entry = current(key, now);
      return entry
        ? Math.max(1, Math.ceil((windowMs - (now - entry.startedAt)) / 1000))
        : 0;
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
