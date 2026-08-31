// 阅读器编排：通用 UI（进度条、目录、设置）+ 按格式分发到具体渲染模块
import { api, toast } from './common.js';

// 从 /read/:id 路径提取书籍 ID
const OK_ID = /^[\w-]{1,64}$/;
const id = location.pathname.match(/^\/read\/([\w-]+)/)?.[1] || new URLSearchParams(location.search).get('id');
if (!id) location.replace('/');

const $ = (s) => document.querySelector(s);
const app = $('#app');
const viewer = $('#viewer');
const titleEl = $('#reader-title');
const slider = $('#progress-slider');
const labelEl = $('#progress-label');
const tocBtn = $('#toc-btn');
const settingsBtn = $('#settings-btn');
const loadTip = $('#load-tip');
const drawer = $('#toc-drawer');
const drawerMask = $('#drawer-mask');
const sheet = $('#settings-sheet');
const sheetMask = $('#sheet-mask');

const THEME_KEY = 'ws_rtheme';
const FONT_KEY = 'ws_rfont';

let book = null;
let mod = null; // 当前格式模块
let current = { fraction: 0, location: {} };
let dirty = false;
let dragging = false;

/* ---------- 阅读偏好 ---------- */
export function getReaderTheme() {
  const t = localStorage.getItem(THEME_KEY);
  return t === 'sepia' || t === 'dark' ? t : 'light';
}
export function getFontSize() {
  const n = Number(localStorage.getItem(FONT_KEY));
  return n >= 14 && n <= 30 ? n : 18;
}

const ctx = {
  id,
  book: null,
  host: viewer,
  getTheme: getReaderTheme,
  getFontSize,
  // 渲染模块汇报进度
  progress({ fraction = 0, location = {}, label, tocCurrent }) {
    current.fraction = Math.max(0, Math.min(1, fraction));
    current.location = location;
    dirty = true;
    labelEl.textContent = label != null ? label : Math.round(current.fraction * 100) + '%';
    if (!dragging) slider.value = Math.round(current.fraction * 1000);
    if (tocCurrent) highlightToc(tocCurrent);
  },
  setToc(items) {
    if (!items || !items.length) {
      tocBtn.hidden = true;
      return;
    }
    tocBtn.hidden = false;
    buildToc(items);
  },
  setZoomLabel(text) {
    $('#zoom-label').textContent = text;
  },
  showFontRow(show) {
    $('#font-row').hidden = !show;
  },
  showZoomRow(show) {
    $('#zoom-row').hidden = !show;
  },
  toast,
};

/* ---------- 保存进度 ---------- */
async function saveNow(keepalive = false) {
  if (!dirty || !book) return;
  dirty = false;
  try {
    // 目标路径恒为静态常量；书籍 ID 经白名单校验后放入参数化 JSON body
    await fetch('/api/books/progress', {
      method: 'PUT',
      keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: OK_ID.test(book.id) ? book.id : '', progress: current.fraction, location: JSON.stringify(current.location) }),
    });
  } catch {
    /* 静默失败，下次再存 */
  }
}
setInterval(() => saveNow(), 6000);
addEventListener('pagehide', () => saveNow(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow(true);
});

/* ---------- 通用控件 ---------- */
function toggleChrome() {
  app.classList.toggle('chrome-hidden');
}

slider.addEventListener('input', () => {
  dragging = true;
  labelEl.textContent = Math.round((slider.value / 1000) * 100) + '%';
});
slider.addEventListener('change', async () => {
  dragging = false;
  const frac = slider.value / 1000;
  try {
    await mod.jumpToFraction(frac);
  } catch (e) {
    console.warn(e);
  }
});
$('#prev-btn').addEventListener('click', () => mod?.prev());
$('#next-btn').addEventListener('click', () => mod?.next());
$('#back-btn').addEventListener('click', () => {
  saveNow(true);
  location.href = '/';
});
tocBtn.addEventListener('click', openDrawer);
$('#toc-close').addEventListener('click', closeDrawer);
drawerMask.addEventListener('click', closeDrawer);
settingsBtn.addEventListener('click', () => {
  sheet.hidden = !sheet.hidden;
  sheetMask.hidden = sheet.hidden;
});
sheetMask.addEventListener('click', () => {
  sheet.hidden = true;
  sheetMask.hidden = true;
});
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') mod?.prev();
  else if (e.key === 'ArrowRight') mod?.next();
  else if (e.key === 'Escape') {
    closeDrawer();
    sheet.hidden = true;
    sheetMask.hidden = true;
  }
});

