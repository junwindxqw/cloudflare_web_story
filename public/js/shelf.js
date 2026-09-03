// 书架页逻辑：列表渲染、上传、删除、进度、搜索、分类筛选
import { api, toast, confirmDialog, formatSize, timeAgo, initTheme, toggleTheme, CATEGORIES } from './common.js';
import { extractMeta, buildCoverBlob, generateCover, extOf, SUPPORTED_EXTS } from './metadata.js';

let books = [];
let filterText = '';
let filterCategory = 'all';

const grid = document.getElementById('book-grid');
const emptyState = document.getElementById('empty-state');
const fileInput = document.getElementById('file-input');
const statsEl = document.getElementById('shelf-stats');

initTheme();
bindEvents();
loadBooks();
loadMe();

async function loadMe() {
  try {
    const me = await api('/api/auth/me');
    const chip = document.getElementById('user-chip');
    document.getElementById('user-email').textContent = me.email;
    document.getElementById('user-role').hidden = me.role !== 'admin';
    chip.hidden = false;
    chip.title = me.role === 'admin' ? '管理员（可管理全部书籍）' : me.email;
  } catch {
    /* 未登录时页面已被服务端重定向 */
  }
}

/* ---------- 数据 ---------- */
async function loadBooks() {
  try {
    const data = await api('/api/books');
    books = data.books || [];
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function updateStats() {
  const totalSize = books.reduce((s, b) => s + (b.size || 0), 0);
  statsEl.textContent = books.length
    ? `共 ${books.length} 本 · ${formatSize(totalSize)}`
    : '我的书架';
}

/* ---------- 渲染 ---------- */
function visibleBooks() {
  let list = books;
  if (filterCategory !== 'all') {
    list = list.filter((b) => (b.category || 'other') === filterCategory);
  }
  if (filterText) {
    const q = filterText.toLowerCase();
    list = list.filter(
      (b) => b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)
    );
  }
  return list;
}

function render() {
  updateStats();
  const list = visibleBooks();
  emptyState.hidden = books.length > 0;
  grid.textContent = '';
  for (const book of list) {
    grid.append(cardEl(book));
  }
  renderResume();
  renderCategoryBar();
}

/* ---------- 分类筛选条 ---------- */
function renderCategoryBar() {
  const bar = document.getElementById('category-bar');
  if (!bar) return;
  bar.textContent = '';
  // 书架为空时不显示
  if (!books.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  // 统计每个分类的数量
  const counts = new Map();
  for (const b of books) counts.set(b.category || 'other', (counts.get(b.category || 'other') || 0) + 1);
  const items = [{ id: 'all', label: '全部', count: books.length }];
  // 只展示至少一本书的分类（保持横条紧凑）
  for (const c of CATEGORIES) {
    const n = counts.get(c.id) || 0;
    if (n > 0) items.push({ id: c.id, label: c.label, count: n });
  }
  for (const it of items) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'category-chip' + (filterCategory === it.id ? ' active' : '');
    chip.dataset.id = it.id;
    const label = document.createElement('span');
    label.textContent = it.label;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = it.count;
    chip.append(label, count);
    chip.addEventListener('click', () => {
      filterCategory = it.id;
      render();
    });
    bar.append(chip);
  }
}

/* ---------- 继续阅读 ---------- */
function renderResume() {
  const strip = document.getElementById('resume-strip');
  const card = document.getElementById('resume-card');
  // 只展示有进度、未读完的最近一本
  const candidates = books.filter((b) => b.progress > 0 && b.progress < 1 && b.lastReadAt);
  if (!candidates.length) {
    strip.hidden = true;
    return;
  }
  const target = [...candidates].sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))[0];
  strip.hidden = false;
  card.dataset.id = target.id;
  card.href = `/read/${target.id}`;
  card.querySelector('.resume-title').textContent = target.title;
  card.querySelector('.resume-pct').textContent = `读到 ${Math.round(target.progress * 100)}%`;
  card.querySelector('.resume-progress i').style.width = Math.round(target.progress * 100) + '%';
  const coverEl = card.querySelector('.resume-cover');
  coverEl.textContent = '';
  const img = document.createElement('img');
  img.alt = target.title;
  img.src = target.hasCover ? `/api/books/${target.id}/cover` : '';
  if (!target.hasCover) fillGeneratedCover(img, target);
  img.onerror = () => fillGeneratedCover(img, target);
  coverEl.append(img);
}

