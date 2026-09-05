// TXT 阅读器：UTF-8/GBK 自动识别 + 章节目录 + 左右翻页 / 上下滚动两种阅读方式
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

  let mode = ctx.getReadingMode(); // 'paged'（左右翻页）| 'scroll'（上下滚动）
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
    content.style.padding = '16px 0 24px';
    if (mode === 'paged') {
      stage.style.overflow = 'hidden';
      content.style.height = '100%';
      content.style.margin = '0';
      content.style.columnWidth = w + 'px';
      content.style.columnGap = GAP + 'px';
      step = w + GAP;
    } else {
      stage.style.overflowY = 'auto';
      stage.style.overflowX = 'hidden';
      stage.style.overscrollBehavior = 'contain';
      content.style.height = 'auto';
      content.style.margin = '0 auto';
      content.style.columnWidth = 'auto';
      content.style.columnGap = 'normal';
      content.style.transform = '';
    }
  }

  function recompute() {
    totalPages = Math.max(1, Math.round((content.scrollWidth + GAP) / step));
  }

  function render() {
    if (mode !== 'paged') return;
    content.style.transform = `translateX(${-page * step + 16}px)`;
    content.style.transition = 'transform 0.22s ease';
  }

  // 两种模式统一用比例表示进度，续读/跳转因此与阅读方式无关
  const pagedFraction = () => (totalPages > 1 ? page / (totalPages - 1) : 0);
  function scrollFraction() {
    const max = stage.scrollHeight - stage.clientHeight;
    return max > 0 ? Math.min(1, Math.max(0, stage.scrollTop / max)) : 0;
  }
  const currentFraction = () => (mode === 'paged' ? pagedFraction() : scrollFraction());
  // 滚动模式下按比例恢复位置
  function restoreFraction(frac) {
    if (mode === 'paged') {
      page = Math.round(frac * (totalPages - 1));
      render();
    } else {
      stage.scrollTop = frac * (stage.scrollHeight - stage.clientHeight);
    }
  }

  function report(label) {
    const frac = currentFraction();
    // 翻页模式：首页 0%、末页 100%，与 foliate 引擎一致；续读按比例恢复也因此更准
    ctx.progress({
      fraction: frac,
      location: mode === 'paged' ? { page, total: totalPages, fraction: frac } : { fraction: frac },
      label: label || (mode === 'paged' ? `${page + 1} / ${totalPages} 页` : `${Math.round(frac * 100)}%`),
    });
  }

  function goToPage(n, label) {
    page = Math.max(0, Math.min(totalPages - 1, n));
    render();
    report(label);
  }

  // 滚动模式下翻一屏
  function scrollByScreen(dir) {
    stage.scrollBy({ top: dir * stage.clientHeight * 0.85, behavior: 'smooth' });
  }

  applyStyle();
  if (mode === 'paged') recompute();

  // 续读：按比例恢复
  const resumeFrac = ctx.resume?.fraction || (ctx.resume?.total ? (ctx.resume.page || 0) / ctx.resume.total : 0);
  restoreFraction(Math.max(0, resumeFrac));
  report();

  // 章节定位（offsetLeft/offsetTop 是布局坐标，不受 transform 影响）
  function chapterPos(el) {
    return mode === 'paged'
      ? Math.max(0, Math.round((el.offsetLeft - 16) / step))
      : Math.max(0, el.offsetTop - 16);
  }

  // 交互：点击左右 1/3 翻页（滚动模式为翻一屏），中间呼出工具栏；翻页模式支持触摸滑动翻页
  let touchX = null;
  let touchY = null;
  stage.addEventListener('click', (e) => {
    const x = e.clientX;
    if (x < innerWidth * 0.3) mode === 'paged' ? goToPage(page - 1) : scrollByScreen(-1);
    else if (x > innerWidth * 0.7) mode === 'paged' ? goToPage(page + 1) : scrollByScreen(1);
    else ctx.toggleChrome();
  });
  stage.addEventListener('touchstart', (e) => {
    touchX = e.touches[0]?.clientX ?? null;
    touchY = e.touches[0]?.clientY ?? null;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX;
    const dy = (e.changedTouches[0]?.clientY ?? touchY ?? 0) - (touchY ?? 0);
    if (mode === 'paged' && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      goToPage(dx < 0 ? page + 1 : page - 1);
    }
    touchX = touchY = null;
  }, { passive: true });

  // 滚动模式下滚动即进度
  let scrollRaf = 0;
  stage.addEventListener('scroll', () => {
    if (mode !== 'scroll' || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      report();
    });
  }, { passive: true });

  // 字号 / 主题 / 尺寸 / 阅读方式变化
  ctx.showTextRows(true);
  ctx.showZoomRow(false);
  ctx.showModeRow(true);
  const ro = new ResizeObserver(() => {
    const frac = currentFraction();
    applyStyle();
    if (mode === 'paged') recompute();
    restoreFraction(frac);
    report();
  });
  ro.observe(stage);

  const modApi = {
    prev: () => (mode === 'paged' ? goToPage(page - 1) : scrollByScreen(-1)),
    next: () => (mode === 'paged' ? goToPage(page + 1) : scrollByScreen(1)),
    async jumpToFraction(frac) {
      if (mode === 'paged') goToPage(Math.round(frac * (totalPages - 1)));
      else {
        restoreFraction(frac);
        report();
      }
    },
    goTo(target) {
      const item = tocItems.find((t) => t.label === target);
      if (!item) return;
      if (mode === 'paged') goToPage(chapterPos(item.el));
      else stage.scrollTop = chapterPos(item.el);
    },
    applyTheme() {
      applyStyle();
      render();
    },
    applyTextStyle() {
      const frac = currentFraction();
      applyStyle();
      if (mode === 'paged') recompute();
      restoreFraction(frac);
      report();
    },
    applyMode() {
      const frac = currentFraction();
      mode = ctx.getReadingMode();
      applyStyle();
      if (mode === 'paged') recompute();
      restoreFraction(frac);
      report();
    },
  };
  return modApi;
}
