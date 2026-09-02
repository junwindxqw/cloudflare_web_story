// PDF 阅读器（pdf.js，懒渲染 + 缩放 + 续读）
import { bookPath } from '../common.js';

const MARGIN = 14;

export async function init(ctx) {
  const pdfjsLib = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

  const pdf = await pdfjsLib.getDocument({
    url: bookPath(ctx.id, 'file'),
    rangeChunkSize: 262144,
    disableAutoFetch: true,
    disableStream: false,
  }).promise;

  const scroll = document.createElement('div');
  scroll.id = 'pdf-scroll';
  ctx.host.append(scroll);

  const pages = [];
  let fitScale = 1;
  let zoomFactor = 1;
  const zoomLabel = () =>
    Math.abs(zoomFactor - 1) < 0.01 ? '适配' : Math.round(zoomFactor * 100) + '%';

  const containerWidth = () => ctx.host.clientWidth - MARGIN * 2;

  // 建立 page 占位（高度按每页真实宽高比计算）
  const firstPage = await pdf.getPage(1);
  const v1 = firstPage.getViewport({ scale: 1 });
  const ratio = v1.height / v1.width;
  for (let i = 1; i <= pdf.numPages; i++) {
    const div = document.createElement('div');
    div.className = 'pdf-page';
    div.dataset.page = i;
    div.style.width = containerWidth() + 'px';
    div.style.height = Math.round(containerWidth() * ratio) + 'px';
    scroll.append(div);
    pages.push({ div, rendered: 0, canvas: null });
  }
  firstPage.cleanup();

  const currentScale = () => fitScale * zoomFactor;

  function layout() {
    fitScale = containerWidth() / v1.width;
    const scale = currentScale();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    for (const p of pages) {
      const w = Math.round(containerWidth() * zoomFactor);
      p.div.style.width = w + 'px';
      p.div.style.height = Math.round(w * ratio) + 'px';
      if (p.canvas) {
        p.canvas.width = Math.round(w * dpr);
        p.canvas.height = Math.round(w * ratio * dpr);
        p.canvas.style.width = w + 'px';
        p.canvas.style.height = Math.round(w * ratio) + 'px';
      }
    }
  }

  const renderQueue = new Set();
  async function renderPage(i) {
    const p = pages[i - 1];
    if (!p || p.rendered === currentScale()) return;
    renderQueue.add(i);
    try {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: currentScale() * Math.min(devicePixelRatio || 1, 2) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.style.width = p.div.style.width;
      canvas.style.height = p.div.style.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (p.canvas) p.canvas.remove();
      p.canvas = canvas;
      p.div.append(canvas);
      p.rendered = currentScale();
      page.cleanup();
    } catch (e) {
      console.warn('PDF 页渲染失败：', e);
    } finally {
      renderQueue.delete(i);
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const i = Number(en.target.dataset.page);
        if (en.isIntersecting) {
          renderPage(i);
          // 预渲染相邻页
          renderPage(i + 1);
          renderPage(i - 1);
        } else if (pages[i - 1]?.canvas && Math.abs(en.boundingClientRect.top) > 4000) {
          pages[i - 1].canvas.remove();
          pages[i - 1].canvas = null;
          pages[i - 1].rendered = 0;
        }
      }
    },
    { root: scroll, rootMargin: '400px 0px' }
  );
  for (const p of pages) io.observe(p.div);

  // 当前页追踪
  let lastReported = 0;
  function reportCurrent() {
    const st = scroll.scrollTop;
    const total = scroll.scrollHeight - scroll.clientHeight;
    const frac = total > 0 ? st / total : 0;
    // 找到视口顶部的页码
    let page = 1;
    for (const p of pages) {
      if (p.div.offsetTop + p.div.offsetHeight > st + scroll.clientHeight * 0.25) {
        page = Number(p.div.dataset.page);
        break;
      }
    }
    if (page !== lastReported) {
      lastReported = page;
      ctx.progress({
        fraction: frac || page / pdf.numPages,
        location: { page, fraction: frac },
        label: `${page} / ${pdf.numPages}`,
      });
    }
  }
  scroll.addEventListener('scroll', () => {
    reportCurrent();
    autoChrome();
  }, { passive: true });

  // 向下滚动时隐藏工具栏
  let lastY = 0;
  const app = ctx.host.closest('.reader-app');
  function autoChrome() {
    const y = scroll.scrollTop;
    if (y > lastY + 24 && y > 80) app.classList.add('chrome-hidden');
    else if (y < lastY - 24) app.classList.remove('chrome-hidden');
    lastY = y;
  }

  layout();

  // 续读
  const resumePage = Math.max(1, Number(ctx.resume?.page) || 1);
  if (resumePage > 1) {
    requestAnimationFrame(() => {
      const target = pages[resumePage - 1];
      if (target) scroll.scrollTop = target.div.offsetTop - MARGIN;
    });
  } else {
    reportCurrent();
  }

  const modApi = {
    prev() {
      scroll.scrollBy({ top: -(scroll.clientHeight - 60), behavior: 'smooth' });
    },
    next() {
      scroll.scrollBy({ top: scroll.clientHeight - 60, behavior: 'smooth' });
    },
    async jumpToFraction(frac) {
      const page = Math.max(1, Math.min(pdf.numPages, Math.round(frac * pdf.numPages) || 1));
      scroll.scrollTop = pages[page - 1].div.offsetTop - MARGIN;
    },
    goTo() {
      /* PDF 无目录 */
    },
    applyTheme() {
      /* PDF 页面保持白底，主题只影响外壳（夜间反色由 CSS 按 body 主题属性生效） */
    },
    applyTextStyle() {
      /* 无关 */
    },
    zoomIn() {
      zoomFactor = Math.min(4, zoomFactor * 1.2);
      relayoutPreserving();
    },
    zoomOut() {
      zoomFactor = Math.max(0.4, zoomFactor / 1.2);
      relayoutPreserving();
    },
  };

  function relayoutPreserving() {
    const anchor = pages[lastReported - 1];
    const anchorTop = anchor ? anchor.div.offsetTop : 0;
    const anchorOffset = anchor ? scroll.scrollTop - anchorTop : 0;
    layout();
    for (const p of pages) {
      if (p.canvas) {
        p.canvas.remove();
        p.canvas = null;
        p.rendered = 0;
      }
    }
    if (anchor) scroll.scrollTop = anchor.div.offsetTop + anchorOffset * (currentScale() / fitScale || 1);
    ctx.setZoomLabel(zoomLabel());
    // 重新渲染可见页
    setTimeout(() => {
      for (const p of pages) {
        const r = p.div.getBoundingClientRect();
        const sr = scroll.getBoundingClientRect();
        if (r.bottom > sr.top && r.top < sr.bottom) renderPage(Number(p.div.dataset.page));
      }
    }, 30);
  }

  ctx.setZoomLabel(zoomLabel());
  ctx.showTextRows(false);
  ctx.showZoomRow(true);
  return modApi;
}
