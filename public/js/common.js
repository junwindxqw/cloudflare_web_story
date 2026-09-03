// 公共工具：API 封装、主题、Toast、确认弹窗、格式化
export async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  // 认证接口的 401 属于正常业务错误（密码错误等），不自动跳转；数据接口 401 才回登录页
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = '/login?next=' + next;
    throw new Error('未登录');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非JSON响应 */
  }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
  return data;
}

// 书籍 API 路径构造：ID 走白名单校验 + 编码后再拼接，请求目标恒为本站 /api/books/*
export function bookPath(id, sub = '') {
  const clean = String(id);
  if (!/^[\w-]{1,64}$/.test(clean)) throw new Error('非法的书籍 ID');
  return '/api/books/' + encodeURIComponent(clean) + (sub ? '/' + sub : '');
}

// 从 /read/:id（兼容 ?id=）解析并校验书籍 ID；无有效 ID 返回 null
export function bookIdFromLocation() {
  const m = location.pathname.match(/^\/read\/([\w-]{1,64})/);
  if (m) return m[1];
  const q = new URLSearchParams(location.search).get('id');
  return q && /^[\w-]{1,64}$/.test(q) ? q : null;
}

/* ---------- 主题 ---------- */
const THEME_KEY = 'ws_theme';
export function getTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'dark' ? '#101318' : '#f4f5f7';
}
export function initTheme() {
  applyTheme(getTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(getTheme());
  });
}
export function toggleTheme() {
  const t = getTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
  return t;
}

/* ---------- Toast ---------- */
let toastBox;
export function toast(msg, type = '') {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.id = 'toast-box';
    document.body.append(toastBox);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  toastBox.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2400);
}

/* ---------- 确认弹窗 ---------- */
export function confirmDialog({ title, message, confirmText = '删除' }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" role="dialog">
        <h3></h3>
        <p></p>
        <div class="modal-actions">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn-danger" data-act="ok"></button>
        </div>
      </div>`;
    mask.querySelector('h3').textContent = title || '确认操作';
    mask.querySelector('p').textContent = message || '';
    const okBtn = mask.querySelector('[data-act="ok"]');
    okBtn.textContent = confirmText;
    const close = (val) => {
      mask.classList.remove('show');
      setTimeout(() => mask.remove(), 200);
      resolve(val);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) return close(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') return close(true);
      if (act === 'cancel') return close(false);
    });
    document.body.append(mask);
    // 强制一次样式冲刷后再加 show，保证过渡动画生效且不依赖 rAF（后台标签页 rAF 会被暂停）
    void mask.offsetWidth;
    mask.classList.add('show');
    okBtn.focus();
  });
}

/* ---------- 格式化 ---------- */
export function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
export function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = 60e3, hour = 3600e3, day = 86400e3;
  if (diff < min) return '刚刚';
  if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hour) + ' 小时前';
  if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------- 题材分类 ----------
 * 与 src/worker/books.js 中的 CATEGORIES 镜像一致；任一改动请同步 */
export const CATEGORIES = [
  { id: 'novel',     label: '小说' },
  { id: 'scifi',     label: '科幻' },
  { id: 'history',   label: '历史' },
  { id: 'computer',  label: '计算机' },
  { id: 'reference', label: '工具书' },
  { id: 'literature',label: '散文' },
  { id: 'magazine',  label: '杂志' },
  { id: 'other',     label: '其他' },
];
export function categoryLabel(id) {
  return CATEGORIES.find((c) => c.id === id)?.label ?? '其他';
}
