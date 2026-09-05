// 阅读器编排：通用 UI（底部工具栏、目录/设置弹层、显隐调度）+ 按格式分发到具体渲染模块
import { api, bookIdFromLocation, toast } from './common.js';

// 从 /read/:id 路径提取书籍 ID（解析与白名单校验在 common.js 中完成）
const OK_ID = /^[\w-]{1,64}$/;
const id = bookIdFromLocation();
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
const tocSheet = $('#toc-sheet');
const sheet = $('#settings-sheet');
const sheetMask = $('#sheet-mask');

const THEME_KEY = 'ws_rtheme';
const FONT_KEY = 'ws_rfont';
const LH_KEY = 'ws_rlh';
const FAM_KEY = 'ws_rfam';
const MODE_KEY = 'ws_rmode';
const WAKE_KEY = 'ws_rwake';

// 底部菜单无操作自动隐藏的时长
const IDLE_HIDE_MS = 10000;

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
  if (n >= 14 && n <= 30) return n;
  // 未设置时：手机端默认 20（让小屏正文更易读），桌面端 18
  return Math.min(innerWidth || 1024, 720) < 720 ? 20 : 18;
}
export function getLineHeight() {
  const n = Number(localStorage.getItem(LH_KEY));
  return n === 1.6 || n === 2.2 ? n : 1.9;
}
// 返回字体栈；'默认' 返回空串表示不干预书籍自带字体
export function getFontFamily() {
  const v = localStorage.getItem(FAM_KEY);
  if (v === 'serif') return '"Noto Serif SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, serif';
  if (v === 'sans') return '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
  return '';
}
// 阅读方式：'paged'（左右翻页，默认）| 'scroll'（上下滚动）
export function getReadingMode() {
  return localStorage.getItem(MODE_KEY) === 'scroll' ? 'scroll' : 'paged';
}

const ctx = {
  id,
  book: null,
  host: viewer,
  getTheme: getReaderTheme,
  getFontSize,
  getLineHeight,
  getFontFamily,
  getReadingMode,
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
  // 字号 / 行距 / 字体三行随格式一并显示（PDF 等固定版式不显示）
  showTextRows(show) {
    $('#font-row').hidden = !show;
    $('#lh-row').hidden = !show;
    $('#fam-row').hidden = !show;
  },
  showZoomRow(show) {
    $('#zoom-row').hidden = !show;
  },
  // 阅读方式一行：仅可切换模式的格式显示（PDF 恒为滚动）
  showModeRow(show) {
    $('#mode-row').hidden = !show;
  },
  // 点击屏幕中间：切换底部菜单显隐
  toggleChrome,
  // 格式模块内的交互（iframe 内点击 / 滚动等）也要重置自动隐藏计时
  activity,
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

/* ---------- 底部菜单显隐：点击中间切换 + 10 秒无操作自动隐藏 ---------- */
const chromeVisible = () => !app.classList.contains('chrome-hidden');
let hideTimer = null;
function scheduleAutoHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    // 弹层打开或正在拖动进度条时不自动隐藏
    if (sheetOpen || dragging) return;
    app.classList.add('chrome-hidden');
  }, IDLE_HIDE_MS);
}
function toggleChrome(force) {
  const hide = force ?? chromeVisible();
  app.classList.toggle('chrome-hidden', hide);
  if (hide) {
    clearTimeout(hideTimer);
    hideTimer = null;
  } else {
    scheduleAutoHide();
  }
}
// 任何用户操作都重置 10 秒倒计时（菜单可见时才需要）
function activity() {
  if (chromeVisible()) scheduleAutoHide();
}
addEventListener('pointerdown', activity, true);
addEventListener('keydown', activity, true);
addEventListener('wheel', activity, { passive: true, capture: true });
addEventListener('touchstart', activity, { passive: true });
// scroll 不冒泡，但捕获阶段可命中各滚动容器（TXT/PDF 滚动层、foliate 分页容器）
addEventListener('scroll', activity, { passive: true, capture: true });
// 从后台切回时重新计时，避免挂起的定时器立即隐藏菜单
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && chromeVisible()) scheduleAutoHide();
});

/* ---------- 通用控件 ---------- */
slider.addEventListener('input', () => {
  dragging = true;
  labelEl.textContent = Math.round((slider.value / 1000) * 100) + '%';
});
slider.addEventListener('change', async () => {
  dragging = false;
  scheduleAutoHide();
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
tocBtn.addEventListener('click', () => showSheet('toc'));
$('#toc-close').addEventListener('click', closeSheets);
settingsBtn.addEventListener('click', () => showSheet('settings'));
sheetMask.addEventListener('click', closeSheets);
addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  // 空格 / 回车保留按钮、链接自身的激活行为
  if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.('button, a')) return;
  if (e.key === 'Escape') {
    closeSheets();
    return;
  }
  if (sheetOpen) return;
  switch (e.key) {
    case 'ArrowLeft':
    case 'PageUp':
      e.preventDefault();
      mod?.prev();
      break;
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
      e.preventDefault();
      mod?.next();
      break;
    case 'Home':
      e.preventDefault();
      mod?.jumpToFraction(0);
      break;
    case 'End':
      e.preventDefault();
      mod?.jumpToFraction(1);
      break;
  }
});

