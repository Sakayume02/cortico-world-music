/**
 * 面板 bundle：src/webui/client.ts → dist/webui.js。
 * 产物路径写在 package.json 的 cortico.webUiClient 里，服务端自己分配 URL。
 * 浏览器侧只允许 `import type` 框架类型；那些 import 编译期会被擦掉。
 */
import * as esbuild from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [{ in: `${root}src/webui/client.ts`, out: 'webui' }],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  sourcemap: true,
  metafile: true,
});

for (const [path, info] of Object.entries(result.metafile.outputs)) {
  if (path.endsWith('.map')) continue;
  console.log(`${path.replace(/\\\\/g, '/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
