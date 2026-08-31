// 书架页逻辑：列表渲染、上传、删除、进度、搜索
import { api, toast, confirmDialog, formatSize, timeAgo, initTheme, toggleTheme } from './common.js';
import { extractMeta, buildCoverBlob, generateCover, extOf, SUPPORTED_EXTS } from './metadata.js';

let books = [];
let filterText = '';

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
  if (!filterText) return books;
  const q = filterText.toLowerCase();
  return books.filter(
    (b) => b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)
  );
}

function render() {
  updateStats();
  const list = visibleBooks();
  emptyState.hidden = books.length > 0;
  grid.textContent = '';
  for (const book of list) {
    grid.append(cardEl(book));
  }
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
  // 移动端长按 = 菜单
  let pressTimer;
  card.addEventListener('touchstart', () => {
    pressTimer = setTimeout(() => openMenu(book, menuBtn), 500);
  }, { passive: true });
  card.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });
  card.addEventListener('touchend', () => clearTimeout(pressTimer));
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
      });
      render();
    } catch (e) {
      item.classList.add('fail');
      barFill.style.width = '100%';
      status.textContent = e.message || '导入失败';
    }
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