/* 目录 / 设置弹层（同一时间只开一个，共用遮罩） */
let sheetOpen = null;
let maskTimer = null;
function showSheet(which) {
  if (sheetOpen === which) return;
  sheetOpen = which;
  tocSheet.classList.toggle('open', which === 'toc');
  sheet.classList.toggle('open', which === 'settings');
  clearTimeout(maskTimer);
  sheetMask.hidden = false;
  void sheetMask.offsetWidth;
  sheetMask.classList.add('show');
  clearTimeout(hideTimer); // 弹层打开期间暂停自动隐藏
  hideTimer = null;
  if (which === 'toc') {
    // 打开时定位到当前章节
    tocSheet.querySelector('.toc-item.current')?.scrollIntoView({ block: 'center' });
  }
}
function closeSheets() {
  if (!sheetOpen) return;
  sheetOpen = null;
  tocSheet.classList.remove('open');
  sheet.classList.remove('open');
  sheetMask.classList.remove('show');
  clearTimeout(maskTimer);
  maskTimer = setTimeout(() => (sheetMask.hidden = true), 300);
  if (chromeVisible()) scheduleAutoHide();
}

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
      closeSheets();
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
  if (found && sheetOpen === 'toc') {
    const r = found.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) found.scrollIntoView({ block: 'center' });
  }
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
  mod?.applyTextStyle();
}
$('#lh-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lh]');
  if (!btn) return;
  localStorage.setItem(LH_KEY, btn.dataset.lh);
  syncTextPrefsUI();
  mod?.applyTextStyle();
  toast('行距已调整');
});
$('#fam-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-fam]');
  if (!btn) return;
  localStorage.setItem(FAM_KEY, btn.dataset.fam);
  syncTextPrefsUI();
  mod?.applyTextStyle();
  toast('字体已切换');
});
$('#mode-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  localStorage.setItem(MODE_KEY, btn.dataset.mode);
  syncModeUI();
  mod?.applyMode?.();
  toast(btn.dataset.mode === 'scroll' ? '已切换为上下滚动' : '已切换为左右翻页');
});
function syncTextPrefsUI() {
  const lh = String(getLineHeight());
  for (const b of document.querySelectorAll('#lh-seg button')) {
    b.classList.toggle('active', b.dataset.lh === lh);
  }
  const fam = localStorage.getItem(FAM_KEY) || 'default';
  for (const b of document.querySelectorAll('#fam-seg button')) {
    b.classList.toggle('active', b.dataset.fam === fam);
  }
}
function syncModeUI() {
  const m = getReadingMode();
  for (const b of document.querySelectorAll('#mode-seg button')) {
    b.classList.toggle('active', b.dataset.mode === m);
  }
}
$('#zoom-in').addEventListener('click', () => mod?.zoomIn?.());
$('#zoom-out').addEventListener('click', () => mod?.zoomOut?.());

/* ---------- 屏幕常亮（Wake Lock） ---------- */
let wakeLock = null;
async function syncWakeLock() {
  const want = localStorage.getItem(WAKE_KEY) === '1' && 'wakeLock' in navigator;
  try {
    if (want && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    /* 系统拒绝或不支持时静默跳过 */
  }
}
$('#wake-toggle').addEventListener('click', () => {
  if (!('wakeLock' in navigator)) {
    toast('当前浏览器不支持屏幕常亮', 'error');
    return;
  }
  const on = localStorage.getItem(WAKE_KEY) !== '1';
  localStorage.setItem(WAKE_KEY, on ? '1' : '0');
  syncWakeUI();
  syncWakeLock();
  toast(on ? '阅读期间屏幕将保持常亮' : '已关闭屏幕常亮');
});
function syncWakeUI() {
  $('#wake-toggle').setAttribute('aria-checked', String(localStorage.getItem(WAKE_KEY) === '1'));
}
// 页面重新可见时浏览器会要求重新申请锁
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncWakeLock();
});

function applyReaderTheme() {
  const t = getReaderTheme();
  document.body.dataset.rtheme = t;
  // 移动端浏览器地址栏 / 状态栏颜色跟随阅读背景
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', { light: '#ffffff', sepia: '#f4ecd8', dark: '#15171c' }[t]);
  for (const b of document.querySelectorAll('#theme-dots button')) {
    b.classList.toggle('active', b.dataset.rtheme === t);
  }
}

/* ---------- 启动 ---------- */
async function start() {
  applyReaderTheme();
  syncTextPrefsUI();
  syncModeUI();
  syncWakeUI();
  syncWakeLock();
  $('#font-size-label').textContent = getFontSize();
  toggleChrome(false); // 初始显示菜单，10 秒无操作后自动隐藏
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
