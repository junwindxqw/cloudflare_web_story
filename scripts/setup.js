// 一键初始化 Cloudflare 资源：创建 D1 / R2（如不存在），并把 database_id 回填到 wrangler.jsonc
// 用法：npm run setup && npm run deploy（需先 `wrangler login`）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(root, 'wrangler.jsonc');

function wrangler(args, label) {
  console.log(`\n==> ${label}`);
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  // 去掉 ANSI 颜色码，避免干扰后续输出解析
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  console.log(out.trim());
  if (r.status !== 0 && !/already exists/i.test(out)) {
    throw new Error(`${label} 失败，请检查 wrangler 登录状态`);
  }
  return out;
}

function setD1Id(id) {
  let text = readFileSync(configPath, 'utf8');
  text = text.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${id}"`);
  writeFileSync(configPath, text);
  console.log(`\n[setup] 已把 database_id=${id} 写入 wrangler.jsonc`);
}

function readD1Id() {
  const text = readFileSync(configPath, 'utf8');
  return text.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
}

async function main() {
  const currentId = readD1Id();
  if (currentId && currentId !== 'REPLACE_WITH_D1_DATABASE_ID') {
    console.log(`[setup] wrangler.jsonc 中已有 database_id（${currentId}），跳过创建。`);
  } else {
    const out = wrangler(['d1', 'create', 'web-story-db'], '创建 D1 数据库');
    const id = out.match(/database_id\s*[:=]\s*"?([\w-]+)"?/i)?.[1] || out.match(/([0-9a-f]{32})/i)?.[1];
    if (!id) throw new Error('无法从 wrangler d1 create 输出中解析 database_id，请手动填入 wrangler.jsonc');
    setD1Id(id);
  }

  wrangler(['r2', 'bucket', 'create', 'web-story-books'], '创建 R2 存储桶');
  console.log('\n[setup] 完成！接下来执行：npm run deploy');
  console.log('[setup] 提醒：部署前请在 wrangler.jsonc 中修改 AUTH_USERNAME / AUTH_PASSWORD。');
}

main().catch((e) => {
  console.error('\n[setup] 出错：', e.message);
  process.exitCode = 1;
});
