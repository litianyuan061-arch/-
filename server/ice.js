'use strict';

/**
 * 语音用的 ICE 服务器配置（STUN + TURN）。
 *
 * 只有 STUN 时，手机 4G/5G、公司网络等经常无法直连，语音会连接失败。
 * TURN 中转服务器能解决这个问题，支持三种配置方式（在 Render 的 Environment 里设置）：
 *
 * 1. Cloudflare（推荐，每月 1000GB 免费）
 *    CLOUDFLARE_TURN_KEY_ID、CLOUDFLARE_TURN_API_TOKEN
 * 2. Metered
 *    METERED_DOMAIN（如 yourapp.metered.live）、METERED_API_KEY
 * 3. 自己的 TURN 服务器（如 coturn）
 *    TURN_URLS（逗号分隔）、TURN_USERNAME、TURN_CREDENTIAL
 */

const STUN_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  { urls: 'stun:stun.miwifi.com:3478' },
];

const CACHE_MS = 6 * 60 * 60 * 1000; // 临时凭证有效期 24 小时，6 小时刷新一次
let cache = null; // { at, servers }

function provider(env = process.env) {
  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) return 'cloudflare';
  if (env.METERED_DOMAIN && env.METERED_API_KEY) return 'metered';
  if (env.TURN_URLS) return 'static';
  return null;
}

// 浏览器会拦截 53 端口，过滤掉避免无用的连接尝试
function dropPort53(servers) {
  return servers
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u));
      return { ...s, urls };
    })
    .filter((s) => s.urls.length);
}

async function fetchTurn(env = process.env) {
  switch (provider(env)) {
    case 'cloudflare': {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        }
      );
      if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
      return dropPort53(list);
    }
    case 'metered': {
      const res = await fetch(
        `https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`
      );
      if (!res.ok) throw new Error(`Metered TURN ${res.status}`);
      return dropPort53(await res.json());
    }
    case 'static':
      return [
        {
          urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        },
      ];
    default:
      return [];
  }
}

async function getIceServers(env = process.env) {
  if (!provider(env)) return { iceServers: STUN_SERVERS, relay: false };
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    try {
      cache = { at: Date.now(), servers: await fetchTurn(env) };
    } catch (e) {
      console.error('获取 TURN 凭证失败:', e.message);
      // 失败时沿用旧凭证（如果有），否则只用 STUN
      if (!cache) return { iceServers: STUN_SERVERS, relay: false };
    }
  }
  return { iceServers: [...STUN_SERVERS, ...cache.servers], relay: true };
}

module.exports = { getIceServers, provider, dropPort53 };