function cardEl(book) {
  const card = document.createElement('article');
  card.className = 'book-card';
  card.dataset.id = book.id;

  const coverWrap = document.createElement('div');
  coverWrap.className = 'cover-wrap';

  const img = document.createElement('img');
  img.alt = book.title;
  img.loading = 'lazy';
  img.src = book.hasCover ? `/api/books/${book.id}/cover` : '';
  if (!book.hasCover) fillGeneratedCover(img, book);
  img.onerror = () => fillGeneratedCover(img, book);
  coverWrap.append(img);

  const chip = document.createElement('span');
  chip.className = 'format-chip';
  chip.textContent = book.format.toUpperCase();
  coverWrap.append(chip);

  const menuBtn = document.createElement('button');
  menuBtn.className = 'menu-btn';
  menuBtn.title = '更多操作';
  menuBtn.setAttribute('aria-label', '更多操作');
  menuBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(book, menuBtn);
  });
  coverWrap.append(menuBtn);

  if (book.progress > 0) {
    const rail = document.createElement('div');
    rail.className = 'progress-rail';
    const bar = document.createElement('i');
    bar.style.width = Math.round(book.progress * 100) + '%';
    rail.append(bar);
    coverWrap.append(rail);
  }

  const meta = document.createElement('div');
  meta.className = 'book-meta';
  const title = document.createElement('h3');
  title.className = 'book-title';
  title.textContent = book.title;
  const author = document.createElement('p');
  author.className = 'book-author';
  author.textContent = book.author || '佚名';
  const sub = document.createElement('p');
  sub.className = 'book-sub';
  if (book.progress > 0 && book.progress < 1) {
    const pct = document.createElement('span');
    pct.className = 'reading';
    pct.textContent = `读到 ${Math.round(book.progress * 100)}%`;
    sub.append(pct);
  } else if (book.progress >= 1) {
    const done = document.createElement('span');
    done.className = 'reading';
    done.textContent = '已读完';
    sub.append(done);
  }
  const time = document.createElement('span');
  time.textContent = book.lastReadAt ? timeAgo(book.lastReadAt) : timeAgo(book.addedAt);
  sub.append(time);
  meta.append(title, author, sub);

  card.append(coverWrap, meta);
  card.addEventListener('click', () => {
    location.href = `/read/${book.id}`;
  });
  // 移动端长按 = 菜单：触发距离 > 12px 视为滚动，立即取消，避免误触
  let pressTimer;
  let pressStart = null;
  const PRESS_MS = 700;
  const PRESS_SLOP = 12;
  card.addEventListener('touchstart', (e) => {
    pressStart = e.touches[0];
    pressTimer = setTimeout(() => {
      pressTimer = null;
      openMenu(book, menuBtn);
    }, PRESS_MS);
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (!pressStart || !pressTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - pressStart.clientX) > PRESS_SLOP || Math.abs(t.clientY - pressStart.clientY) > PRESS_SLOP) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }, { passive: true });
  card.addEventListener('touchend', () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    pressStart = null;
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(book, menuBtn);
  });
  return card;
}

const coverCache = new Map();
async function fillGeneratedCover(img, book) {
  if (!coverCache.has(book.id)) {
    coverCache.set(book.id, generateCover(book.title, book.author, book.format).then((b) => URL.createObjectURL(b)));
  }
  try {
    img.src = await coverCache.get(book.id);
  } catch {
    /* 忽略 */
  }
}

/* ---------- 菜单 ---------- */
const menuEl = document.getElementById('book-menu');
const menuMask = document.getElementById('menu-mask');

