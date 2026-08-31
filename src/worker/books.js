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

  if (sub === 'file' && (method === 'GET' || method === 'HEAD')) return serveFile(request, env, id, method, user);
  if (sub === 'cover' && method === 'GET') return serveCover(env, id, user);
  if (sub === 'cover' && method === 'POST') return uploadCover(request, env, id, user);
  if (sub === 'progress' && (method === 'PUT' || method === 'POST')) return saveProgress(request, env, id, user);
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
  };
}

async function listBooks(env, user) {
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    `SELECT * FROM books WHERE user_id = ?1
     ORDER BY CASE WHEN last_read_at IS NULL THEN 0 ELSE 1 END, last_read_at DESC, added_at DESC`
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

  const id = crypto.randomUUID();
  const fileKey = `books/${id}/source.${format}`;
  const contentType = FORMATS[format];

  // 直接把请求体流转存 R2，不在内存中缓冲整个文件
  await env.BOOKS.put(fileKey, request.body, {
    httpMetadata: { contentType },
  });

  await env.DB.prepare(
    `INSERT INTO books (id, user_id, title, author, format, file_key, cover_key, size, added_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)`
  )
    .bind(id, user.id, title, author, format, fileKey, contentLength, Date.now())
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
