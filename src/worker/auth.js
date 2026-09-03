// 认证模块：多用户（邮箱注册 / 登录 / 找回密码），D1 存储
// - 首个注册的用户自动成为管理员（role = 'admin'）
// - 注册与找回密码均需邮箱 4 位数字验证码（10 分钟有效，限尝试次数，60 秒重发冷却）
// - 密码使用 PBKDF2-SHA256（10 万次迭代 + 随机盐）
import { sendCodeEmail } from './mailer.js';

const SESSION_TTL_DAYS = 30;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 6;
const CODE_RESEND_COOLDOWN_MS = 60 * 1000;
export const COOKIE_NAME = 'ws_sid';

const enc = new TextEncoder();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64Bytes(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// 常数时间字节比较（Workers 专有 API）
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a.buffer, b.buffer);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2:${iterations}:${b64(salt)}:${b64(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = b64Bytes(parts[2]);
  const expect = b64Bytes(parts[3]);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, expect.length * 8);
  return bytesEqual(new Uint8Array(bits), expect);
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

export function sessionCookie(token, maxAge = SESSION_TTL_DAYS * 86400) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// 表结构：首次访问自动创建；兼容旧版（单用户）数据库的自动迁移
let schemaReady = null;
export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = migrate(db).catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

async function migrate(db) {
  // 旧版 sessions 表（含 username 列）需要重建
  let legacySessions = false;
  try {
    await db.prepare('SELECT user_id FROM sessions LIMIT 1').run();
  } catch {
    legacySessions = true; // 要么没有 sessions 表，要么是旧结构；DROP IF EXISTS 对两者都安全
  }
  if (legacySessions) {
    await db.prepare('DROP TABLE IF EXISTS sessions').run();
  }
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (email, purpose)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (expires_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      format TEXT NOT NULL,
      file_key TEXT NOT NULL,
      cover_key TEXT,
      size INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      location TEXT NOT NULL DEFAULT '',
      last_read_at INTEGER,
      category TEXT NOT NULL DEFAULT 'other'
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)'),
  ]);
  // 旧库的 books 表补 user_id 列（已存在则忽略）
  try {
    await db.prepare("ALTER TABLE books ADD COLUMN user_id TEXT NOT NULL DEFAULT ''").run();
  } catch {
    /* 列已存在 */
  }
  // 旧库的 books 表补 category 列（已存在则忽略）
  try {
    await db.prepare("ALTER TABLE books ADD COLUMN category TEXT NOT NULL DEFAULT 'other'").run();
  } catch {
    /* 列已存在 */
  }
  try {
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_books_user ON books (user_id)').run();
  } catch {
    /* 已存在 */
  }
}

// 校验会话，返回 {id, email, role}；未登录返回 null
export async function getSessionUser(request, db) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  try {
    await ensureSchema(db);
    const row = await db
      .prepare(
        `SELECT s.user_id AS uid, u.email AS email, u.role AS role
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?1 AND s.expires_at > ?2`
      )
      .bind(token, Date.now())
      .first();
    return row ? { id: row.uid, email: row.email, role: row.role } : null;
  } catch {
    return null;
  }
}

function hexRandom(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fourDigitCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return typeof email === 'string' && Boolean(email.match(EMAIL_RE));
}

async function createSession(db, userId) {
  const now = Date.now();
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now).run();
  const token = hexRandom(32);
  await db
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(token, userId, now, now + SESSION_TTL_DAYS * 86400 * 1000)
    .run();
  return sessionCookie(token);
}

// 生成并下发验证码（register / reset），60 秒重发冷却
async function issueCode(env, db, email, purpose) {
  const now = Date.now();
  const existing = await db
    .prepare('SELECT created_at FROM email_codes WHERE email = ?1 AND purpose = ?2')
    .bind(email, purpose)
    .first();
  if (existing && now - existing.created_at < CODE_RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((CODE_RESEND_COOLDOWN_MS - (now - existing.created_at)) / 1000);
    throw httpError(429, `发送太频繁，请 ${wait} 秒后再试`);
  }
  const code = fourDigitCode();
  const codeHash = await sha256Hex(code);
  await db
    .prepare(
      `INSERT INTO email_codes (email, purpose, code_hash, attempts, created_at, expires_at)
       VALUES (?1, ?2, ?3, 0, ?4, ?5)
       ON CONFLICT (email, purpose) DO UPDATE SET code_hash = ?3, attempts = 0, created_at = ?4, expires_at = ?5`
    )
    .bind(email, purpose, codeHash, now, now + CODE_TTL_MS)
    .run();
  await sendCodeEmail(env, email, code, purpose);
  return code;
}

// 校验验证码；错误次数超限后作废。成功返回并销毁验证码。
async function consumeCode(db, email, purpose, code) {
  const row = await db
    .prepare('SELECT code_hash, attempts, expires_at FROM email_codes WHERE email = ?1 AND purpose = ?2')
    .bind(email, purpose)
    .first();
  if (!row || row.expires_at < Date.now()) {
    throw httpError(400, '验证码无效或已过期');
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    throw httpError(400, '尝试次数过多，请重新获取验证码');
  }
  const inputHash = await sha256Hex(code);
  const ok = bytesEqual(hexToBytes(inputHash), hexToBytes(row.code_hash));
  if (!ok) {
    await db
      .prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?1 AND purpose = ?2')
      .bind(email, purpose)
      .run();
    throw httpError(400, '验证码错误');
  }
  await db.prepare('DELETE FROM email_codes WHERE email = ?1 AND purpose = ?2').bind(email, purpose).run();
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 72;
}

