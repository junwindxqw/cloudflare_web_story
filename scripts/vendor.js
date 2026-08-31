// vendor 落位脚本：把第三方库的发行文件复制/下载到 public/vendor
// 仓库已提交 vendor 产物，正常使用无需手动运行；升级依赖或缺失时执行 `npm run vendor`
import { copyFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, 'public', 'vendor');

function copyFromNodeModules(srcRel, destRel) {
  const src = join(root, 'node_modules', srcRel);
  const dest = join(vendorDir, destRel);
  if (!existsSync(src)) {
    console.warn(`[vendor] 跳过（未安装）：${srcRel}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[vendor] 已复制 ${destRel}`);
}

async function fetchFoliateFile(rel) {
  const dest = join(vendorDir, 'foliate-js', rel);
  if (existsSync(dest)) {
    console.log(`[vendor] 已存在 foliate-js/${rel}`);
    return;
  }
  const url = `https://raw.githubusercontent.com/johnfactotum/foliate-js/main/${rel}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 foliate-js/${rel} 失败：HTTP ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`[vendor] 已下载 foliate-js/${rel}`);
}

const FOLIATE_FILES = [
  'LICENSE',
  'view.js',
  'paginator.js',
  'fixed-layout.js',
  'mobi.js',
  'fb2.js',
  'comic-book.js',
  'epub.js',
  'epubcfi.js',
  'progress.js',
  'overlayer.js',
  'text-walker.js',
  'uri-template.js',
  'search.js',
  'footnotes.js',
  'vendor/fflate.js',
  'vendor/zip.js',
];

async function main() {
  // epub.js 引擎已被 foliate-js 取代（EPUB/MOBI/AZW3/FB2/CBZ 统一渲染），仅保留 jszip 用于元数据提取
  copyFromNodeModules('jszip/dist/jszip.min.js', 'jszip/jszip.min.js');
  copyFromNodeModules('pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs');
  copyFromNodeModules('pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs');

  if (process.argv.includes('--clean-foliate')) {
    rmSync(join(vendorDir, 'foliate-js'), { recursive: true, force: true });
  }
  for (const rel of FOLIATE_FILES) {
    await fetchFoliateFile(rel);
  }
  console.log('[vendor] 完成');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
