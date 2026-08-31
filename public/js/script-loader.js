// 按需加载 <script>，重复加载只执行一次
const loaded = new Map();

export function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => reject(new Error('脚本加载失败：' + src));
        document.head.append(el);
      })
    );
  }
  return loaded.get(src);
}
