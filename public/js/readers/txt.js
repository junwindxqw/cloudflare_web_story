// TXT 阅读器：UTF-8/GBK 自动识别 + 分栏分页 + 章节目录
import { bookPath } from '../common.js';

const GAP = 48;
const RTHEME = {
  light: { bg: '#ffffff', fg: '#1f2328' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636' },
  dark: { bg: '#15171c', fg: '#b8bdc7' },
};
const CHAPTER_RE = /^\s*(第[0-9〇零一二三四五六七八九十百千万两]+[章节回卷集部篇]|Chapter\s+\d+|CHAPTER\s+[-\d]+|序章?|楔子|前言|后记|尾声|附录[一二三四五六七八九十]?)\s*.{0,50}$/;

function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  // BOM 探测
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.slice(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.slice(2));
  // 严格 UTF-8，失败则回退 GB18030（中文 TXT 常见编码）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

export async function init(ctx) {
  const res = await fetch(bookPath(ctx.id, 'file'));
  if (!res.ok) throw new Error('书籍文件加载失败');
  const text = decodeText(await res.arrayBuffer());

  const stage = ctx.host;
  const content = document.createElement('div');
  content.id = 'txt-content';
  stage.append(content);

  // 构建正文与章节
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tocItems = [];
  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, ' ');
    if (!line.trim()) continue;
    if (line.length <= 60 && CHAPTER_RE.test(line.trim())) {
      const h = document.createElement('h2');
      h.textContent = line.trim();
      content.append(h);
      tocItems.push({ el: h, label: line.trim() });
    } else {
      const p = document.createElement('p');
      p.textContent = line;
      content.append(p);
    }
  }
  if (!content.childElementCount) {
    const p = document.createElement('p');
    p.textContent = text || '（空文件）';
    content.append(p);
  }
  ctx.setToc(tocItems.map((t) => ({ label: t.label, target: t.label, level: 0 })));

  let page = 0;
  let totalPages = 1;
  let step = 1;
  let fontSize = ctx.getFontSize();

  function applyStyle() {
    const t = RTHEME[ctx.getTheme()] || RTHEME.light;
    stage.style.background = t.bg;
    stage.style.color = t.fg;
    content.style.background = t.bg;
    content.style.color = t.fg;
    fontSize = ctx.getFontSize();
    content.style.fontSize = fontSize + 'px';
    content.style.lineHeight = ctx.getLineHeight();
    content.style.fontFamily = ctx.getFontFamily();
    const w = stage.clientWidth - 32;
    content.style.width = w + 'px';
    content.style.columnWidth = w + 'px';
    content.style.columnGap = GAP + 'px';
    content.style.padding = '16px 0 24px';
    stage.style.overflow = 'hidden';
    step = w + GAP;
  }

  function recompute() {
    totalPages = Math.max(1, Math.round((content.scrollWidth + GAP) / step));
  }

  function render() {
    content.style.transform = `translateX(${-page * step + 16}px)`;
    content.style.transition = 'transform 0.22s ease';
  }

  function report(label) {
    // 首页 0%、末页 100%，与 foliate 引擎一致；续读按比例恢复也因此更准
    const frac = totalPages > 1 ? page / (totalPages - 1) : 0;
    ctx.progress({
      fraction: frac,
      location: { page, total: totalPages, fraction: frac },
      label: label || `${page + 1} / ${totalPages} 页`,
    });
  }

  function goToPage(n, label) {
    page = Math.max(0, Math.min(totalPages - 1, n));
    render();
    report(label);
  }

  applyStyle();
  recompute();

  // 续读：按比例恢复
  const resumeFrac = ctx.resume?.fraction || (ctx.resume?.total ? (ctx.resume.page || 0) / ctx.resume.total : 0);
  page = resumeFrac > 0 ? Math.round(resumeFrac * (totalPages - 1)) : 0;
  render();
  report();

  // 章节定位（offsetLeft 是布局坐标，不受 transform 影响）
  function chapterPage(el) {
    return Math.max(0, Math.round((el.offsetLeft - 16) / step));
  }

  // 交互：点击左右 1/3 翻页，中间呼出工具栏；触摸滑动翻页
  const app = stage.closest('.reader-app');
  let touchX = null;
  let touchY = null;
  stage.addEventListener('click', (e) => {
    const x = e.clientX;
    if (x < innerWidth * 0.3) goToPage(page - 1);
    else if (x > innerWidth * 0.7) goToPage(page + 1);
    else app.classList.toggle('chrome-hidden');
  });
  stage.addEventListener('touchstart', (e) => {
    touchX = e.touches[0]?.clientX ?? null;
    touchY = e.touches[0]?.clientY ?? null;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX;
    const dy = (e.changedTouches[0]?.clientY ?? touchY ?? 0) - (touchY ?? 0);
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      goToPage(dx < 0 ? page + 1 : page - 1);
    }
    touchX = touchY = null;
  }, { passive: true });

  // 字号 / 主题 / 尺寸变化
  ctx.showTextRows(true);
  ctx.showZoomRow(false);
  const ro = new ResizeObserver(() => {
    const frac = totalPages > 1 ? page / (totalPages - 1) : 0;
    applyStyle();
    recompute();
    page = Math.round(frac * (totalPages - 1));
    render();
    report();
  });
  ro.observe(stage);

  const modApi = {
    prev: () => goToPage(page - 1),
    next: () => goToPage(page + 1),
    async jumpToFraction(frac) {
      goToPage(Math.round(frac * (totalPages - 1)));
    },
    goTo(target) {
      const item = tocItems.find((t) => t.label === target);
      if (item) goToPage(chapterPage(item.el));
    },
    applyTheme() {
      applyStyle();
      render();
    },
    applyTextStyle() {
      const frac = totalPages > 1 ? page / (totalPages - 1) : 0;
      applyStyle();
      recompute();
      page = Math.round(frac * (totalPages - 1));
      render();
      report();
    },
  };
  return modApi;
}