/* ---------------- 路由处理 ---------------- */

// POST /api/auth/register-request  {email}
export async function handleRegisterRequest(request, env, db) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!validEmail(email)) return json({ error: '请输入正确的邮箱地址' }, 400);
  await ensureSchema(db);
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (existing) return json({ error: '该邮箱已注册，请直接登录' }, 400);
  const code = await issueCode(env, db, email, 'register');
  return json({
    ok: true,
    cooldown: CODE_RESEND_COOLDOWN_MS / 1000,
    ...(env.DEV_SHOW_CODE === 'true' ? { devCode: code } : {}),
  });
}

// POST /api/auth/register  {email, code, password}
export async function handleRegister(request, env, db) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const code = String(body?.code || '').trim();
  if (!validEmail(email)) return json({ error: '请输入正确的邮箱地址' }, 400);
  if (!code.match(/^\d{4}$/)) return json({ error: '请输入 4 位数字验证码' }, 400);
  if (!validPassword(body?.password)) return json({ error: '密码长度需为 8-72 位' }, 400);
  await ensureSchema(db);
  await consumeCode(db, email, 'register', code);

  const count = await db.prepare('SELECT COUNT(*) AS c FROM users').first();
  const role = count && count.c === 0 ? 'admin' : 'member';
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(body.password);
  try {
    await db
      .prepare('INSERT INTO users (id, email, password_hash, role, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
      .bind(id, email, passwordHash, role, Date.now())
      .run();
  } catch {
    return json({ error: '该邮箱已被注册' }, 400);
  }
  const cookie = await createSession(db, id);
  return json({ ok: true, email, role, first: role === 'admin' }, 200, { 'Set-Cookie': cookie });
}

// 登录失败限速：全局内存计数（Workers 多实例下为尽力而为）
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
let failCount = 0;
let failResetAt = 0;

function loginBlocked() {
  const now = Date.now();
  if (now > failResetAt) {
    failCount = 0;
    failResetAt = now + WINDOW_MS;
    return false;
  }
  return failCount >= MAX_ATTEMPTS;
}

// POST /api/auth/login  {email, password}
export async function handleLogin(request, env, db) {
  if (loginBlocked()) return json({ error: '尝试次数过多，请 5 分钟后再试' }, 429);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!validEmail(email) || typeof body?.password !== 'string') {
    return json({ error: '请输入邮箱和密码' }, 400);
  }
  await ensureSchema(db);
  const user = await db.prepare('SELECT id, password_hash FROM users WHERE email = ?1').bind(email).first();
  const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
  if (!ok) {
    failCount += 1;
    return json({ error: '邮箱或密码错误' }, 401);
  }
  failCount = 0;
  await db.prepare('UPDATE users SET last_login_at = ?1 WHERE id = ?2').bind(Date.now(), user.id).run();
  const cookie = await createSession(db, user.id);
  return json({ ok: true, email }, 200, { 'Set-Cookie': cookie });
}

// POST /api/auth/forgot  {email} —— 统一响应，不暴露邮箱是否存在
export async function handleForgot(request, env, db) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!validEmail(email)) return json({ error: '请输入正确的邮箱地址' }, 400);
  await ensureSchema(db);
  const resp = { ok: true, cooldown: CODE_RESEND_COOLDOWN_MS / 1000 };
  const user = await db.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (user) {
    const code = await issueCode(env, db, email, 'reset');
    if (env.DEV_SHOW_CODE === 'true') resp.devCode = code;
  }
  return json(resp);
}

// POST /api/auth/reset  {email, code, password}
export async function handleReset(request, env, db) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const code = String(body?.code || '').trim();
  if (!validEmail(email)) return json({ error: '请输入正确的邮箱地址' }, 400);
  if (!code.match(/^\d{4}$/)) return json({ error: '请输入 4 位数字验证码' }, 400);
  if (!validPassword(body?.password)) return json({ error: '密码长度需为 8-72 位' }, 400);
  await ensureSchema(db);
  const user = await db.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (!user) return json({ error: '验证码无效或已过期' }, 400);
  await consumeCode(db, email, 'reset', code);
  const passwordHash = await hashPassword(body.password);
  await db.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(passwordHash, user.id).run();
  // 重置后让所有旧会话失效，再自动登录
  await db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(user.id).run();
  const cookie = await createSession(db, user.id);
  return json({ ok: true, email }, 200, { 'Set-Cookie': cookie });
}

// POST /api/auth/logout
export async function handleLogout(request, env, db) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (token) {
    await ensureSchema(db);
    await db.prepare('DELETE FROM sessions WHERE token = ?1').bind(token).run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

// GET /api/auth/me
export async function handleMe(request, env, db) {
  const user = await getSessionUser(request, db);
  if (!user) return json({ error: '未登录' }, 401);
  return json({ email: user.email, role: user.role });
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}
