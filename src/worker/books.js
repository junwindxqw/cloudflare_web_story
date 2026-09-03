// 图书 API：书架列表 / 上传 / 封面 / 原文件（支持 Range）/ 阅读进度 / 彻底移除
// 书架按用户隔离：每人只能看到和操作自己的书；管理员（首个注册用户）可删除任何人的书
import { ensureSchema, json } from './auth.js';

// 支持的格式与 MIME
const FORMATS = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  fb2: 'application/x-fictionbook+xml',
  cbz: 'application/vnd.comicbook+zip',
};

// 题材分类（与 public/js/common.js 中的 CATEGORIES 保持镜像一致）
const CATEGORIES = [
  { id: 'novel',     label: '小说' },
  { id: 'scifi',     label: '科幻' },
  { id: 'history',   label: '历史' },
  { id: 'computer',  label: '计算机' },
  { id: 'reference', label: '工具书' },
  { id: 'literature',label: '散文' },
  { id: 'magazine',  label: '杂志' },
  { id: 'other',     label: '其他' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const DEFAULT_CATEGORY = 'other';

// 启发式规则：按顺序匹配标题/作者，命中第一条即返回
// 顺序很重要：更具体的分类在前，避免「三体」被小说抢走
function classifyBook({ title, author, format }) {
  const hay = `${title || ''} ${author || ''}`.toLowerCase();
  const rules = [
    [/三体|刘慈欣|科幻|galactic|space opera|worm/i, 'scifi'],
    [/javascript|typescript|python|rust|golang|\bgo\b|java\b|算法|编程|程序设计|linux|kubernetes|\bk8s\b|docker|深度学习|机器学习|人工智能|神经网络|架构|design pattern|数据库|\bsql\b|数据结构|编译原理|操作系统/i, 'computer'],
    [/史记|资治通鉴|通鉴|战国|朝代|近代史|中国史|世界史|通史|断代史/i, 'history'],
    [/散文|诗集|随笔|文集|札记|杂文|小品文/i, 'literature'],
    [/周刊|月刊|杂志|\bjournal\b|\bmagazine\b|半月谈/i, 'magazine'],
    [/手册|指南|教程|\btutorial\b|\bcookbook\b|\breference\b|\bapi\b|辞海|词典|字典|\bgrammar\b|语法|百科|词典|说明书|spec/i, 'reference'],
    [/小说|长篇|短篇|章回|\bnovel\b|\bfiction\b|言情|玄幻|武侠|推理|悬疑|侦探|盗墓/i, 'novel'],
  ];
  for (const [re, id] of rules) {
    if (re.test(hay)) return id;
  }
  if (format === 'pdf') return 'reference';
  return DEFAULT_CATEGORY;
}

const ROUTE = /^\/api\/books(?:\/([\w-]+)(?:\/(file|cover|progress))?)?$/;
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

export async function handleBooksApi(request, env, ctx, user) {
  const { pathname } = new URL(request.url);
  const m = pathname.match(ROUTE);
  if (!m) return json({ error: '接口不存在' }, 404);
  const [, id, sub] = m;
  const method = request.method;

  if (!id) {
    if (method === 'GET') return listBooks(env, user);
    if (method === 'POST') return uploadBook(request, env, user);
    return json({ error: '不支持的请求方法' }, 405);
  }

  // 两个数据在 body 中的专用端点（客户端调用时 URL 恒为静态，ID 走参数化校验）
  if (id === 'detail' && method === 'POST') return bookDetail(request, env, user);
  if (id === 'progress' && !sub && (method === 'PUT' || method === 'POST')) return saveProgressById(request, env, user);
  if (id === 'classify-all' && method === 'POST') return classifyAll(env, user);

  if (sub === 'file' && (method === 'GET' || method === 'HEAD')) return serveFile(request, env, id, method, user);
  if (sub === 'cover' && method === 'GET') return serveCover(env, id, user);
  if (sub === 'cover' && method === 'POST') return uploadCover(request, env, id, user);
  if (sub === 'progress' && (method === 'PUT' || method === 'POST')) return saveProgress(request, env, id, user);
  if (sub === 'category' && method === 'PUT') return updateCategory(request, env, id, user);
  if (!sub && method === 'GET') return getBook(env, id, user);
  if (!sub && method === 'DELETE') return removeBook(env, id, user);
  return json({ error: '不支持的请求方法' }, 405);
}

// 归属校验：本人或管理员
function canAccess(user, row) {
  return row.user_id === user.id || user.role === 'admin';
}

function bookRow(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    format: row.format,
    size: row.size,
    addedAt: row.added_at,
    progress: row.progress,
    lastReadAt: row.last_read_at,
    hasCover: Boolean(row.cover_key),
    category: row.category || DEFAULT_CATEGORY,
  };
}

async function listBooks(env, user) {
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    `SELECT * FROM books WHERE user_id = ?1
     ORDER BY CASE WHEN last_read_at IS NULL THEN 1 ELSE 0 END, last_read_at DESC, added_at DESC`
  )
    .bind(user.id)
    .all();
  const books = results.map(bookRow);
  const totalSize = books.reduce((s, b) => s + (b.size || 0), 0);
  return json({ books, totalSize, total: books.length });
}

