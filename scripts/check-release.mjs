import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import yaml from 'js-yaml';
import { entryListSchema, applyEntryPatches } from '@deepseek-ai/cordis-plugin-include';

const root = new URL('../', import.meta.url);

// 用宿主的公开解析器复现实际覆盖；不执行配置中的 !!js 或读取部署凭据。
export function preservesPresetConfig(patches) {
  const original = [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: {
    default: 'existing-assistant',
    roots: [{ path: '/example/custom-presets', trust: 'user' }],
    includeShippedRoot: false, includeUserRoot: false,
  } }];
  const result = applyEntryPatches(original, patches, () => {});
  return isDeepStrictEqual(result.find(row => row.id === 'agent-presets'), original[0]);
}

export async function inspectRelease() {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const patches = yaml.load(await readFile(new URL(pkg.dsh.bundle.patch, root), 'utf8'), { schema: entryListSchema });
  const blockers = [];
  if (!preservesPresetConfig(patches)) blockers.push({ code: 'PRESET_CONFIG_REPLACED', message: 'Bundle 修改已有 agent-presets；自定义默认入口、roots 与启用标志无法共存。' });
  for (const group of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(pkg[group] ?? {})) {
      if (/^(file:|link:|workspace:|\/|\.\.?\/)/.test(version)) blockers.push({ code: 'NONPORTABLE_DEPENDENCY', message: `${group}.${name} 依赖本机或工作区来源。` });
    }
  }
  if (!pkg.repository?.url) blockers.push({ code: 'PUBLIC_SOURCE_UNDECLARED', message: '尚未声明可核验的公开源码仓库；不能猜填或公开业务仓库。' });
  for (const file of ['src/host.mjs', 'src/tool.mjs', 'src/preset-setup.mjs', 'src/settings-rpc.mjs', 'lib/client.js', 'presets/sims/agent.cordis.yml', 'README.md', 'LICENSE']) {
    try { if (!(await stat(new URL(file, root))).isFile()) throw new Error(); }
    catch { blockers.push({ code: 'RELEASE_FILE_MISSING', message: `发行文件缺失：${file}` }); }
  }
  return { package: `${pkg.name}@${pkg.version}`, status: blockers.length ? 'BLOCKED' : 'READY',
    verificationScope: 'package-structure-only', blockers,
    externalVerification: ['公开源码与原制品同源', '市场条目实际收录和市场安装', '目标平台离线重建与业务验收'] };

}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = await inspectRelease();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'READY' ? 0 : 1;
}
