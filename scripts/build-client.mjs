import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(packageDirectory, 'lib/client.js');
const loaderId = '@dsh-ops/dsh-sims-agent';
const result = await build({
  entryPoints: [resolve(packageDirectory, 'client/index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  write: false,
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild 未生成 Client bundle');
const wrapped = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(loaderId)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${bundled}\n    return module.exports;\n  }\n});\n`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, wrapped, 'utf8');