async function getBook(env, id, user) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT * FROM books WHERE id = ?1').bind(id).first();
  if (!row || !canAccess(user, row)) return json({ error: '书籍不存在' }, 404);
  return json({ ...bookRow(row), location: row.location });
}

// POST /api/books/detail  {id} —— 阅读器获取单本元数据
async function bookDetail(request, env, user) {
  const body = await readJsonSafe(request);
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id.match(/^[\w-]{1,64}$/)) return json({ error: '参数无效' }, 400);
  return getBook(env, id, user);
}

// 上传：原始文件流作为请求体，元数据放查询参数（避免 multipart 在 Worker 内存中整包缓冲）
async function uploadBook(request, env, user) {
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  const maxBytes = Number(env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (!contentLength) return json({ error: '缺少请求体' }, 400);
  if (contentLength > maxBytes) {
    return json({ error: `文件超过大小限制（${env.MAX_UPLOAD_MB || 100}MB）` }, 413);
  }

  const format = (url.searchParams.get('format') || '').toLowerCase();
  if (!FORMATS[format]) {
    return json({ error: '暂不支持该格式，支持：' + Object.keys(FORMATS).join(' / ') }, 400);
  }
  const title = (url.searchParams.get('title') || '未命名书籍').trim().slice(0, 200) || '未命名书籍';
  const author = (url.searchParams.get('author') || '').trim().slice(0, 200);
  const category = classifyBook({ title, author, format });

  const id = crypto.randomUUID();
  const fileKey = `books/${id}/source.${format}`;
  const contentType = FORMATS[format];

  // 直接把请求体流转存 R2，不在内存中缓冲整个文件
  await env.BOOKS.put(fileKey, request.body, {
    httpMetadata: { contentType },
  });

  await env.DB.prepare(
    `INSERT INTO books (id, user_id, title, author, format, file_key, cover_key, size, added_at, category)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)`
  )
    .bind(id, user.id, title, author, format, fileKey, contentLength, Date.now(), category)
    .run();

  return json(
    {
      id,
      title,
      author,
      format,
      size: contentLength,
      addedAt: Date.now(),
      progress: 0,
      lastReadAt: null,
      hasCover: false,
      category,
    },
    201
  );
}

async function uploadCover(request, env, id, user) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT id, user_id FROM books WHERE id = ?1').bind(id).first();
  if (!row || !canAccess(user, row)) return json({ error: '书籍不存在' }, 404);
  const cl = Number(request.headers.get('content-length') || 0);
  if (!cl || cl > 3 * 1024 * 1024) return json({ error: '封面数据无效' }, 400);
  const buf = await request.arrayBuffer();
  const coverKey = `books/${id}/cover.jpg`;
  await env.BOOKS.put(coverKey, buf, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare('UPDATE books SET cover_key = ?1 WHERE id = ?2').bind(coverKey, id).run();
  return json({ ok: true });
}

async function serveCover(env, id, user) {
  const row = await env.DB.prepare('SELECT cover_key, user_id FROM books WHERE id = ?1').bind(id).first();
  if (!row || !row.cover_key || !canAccess(user, row)) return json({ error: '无封面' }, 404);
  const obj = await env.BOOKS.get(row.cover_key);
  if (!obj) return json({ error: '无封面' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'private, max-age=86400');
  return new Response(obj.body, { status: 200, headers });
}

// 原文件：支持 Range 分段（PDF 流式加载必需）
async function serveFile(request, env, id, method, user) {
  const row = await env.DB.prepare('SELECT file_key, format, title, user_id FROM books WHERE id = ?1').bind(id).first();
  if (!row || !canAccess(user, row)) return json({ error: '书籍不存在' }, 404);

  const rangeHeader = request.headers.get('range');
  let obj;
  let status = 200;
  if (rangeHeader) {
    const head = await env.BOOKS.head(row.file_key);
    if (!head) return json({ error: '文件不存在' }, 404);
    const parsed = parseRangeHeader(rangeHeader, head.size);
    if (parsed === 'invalid') {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${head.size}` } });
    }
    if (parsed) {
      obj = await env.BOOKS.get(row.file_key, { range: parsed });
      status = 206;
    } else {
      obj = await env.BOOKS.get(row.file_key);
    }
  } else {
    obj = await env.BOOKS.get(row.file_key);
  }
  if (!obj) return json({ error: '文件不存在' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', FORMATS[row.format] || 'application/octet-stream');
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, no-store');
  headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.title)}`);

  if (status === 206 && obj.range) {
    const { offset = 0, length = 0 } = obj.range;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
  } else {
    headers.set('content-length', String(obj.size));
  }
  return new Response(method === 'HEAD' ? null : obj.body, { status, headers });
}

function parseRangeHeader(header, size) {
  const m = header.trim().match(RANGE_RE);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (!suffix) return null;
    return { suffix };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (!Number.isFinite(start) || start > end || start >= size) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

async function saveProgress(request, env, id, user) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT id, user_id FROM books WHERE id = ?1').bind(id).first();
  if (!row || !canAccess(user, row)) return json({ error: '书籍不存在' }, 404);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }
  const progress = Math.max(0, Math.min(1, Number(body.progress) || 0));
  const location = typeof body.location === 'string' ? body.location.slice(0, 4096) : '';
  await env.DB.prepare('UPDATE books SET progress = ?1, location = ?2, last_read_at = ?3 WHERE id = ?4')
    .bind(progress, location, Date.now(), id)
    .run();
  return json({ ok: true });
}

// PUT /api/books/progress  {id, progress, location} —— 阅读器保存进度（页面卸载时 fetch 目标恒为静态路径）
async function saveProgressById(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id.match(/^[\w-]{1,64}$/)) return json({ error: '参数无效' }, 400);
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT id, user_id FROM books WHERE id = ?1').bind(id).first();
  if (!row || !canAccess(user, row)) return json({ error: '书籍不存在' }, 404);
  const progress = Math.max(0, Math.min(1, Number(body.progress) || 0));
  const location = typeof body.location === 'string' ? body.location.slice(0, 4096) : '';
  await env.DB.prepare('UPDATE books SET progress = ?1, location = ?2, last_read_at = ?3 WHERE id = ?4')
    .bind(progress, location, Date.now(), id)
    .run();
  return json({ ok: true });
}

function readJsonSafe(request) {
  return request.json().catch(() => null);
}

// 彻底移除：同时删除 R2 中的源文件与封面，再清掉元数据（非软删除）
async function removeBook(env, id, user) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT id, file_key, cover_key, user_id FROM books WHERE id = ?1').bind(id).first();
  if (!row || !canAccess(user, row)) return json({ error: '书籍不存在' }, 404);
  const keys = [row.file_key, row.cover_key].filter(Boolean);
  if (keys.length) {
    await env.BOOKS.delete(keys);
  }
  await env.DB.prepare('DELETE FROM books WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

// 一键重跑分类：按当前用户的全部书重新跑启发式规则并落库
async function classifyAll(env, user) {
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    'SELECT id, title, author, format FROM books WHERE user_id = ?1'
  ).bind(user.id).all();
  if (!results.length) return json({ updated: 0, total: 0 });

  // 仅对分类会变化的书发起 UPDATE，避免无意义的写入
  const stmts = [];
  let updated = 0;
  for (const row of results) {
    const next = classifyBook(row);
    if (next !== row.category) {
      stmts.push(env.DB.prepare('UPDATE books SET category = ?1 WHERE id = ?2').bind(next, row.id));
      updated += 1;
    }
  }
  // db.batch 在 D1 中是事务式；分批避免单次过多
  const BATCH = 100;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await env.DB.batch(stmts.slice(i, i + BATCH));
  }
  return json({ updated, total: results.length });
}

// 单本手动改分类
async function updateCategory(request, env, id, user) {
  await ensureSchema(env.DB);
  const body = await readJsonSafe(request);
  const category = typeof body?.category === 'string' ? body.category : '';
  if (!CATEGORY_IDS.has(category)) return json({ error: '分类无效' }, 400);
  const row = await env.DB.prepare('SELECT id, user_id FROM books WHERE id = ?1').bind(id).first();
  if (!row || !canAccess(user, row)) return json({ error: '书籍不存在' }, 404);
  await env.DB.prepare('UPDATE books SET category = ?1 WHERE id = ?2').bind(category, id).run();
  return json({ ok: true, category });
}
