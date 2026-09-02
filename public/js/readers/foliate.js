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

  await view.init({ lastLocation: ctx.resume?.cfi || undefined });

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
  // 每个章节加载后重新应用样式，并接管点击翻页：左/右 1/3 翻页，中间呼出工具栏
  view.addEventListener('load', ({ detail }) => {
    view.renderer?.setStyles?.(css);
    detail?.doc?.addEventListener('click', (e) => {
      // 链接（含书内脚注跳转）交给 view.js 内置处理
      if (e.target.closest?.('a[href]')) return;
      const w = detail.doc.defaultView?.innerWidth || innerWidth;
      const x = e.clientX ?? w / 2;
      if (x < w * 0.3) view.prev();
      else if (x > w * 0.7) view.next();
      else ctx.host.closest('.reader-app')?.classList.toggle('chrome-hidden');
    });
  });

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
  };
  return modApi;
}
