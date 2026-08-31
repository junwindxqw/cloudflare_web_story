// 登录页逻辑：登录 / 注册（邮箱验证码）/ 找回密码 三种视图
import { api, toast } from './common.js';

const errEl = document.getElementById('auth-error');
const params = new URLSearchParams(location.search);
const next = params.get('next');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const views = ['login', 'register', 'forgot'];
let currentView = 'login';

function showError(msg) {
  errEl.textContent = msg;
  errEl.hidden = false;
}
function hideError() {
  errEl.hidden = true;
}

function switchView(name) {
  currentView = name;
  hideError();
  for (const v of views) {
    document.getElementById('view-' + v).hidden = v !== name;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === name);
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
}
document.getElementById('to-forgot').addEventListener('click', (e) => {
  e.preventDefault();
  switchView('forgot');
});
document.getElementById('to-login').addEventListener('click', (e) => {
  e.preventDefault();
  switchView('login');
});

function redirectAfterAuth() {
  const target = next && next.startsWith('/') ? next : '/';
  location.replace(target);
}

/* ---------- 验证码发送（60 秒倒计时） ---------- */
const SEND_API = { register: '/api/auth/register-request', reset: '/api/auth/forgot' };

async function sendCode(purpose, form, btn) {
  const email = form.querySelector('[name="email"]').value.trim();
  if (!email.match(EMAIL_RE)) {
    showError('请先输入正确的邮箱地址');
    return;
  }
  hideError();
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '发送中…';
  try {
    const resp = await api(SEND_API[purpose], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    toast('验证码已发送，请查收邮箱（10 分钟内有效）', 'ok');
    if (resp.devCode) toast(`本地调试验证码：${resp.devCode}`);
    let left = resp.cooldown || 60;
    btn.textContent = `${left}s`;
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = original;
      } else {
        btn.textContent = `${left}s`;
      }
    }, 1000);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    showError(err.message);
  }
}

for (const btn of document.querySelectorAll('.send-btn')) {
  btn.addEventListener('click', () => sendCode(btn.dataset.send, btn.closest('form'), btn));
}

/* ---------- 登录 ---------- */
document.getElementById('view-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const form = e.target;
  const btn = form.querySelector('.submit-btn');
  btn.disabled = true;
  try {
    await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.querySelector('[name="email"]').value.trim(),
        password: form.querySelector('[name="password"]').value,
      }),
    });
    redirectAfterAuth();
  } catch (err) {
    showError(err.message);
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
    btn.disabled = false;
  }
});

/* ---------- 注册 ---------- */
document.getElementById('view-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const form = e.target;
  const btn = form.querySelector('.submit-btn');
  btn.disabled = true;
  try {
    const resp = await api('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.querySelector('[name="email"]').value.trim(),
        code: form.querySelector('[name="code"]').value.trim(),
        password: form.querySelector('[name="password"]').value,
      }),
    });
    toast(resp.first ? '注册成功，你已成为管理员' : '注册成功，欢迎来到书阁', 'ok');
    redirectAfterAuth();
  } catch (err) {
    showError(err.message);
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
    btn.disabled = false;
  }
});

/* ---------- 找回密码 ---------- */
document.getElementById('view-forgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const form = e.target;
  const btn = form.querySelector('.submit-btn');
  btn.disabled = true;
  try {
    await api('/api/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.querySelector('[name="email"]').value.trim(),
        code: form.querySelector('[name="code"]').value.trim(),
        password: form.querySelector('[name="password"]').value,
      }),
    });
    toast('密码已重置，已自动登录', 'ok');
    redirectAfterAuth();
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
  }
});

// 服务端已确认未登录才会渲染此页；这里无需额外检查
switchView('login');