function openMenu(book, anchor) {
  menuEl.textContent = '';
  const items = [
    {
      label: '继续阅读',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
      run: () => (location.href = `/read/${book.id}`),
    },
    ...(book.progress > 0
      ? [{
          label: '从头开始',
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
          run: async () => {
            await api(`/api/books/${book.id}/progress`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ progress: 0, location: '' }),
            });
            toast('已重置阅读进度', 'ok');
            loadBooks();
          },
        }]
      : []),
    {
      label: '修改分类',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/></svg>',
      run: async () => {
        const choice = await pickCategory(book.category || 'other');
        if (!choice || choice === book.category) return;
        await api(`/api/books/${book.id}/category`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: choice }),
        });
        const target = books.find((b) => b.id === book.id);
        if (target) target.category = choice;
        render();
        toast('已更新分类', 'ok');
      },
    },
    {
      label: '彻底删除',
      danger: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>',
      run: () => removeBook(book),
    },
  ];
  for (const it of items) {
    const btn = document.createElement('button');
    if (it.danger) btn.className = 'danger';
    btn.innerHTML = it.icon + '<span></span>';
    btn.querySelector('span').textContent = it.label;
    btn.onclick = async () => {
      closeMenu();
      try {
        await it.run();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    menuEl.append(btn);
  }

  const rect = anchor.getBoundingClientRect();
  menuEl.hidden = false;
  menuMask.hidden = false;
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  let x = Math.min(Math.max(8, rect.left + rect.width / 2 - mw / 2), innerWidth - mw - 8);
  let y = rect.bottom + 6;
  if (y + mh > innerHeight - 8) y = Math.max(8, rect.top - mh - 6);
  menuEl.style.left = x + 'px';
  menuEl.style.top = y + 'px';
}

function closeMenu() {
  menuEl.hidden = true;
  menuMask.hidden = true;
}
menuMask.addEventListener('click', closeMenu);

// 分类选择器：以 context-menu 形态弹出；返回所选分类 id 或 null
function pickCategory(currentId) {
  return new Promise((resolve) => {
    const mask = document.getElementById('menu-mask');
    const list = document.createElement('div');
    list.className = 'context-menu category-picker';
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      list.remove();
      mask.hidden = true;
      mask.removeEventListener('click', onMask);
    };
    const onMask = () => {
      cleanup();
      resolve(null);
    };
    mask.addEventListener('click', onMask);
    for (const c of CATEGORIES) {
      const btn = document.createElement('button');
      if (c.id === currentId) btn.className = 'active';
      const label = document.createElement('span');
      label.textContent = c.label;
      btn.append(label);
      if (c.id === currentId) {
        const mark = document.createElement('i');
        mark.textContent = '✓';
        btn.append(mark);
      }
      btn.addEventListener('click', () => {
        cleanup();
        resolve(c.id);
      });
      list.append(btn);
    }
    // 取消项（用普通样式，不要被 .danger 染红）
    const cancel = document.createElement('button');
    cancel.className = 'category-cancel';
    const cancelLabel = document.createElement('span');
    cancelLabel.textContent = '取消';
    cancel.append(cancelLabel);
    cancel.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    list.append(cancel);

    // 居中显示
    document.body.append(list);
    list.hidden = false;
    mask.hidden = false;
    const r = list.getBoundingClientRect();
    const x = Math.max(8, (innerWidth - r.width) / 2);
    const y = Math.max(8, (innerHeight - r.height) / 3);
    list.style.left = x + 'px';
    list.style.top = y + 'px';
  });
}

