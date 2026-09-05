// MOBI / AZW3 / FB2 / CBZ 阅读器（foliate-js）
import { bookPath } from '../common.js';

const RTHEME = {
  light: { bg: '#ffffff', fg: '#1f2328' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636' },
  dark: { bg: '#15171c', fg: '#b8bdc7' },
};
const MIME = {
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  fb2: 'application/x-fictionbook+xml',
  cbz: 'application/vnd.comicbook+zip',
};

export async function init(ctx) {
  const { makeBook, View } = await import('/vendor/foliate-js/view.js');

  // 带正确扩展名的 File 才能让 foliate 正确识别格式（cbz/fb2 依赖文件名/类型）
  const res = await fetch(bookPath(ctx.id, 'file'));
  if (!res.ok) throw new Error('书籍文件加载失败');
  const blob = await res.blob();
  const ext = ctx.book.format || 'mobi';
  const file = new File([blob], `${ctx.book.id}.${ext}`, { type: MIME[ext] || '' });

  const fbook = await makeBook(file);

  const view = document.createElement('foliate-view');
  ctx.host.append(view);
  await view.open(fbook);

  let css = '';
  function styleCss() {
    const t = RTHEME[ctx.getTheme()] || RTHEME.light;
    const fam = ctx.getFontFamily();
    css = `body { background: ${t.bg} !important; color: ${t.fg} !important; font-size: ${ctx.getFontSize()}px; line-height: ${ctx.getLineHeight()} !important;${fam ? ` font-family: ${fam} !important;` : ''} }`;
    view.renderer?.setStyles?.(css);
  }
  styleCss();

  // 阅读方式：上下滚动 / 左右翻页（固定版式如 CBZ 不支持，保持引擎默认）
  function applyMode() {
    if (view.isFixedLayout) return;
    view.renderer?.setAttribute('flow', ctx.getReadingMode() === 'scroll' ? 'scrolled' : 'paginated');
  }
  applyMode();

  // 滚动活动：分页容器在 closed shadow root 内，window 捕获监听收不到其 scroll 事件
  // （scroll 不冒泡且 composed:false），但 paginator 会把容器滚动重派发为自身 scroll 事件
  view.renderer?.addEventListener('scroll', () => ctx.activity());

  // 先挂事件监听再 init：初始 CFI 续读的 relocate 可能在 init 期间同步触发
  view.addEventListener('relocate', (e) => {
    const d = e.detail || {};
    const fraction = typeof d.fraction === 'number' ? d.fraction : d.location?.fraction || 0;
    ctx.progress({
      fraction,
      location: { cfi: d.cfi, fraction },
      label: Math.round(fraction * 100) + '%',
      tocCurrent: d.tocItem?.href,
    });
  });
  // 每个章节加载后重新应用样式，并接管点击翻页：左/右 1/3 翻页，中间呼出工具栏；
  // iframe 内的点击/按键不会到达父页面，需单独上报用户活动以重置菜单自动隐藏
  // （滚动活动由上方 paginator 重派发的 scroll 事件统一覆盖）
  view.addEventListener('load', ({ detail }) => {
    view.renderer?.setStyles?.(css);
    detail?.doc?.addEventListener('pointerdown', () => ctx.activity());
    detail?.doc?.addEventListener('keydown', () => ctx.activity());
    detail?.doc?.addEventListener('click', (e) => {
      // 链接（含书内脚注跳转）交给 view.js 内置处理
      if (e.target.closest?.('a[href]')) return;
      const w = detail.doc.defaultView?.innerWidth || innerWidth;
      const x = e.clientX ?? w / 2;
      if (x < w * 0.3) view.prev();
      else if (x > w * 0.7) view.next();
      else ctx.toggleChrome();
    });
  });

  await view.init({ lastLocation: ctx.resume?.cfi || undefined });

  // 目录（含子级）
  const items = [];
  const walk = (list, level) => {
    for (const it of list || []) {
      items.push({ label: (it.label || '').trim(), target: it.href, level });
      if (it.subitems?.length) walk([...it.subitems], level + 1);
    }
  };
  walk(fbook.toc, 0);
  ctx.setToc(items.filter((i) => i.label && i.target != null));

  ctx.showTextRows(true);
  ctx.showZoomRow(false);
  ctx.showModeRow(!view.isFixedLayout);

  const modApi = {
    prev: () => view.prev(),
    next: () => view.next(),
    async jumpToFraction(frac) {
      await view.goToFraction(frac);
    },
    goTo(target) {
      view.goTo(target).catch(() => {});
    },
    applyTheme() {
      styleCss();
    },
    applyTextStyle() {
      styleCss();
    },
    applyMode() {
      applyMode();
    },
  };
  return modApi;
}
