// Worker 主入口：页面路由（带登录门禁）+ API 分发 + 安全响应头
import {
  getSessionUser,
  handleRegisterRequest,
  handleRegister,
  handleLogin,
  handleForgot,
  handleReset,
  handleLogout,
  handleMe,
  json,
} from './auth.js';
import { handleBooksApi } from './books.js';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error('unhandled error:', err);
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        return json({ error: '服务器内部错误' }, 500);
      }
      return new Response('服务器内部错误', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith('/api/')) {
    return withSecurityHeaders(await handleApi(request, env, ctx), false);
  }

  // 页面路由：统一做登录门禁
  if (path === '/' || path === '/index.html') {
    const user = await getSessionUser(request, env.DB);
    if (!user) return redirect('/login?next=' + encodeURIComponent('/'));
    // html_handling 为 none，需显式请求文件名（此前 /index.html 的 307 规范化已禁用）
    return servePage(env, request, '/index.html');
  }
  if (path === '/login') {
    const user = await getSessionUser(request, env.DB);
    if (user) return redirect('/');
    return servePage(env, request, '/login.html');
  }
  if (/^\/read\/[\w-]+$/.test(path)) {
    const user = await getSessionUser(request, env.DB);
    if (!user) return redirect('/login?next=' + encodeURIComponent(path));
    return servePage(env, request, '/reader.html');
  }

  // 其余交给静态资源（CSS/JS/vendor/图标等）
  const asset = await env.ASSETS.fetch(request);
  return withSecurityHeaders(asset, true);
}

async function handleApi(request, env, ctx) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  // 变更类请求做同源校验（CSRF 防护，Cookie 均为 SameSite=Lax 双保险）
  if (method !== 'GET' && method !== 'HEAD') {
    const site = request.headers.get('sec-fetch-site');
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    if (origin && host && new URL(origin).host !== host) {
      return json({ error: '跨站请求被拒绝' }, 403);
    }
    if (site === 'cross-site') {
      return json({ error: '跨站请求被拒绝' }, 403);
    }
  }

  const AUTH_ROUTES = {
    '/api/auth/register-request': [handleRegisterRequest, 'POST'],
    '/api/auth/register': [handleRegister, 'POST'],
    '/api/auth/login': [handleLogin, 'POST'],
    '/api/auth/forgot': [handleForgot, 'POST'],
    '/api/auth/reset': [handleReset, 'POST'],
    '/api/auth/logout': [handleLogout, 'POST'],
  };

  const authHit = AUTH_ROUTES[pathname];
  if (authHit) {
    if (method !== authHit[1]) return json({ error: '不支持的请求方法' }, 405);
    try {
      return withSecurityHeaders(await authHit[0](request, env, env.DB), false);
    } catch (e) {
      // 业务错误（验证码错误、频率限制等）带 status 属性，按其状态码返回
      if (e && e.status) return json({ error: e.message }, e.status);
      throw e;
    }
  }
  if (pathname === '/api/auth/me' && method === 'GET') {
    return withSecurityHeaders(await handleMe(request, env, env.DB), false);
  }
  if (pathname.startsWith('/api/books')) {
    const user = await getSessionUser(request, env.DB);
    if (!user) return json({ error: '未登录' }, 401);
    return handleBooksApi(request, env, ctx, user);
  }
  return json({ error: '接口不存在' }, 404);
}

async function servePage(env, request, assetPath) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPath;
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  // 页面不缓存，保证登录状态与版本即时生效
  const out = withSecurityHeaders(asset, false, { 'cache-control': 'no-store' });
  out.headers.set('content-security-policy', assetPath === '/reader.html' ? CSP_READER : CSP_STRICT);
  return out;
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

const CSP_STRICT =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// 阅读器需要 blob/iframe 动态内容，放宽 script 限制（内容均来自用户自己上传的书籍）
const CSP_READER =
  "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self'";

function withSecurityHeaders(res, isStatic, extra = {}) {
  const out = new Response(res.body, res);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'same-origin');
  out.headers.set('x-frame-options', 'DENY');
  out.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}