async function removeBook(book) {
  const ok = await confirmDialog({
    title: '彻底删除这本书？',
    message: `《${book.title}》将从服务器上永久删除（包括原文件与封面），此操作不可恢复。`,
    confirmText: '永久删除',
  });
  if (!ok) return;
  try {
    await api(`/api/books/${book.id}`, { method: 'DELETE' });
    books = books.filter((b) => b.id !== book.id);
    coverCache.delete(book.id);
    render();
    toast('已从服务器删除', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- 上传 ---------- */
function bindEvents() {
  document.getElementById('fab-btn').addEventListener('click', () => fileInput.click());
  document.getElementById('upload-btn-top').addEventListener('click', () => fileInput.click());
  document.getElementById('upload-btn-empty').addEventListener('click', () => fileInput.click());
  const classifyBtn = document.getElementById('classify-btn-top');
  if (classifyBtn) classifyBtn.addEventListener('click', classifyAll);
  document.getElementById('theme-btn').addEventListener('click', toggleTheme);
  document.getElementById('upload-close').addEventListener('click', () => {
    document.getElementById('upload-panel').hidden = true;
  });
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* 忽略 */
    }
    location.href = '/login';
  });
  document.getElementById('search-input').addEventListener('input', (e) => {
    filterText = e.target.value.trim();
    render();
  });
  // 移动端搜索切换：点击放大镜展开搜索框；点 × 收起；收起时若已有过滤词则清空
  const searchToggle = document.getElementById('search-toggle');
  const searchBox = document.getElementById('search-box');
  const searchClose = document.getElementById('search-close');
  const searchInput = document.getElementById('search-input');
  if (searchToggle && searchBox) {
    searchToggle.addEventListener('click', () => {
      searchBox.classList.add('open');
      searchInput.focus();
    });
    searchClose.addEventListener('click', () => {
      searchBox.classList.remove('open');
      if (filterText) {
        searchInput.value = '';
        filterText = '';
        render();
      }
    });
  }
  fileInput.addEventListener('change', () => {
    handleFiles([...fileInput.files]);
    fileInput.value = '';
  });
}

async function handleFiles(files) {
  const valid = files.filter((f) => SUPPORTED_EXTS.includes(extOf(f.name)));
  const rejected = files.length - valid.length;
  if (rejected > 0) toast(`已跳过 ${rejected} 个不支持的文件`, 'error');
  if (!valid.length) return;

  const panel = document.getElementById('upload-panel');
  const list = document.getElementById('upload-list');
  panel.hidden = false;

  for (const file of valid) {
    const item = document.createElement('div');
    item.className = 'upload-item';
    const name = document.createElement('div');
    name.className = 'u-name';
    name.textContent = file.name;
    const bar = document.createElement('div');
    bar.className = 'u-bar';
    const barFill = document.createElement('i');
    bar.append(barFill);
    const status = document.createElement('div');
    status.className = 'u-status';
    status.textContent = '准备中…';
    item.append(name, bar, status);
    list.prepend(item);

    try {
      const meta = await extractMeta(file);
      status.textContent = '解析完成，上传中…';
      const book = await uploadFile(file, meta, (pct) => {
        barFill.style.width = Math.round(pct * 100) + '%';
        status.textContent = `上传中 ${Math.round(pct * 100)}%`;
      });
      try {
        const cover = await buildCoverBlob(meta);
        await fetch(`/api/books/${book.id}/cover`, { method: 'POST', body: cover, headers: { 'Content-Type': 'image/jpeg' } });
      } catch (e) {
        console.warn('封面上传失败（不影响书籍）：', e);
      }
      item.classList.add('done');
      barFill.style.width = '100%';
      status.textContent = '导入成功';
      books.unshift({
        id: book.id,
        title: book.title,
        author: book.author,
        format: book.format,
        size: book.size,
        addedAt: book.addedAt,
        progress: 0,
        lastReadAt: null,
        hasCover: true,
        category: book.category || 'other',
      });
      render();
    } catch (e) {
      item.classList.add('fail');
      barFill.style.width = '100%';
      status.textContent = e.message || '导入失败';
    }
  }
}

async function classifyAll() {
  if (!books.length) return;
  const ok = await confirmDialog({
    title: '一键自动重分类？',
    message: `将根据书名与作者重新识别全部 ${books.length} 本书的分类；已手动调整的书也会被覆盖。`,
    confirmText: '开始重分类',
  });
  if (!ok) return;
  try {
    const data = await api('/api/books/classify-all', { method: 'POST' });
    await loadBooks();
    toast(`已为 ${data.updated} / ${data.total} 本书更新分类`, 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function uploadFile(file, meta, onProgress) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({
      title: meta.title || '未命名书籍',
      author: meta.author || '',
      format: meta.format,
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/books?' + q.toString());
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 忽略 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `上传失败（${xhr.status}）`));
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(file);
  });
}
