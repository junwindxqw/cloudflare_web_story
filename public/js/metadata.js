// 客户端书籍元数据与封面提取（浏览器本地完成，减轻服务端负担）
import { loadScript } from './script-loader.js';

const COVER_W = 480;
const COVER_H = 720;

export const SUPPORTED_EXTS = ['epub', 'pdf', 'txt', 'mobi', 'azw3', 'fb2', 'cbz'];

export function extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(name) {
  return (name || '').replace(/\.[^.]+$/, '').trim() || '未命名书籍';
}

// 入口：根据扩展名提取元数据，失败时退回文件名
export async function extractMeta(file) {
  const format = extOf(file.name);
  const fallback = { title: baseName(file.name), author: '', cover: null, format };
  try {
    if (format === 'epub') return { ...fallback, ...(await epubMeta(file)) };
    if (format === 'pdf') return { ...fallback, ...(await pdfMeta(file)) };
    if (format === 'mobi' || format === 'azw3' || format === 'fb2' || format === 'cbz') {
      return { ...fallback, ...(await foliateMeta(file)) };
    }
  } catch (e) {
    console.warn('元数据提取失败，使用文件名：', e);
  }
  return fallback;
}

/* ---------- EPUB：解析 container.xml → OPF ---------- */
async function epubMeta(file) {
  await loadScript('/vendor/jszip/jszip.min.js');
  const JSZip = window.JSZip;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = zip.file('META-INF/container.xml');
  if (!container) return {};
  const rootfile = (await container.async('string')).match(/full-path="([^"]+)"/)?.[1];
  if (!rootfile) return {};
  const opfFile = zip.file(decodeURIComponent(rootfile));
  if (!opfFile) return {};
  const opf = new DOMParser().parseFromString(await opfFile.async('string'), 'application/xml');
  const title = opf.getElementsByTagName('dc:title')[0]?.textContent?.trim();
  const author = opf.getElementsByTagName('dc:creator')[0]?.textContent?.trim();

  const opfDir = decodeURIComponent(rootfile).replace(/[^/]*$/, '');
  const items = [...opf.getElementsByTagName('item')];
  const resolvePath = (href) => {
    if (!href) return null;
    const path = new URL(decodeURIComponent(href), 'file:///' + opfDir).pathname.slice(1);
    return zip.file(path) || zip.file(decodeURIComponent(href));
  };
  const metaCoverId = opf.querySelector('meta[name="cover"]')?.getAttribute('content');
  const coverItem =
    items.find((i) => (i.getAttribute('properties') || '').includes('cover-image')) ||
    items.find((i) => i.getAttribute('id') === metaCoverId && (i.getAttribute('media-type') || '').startsWith('image/'));
  const guideHref = opf.querySelector('reference[type="cover"]')?.getAttribute('href');
  let coverBlob = null;
  const coverFile = resolvePath(coverItem?.getAttribute('href')) || resolvePath(guideHref);
  if (coverFile) {
    try {
      coverBlob = await coverFile.async('blob');
    } catch {
      /* 封面提取失败不影响导入 */
    }
  }
  return { title: title || undefined, author: author || '', cover: coverBlob };
}

/* ---------- PDF：pdf.js 读信息 + 首页渲染封面 ---------- */
async function pdfMeta(file) {
  const pdfjsLib = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let title = '';
  let author = '';
  try {
    const meta = await pdf.getMetadata();
    title = (meta?.info?.Title || '').trim();
    author = (meta?.info?.Author || '').trim();
  } catch {
    /* 忽略 */
  }
  let cover = null;
  try {
    const page = await pdf.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: COVER_W / v1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    cover = await canvasToBlob(canvas);
  } catch {
    /* 忽略 */
  }
  pdf.destroy();
  return { title: title || undefined, author, cover };
}

/* ---------- MOBI / AZW3 / FB2 / CBZ：foliate-js ---------- */
async function foliateMeta(file) {
  const { makeBook, View } = await import('/vendor/foliate-js/view.js');
  void View;
  const book = await makeBook(file);
  const meta = book.metadata || {};
  let author = meta.author ?? meta.creator ?? '';
  if (Array.isArray(author)) author = author.join(', ');
  let cover = null;
  try {
    if (book.getCover) cover = await book.getCover();
  } catch {
    /* 忽略 */
  }
  return { title: meta.title || undefined, author, cover };
}

/* ---------- 生成式封面（无内嵌封面时） ---------- */
const PALETTES = [
  ['#667eea', '#764ba2'],
  ['#f093fb', '#f5576c'],
  ['#4facfe', '#00f2fe'],
  ['#43e97b', '#38f9d7'],
  ['#fa709a', '#fee140'],
  ['#30cfd0', '#330867'],
  ['#a8edea', '#fed6e3'],
  ['#5ee7df', '#b490ca'],
  ['#c79081', '#dfa579'],
  ['#7f7fd5', '#91eae4'],
];

export async function generateCover(title, author, format) {
  const canvas = document.createElement('canvas');
  canvas.width = COVER_W;
  canvas.height = COVER_H;
  const ctx = canvas.getContext('2d');
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const [c1, c2] = PALETTES[hash % PALETTES.length];

  const grad = ctx.createLinearGradient(0, 0, COVER_W, COVER_H);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, COVER_W, COVER_H);

  // 半透明大字水印
  const first = [...String(title).trim()][0] || '书';
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#fff';
  ctx.font = '900 420px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(first, COVER_W - 10, COVER_H - 10);
  ctx.restore();

  // 顶部书脊高光
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(0, 0, 14, COVER_H);

  // 标题（最多 4 行）
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '700 54px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
  const lines = wrapText(ctx, title, COVER_W - 96, 4);
  let y = 72;
  for (const line of lines) {
    ctx.fillText(line, 48, y);
    y += 74;
  }
  if (author) {
    ctx.globalAlpha = 0.85;
    ctx.font = '400 30px system-ui, "PingFang SC", sans-serif';
    ctx.fillText(wrapText(ctx, author, COVER_W - 96, 1)[0] || '', 48, y + 18);
    ctx.globalAlpha = 1;
  }

  // 底部格式徽标
  const label = String(format || '').toUpperCase();
  if (label) {
    ctx.font = '600 24px system-ui, sans-serif';
    const w = ctx.measureText(label).width + 28;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    roundRect(ctx, 44, COVER_H - 74, w, 42, 21);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 58, COVER_H - 52);
  }
  return canvasToBlob(canvas);
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines - 1) break;
    } else {
      line += ch;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length && line) lines[maxLines - 1] = lines[maxLines - 1] || line;
  if (!lines.length) lines.push('未命名');
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
}

// 统一封面：有内嵌封面则重编码为 JPEG（去元数据、统一格式），否则生成
export async function buildCoverBlob(meta) {
  if (meta.cover) {
    try {
      const bmp = await createImageBitmap(meta.cover);
      const canvas = document.createElement('canvas');
      const scale = Math.min(COVER_W / bmp.width, COVER_H / bmp.height, 1);
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      return await canvasToBlob(canvas);
    } catch {
      /* 重编码失败则使用原图 */
      return meta.cover;
    }
  }
  return generateCover(meta.title, meta.author, meta.format);
}