/* 目录 */
function buildToc(items) {
  const list = $('#toc-list');
  list.textContent = '';
  for (const it of items) {
    const btn = document.createElement('button');
    btn.className = 'toc-item';
    btn.style.paddingLeft = 18 + (it.level || 0) * 14 + 'px';
    btn.textContent = it.label;
    btn.dataset.target = it.target;
    btn.addEventListener('click', () => {
      closeDrawer();
      mod?.goTo(it.target);
    });
    list.append(btn);
  }
}
function highlightToc(target) {
  const list = $('#toc-list');
  let found = null;
  for (const el of list.children) {
    const on = el.dataset.target === target;
    el.classList.toggle('current', on);
    if (on) found = el;
  }
  if (found) {
    const r = found.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) found.scrollIntoView({ block: 'center' });
  }
}
function openDrawer() {
  drawer.classList.add('open');
  drawerMask.hidden = false;
  void drawerMask.offsetWidth;
  drawerMask.classList.add('show');
}
function closeDrawer() {
  drawer.classList.remove('open');
  drawerMask.classList.remove('show');
  setTimeout(() => (drawerMask.hidden = true), 260);
}

/* 设置面板 */
$('#theme-dots').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rtheme]');
  if (!btn) return;
  localStorage.setItem(THEME_KEY, btn.dataset.rtheme);
  applyReaderTheme();
  mod?.applyTheme();
  toast('主题已切换');
});
$('#font-plus').addEventListener('click', () => stepFont(1));
$('#font-minus').addEventListener('click', () => stepFont(-1));
function stepFont(d) {
  const n = Math.max(14, Math.min(30, getFontSize() + d));
  localStorage.setItem(FONT_KEY, String(n));
  $('#font-size-label').textContent = n;
  mod?.applyFontSize();
}
$('#zoom-in').addEventListener('click', () => mod?.zoomIn?.());
$('#zoom-out').addEventListener('click', () => mod?.zoomOut?.());

function applyReaderTheme() {
  document.body.dataset.rtheme = getReaderTheme();
  for (const b of document.querySelectorAll('#theme-dots button')) {
    b.classList.toggle('active', b.dataset.rtheme === getReaderTheme());
  }
}

/* ---------- 启动 ---------- */
async function start() {
  applyReaderTheme();
  $('#font-size-label').textContent = getFontSize();
  try {
    // ID 经白名单校验后放入参数化 JSON body，请求目标为静态常量
    book = await api('/api/books/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: OK_ID.test(id) ? id : '' }),
    });
  } catch {
    return;
  }
  ctx.book = book;
  document.title = `${book.title} · 书阁`;
  titleEl.textContent = book.title;
  let resume = null;
  try {
    resume = book.location ? JSON.parse(book.location) : null;
  } catch {
    resume = null;
  }
  ctx.resume = resume;
  if (resume && (resume.fraction > 0 || resume.cfi || resume.page > 1)) {
    toast(`继续上次阅读（${Math.round((resume.fraction || 0) * 100)}%）`);
  }

  const format = book.format;
  const loader =
    format === 'epub'
      ? import('./readers/epub.js')
      : format === 'pdf'
        ? import('./readers/pdf.js')
        : format === 'txt'
          ? import('./readers/txt.js')
          : import('./readers/foliate.js'); // mobi / azw3 / fb2 / cbz
  try {
    mod = await loader.then((m) => m.init(ctx));
  } catch (e) {
    console.error(e);
    loadTip.querySelector('p').textContent = '打开失败：' + (e.message || '未知错误');
    loadTip.querySelector('.spinner').remove();
    return;
  }
  setTimeout(() => loadTip.classList.add('gone'), 400);
}
start();
