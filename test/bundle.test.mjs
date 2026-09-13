import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

// 此函数序列化到独立安装目录执行；所有 import 均从发行包的真实 npm 安装解析。
async function installedProbe() {
  const restored = process.argv[2] === 'restored';
  const assert = (await import('node:assert/strict')).default;
  const { readFile, mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const yaml = (await import('js-yaml')).default;
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
  const { applyEntryPatches, entryListSchema } = await import('@deepseek-ai/cordis-plugin-include');
  const { discoverPresets } = await import('@deepseek-ai/dsh-agent-presets');
  const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const { createScope } = await import('@deepseek-ai/dsh-scope');
  const dir = process.cwd();
  process.env.DSH_HOME = join(dir, 'home');
  const baseUrl = pathToFileURL(`${dir}/`).href;
  const installed = join(dir, 'node_modules/@dsh-ops/dsh-sims-agent');
  const customRoot = join(dir, 'custom-root');
  await mkdir(customRoot, { recursive: true });
  const roster = { default: 'custom', roots: [{ path: customRoot, trust: 'system' }], includeShippedRoot: false, includeUserRoot: true };
  const settingsPath = join(dir, 'settings.json');
  if (!restored) await writeFile(settingsPath, JSON.stringify({ 'agent-presets': roster }));
  const { createPresetSetup } = await import(pathToFileURL(join(installed, 'src/preset-setup.mjs')).href);
  const original = [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: roster }];
  const patch = yaml.load(await readFile(join(installed, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema });
  assert.ok(patch.every(row => row.insert && !row.id));
  const rows = applyEntryPatches(original, patch, message => assert.fail(message));
  assert.deepEqual(rows[0], original[0]);
  assert.deepEqual(rows.slice(1).map(row => row.name), ['@dsh-ops/dsh-sims-agent', '@dsh-ops/dsh-sims-agent/settings-rpc']);
  const ctx = new Context();
  const loader = ctx.plugin(Loader, { baseUrl });
  await loader.await();
  let scope, host;
  try {
    for (const row of [
      { name: '@deepseek-ai/dsh-settings-file', config: { path: settingsPath, watch: false } },
      { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(dir, 'credentials.yaml'), watch: false } },
      { name: '@deepseek-ai/dsh-session-projection' },
      { name: '@deepseek-ai/dsh-system-prompt', config: { persona: '原有工程助手' } },
      { name: '@deepseek-ai/dsh-tools', config: { mode: 'both' } },
      ...rows,
    ]) await ctx.loader.create(row);
    await ctx.loader.await();
    let service, setup;
    const key = {};
    host = ctx.plugin({ inject: ['agentPresets', 'tools', 'systemPrompt', 'simsConnection', 'settings'], apply(c) {
      service = c;
      setup = createPresetSetup(c);
      c.tools.register(defineTool({ name: 'parent_tool', description: '原有工具', parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: async () => 'original' }));
      scope = createScope(c, key);
    } });
    await host.await();
    assert.ok(scope);
    const sources = await discoverPresets([{ path: join(installed, 'presets'), trust: 'system' }], baseUrl);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].broken, undefined);
    if (!restored) {
      const created = await setup.createTemplate({ id: 'sims', name: 'SIMS 助手' });
      assert.equal(created.templates[0].status, 'ready');
      await writeFile(join(dir, 'expected-template.json'), JSON.stringify(created));
      await assert.rejects(setup.createTemplate({ id: 'sims', name: '不能覆盖' }), { code: 'TEMPLATE_EXISTS' });
      const removable = await setup.createTemplate({ id: 'sims-remove', name: '显式移除' });
      await setup.removeTemplate({ id: 'sims-remove', expectedDigest: removable.templates.find(row => row.id === 'sims-remove').digest });
      assert.equal((await service.agentPresets.list()).some(row => row.id === 'sims-remove'), false);
    }
    assert.deepEqual(await setup.inspectTemplate(), JSON.parse(await readFile(join(dir, 'expected-template.json'), 'utf8')));
    const parentTools = service.tools.schemas();
    assert.ok(parentTools.some(row => row.name === 'parent_tool'));
    await service.agentPresets.mount(scope.ctx, 'sims');
    assert.deepEqual(service.tools.schemas(key).map(row => row.name), ['sims']);
    assert.deepEqual(service.tools.schemas(await service.agentPresets.standingKeyFor('sims')).map(row => row.name), ['sims']);
    assert.deepEqual(service.tools.schemas(), parentTools);
    assert.equal(service.agentPresets.defaultId, 'custom');
    assert.deepEqual(service.settings.get('agent-presets'), roster);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8'))['agent-presets'], roster);
    const prompt = renderPrompt(await service.systemPrompt.assemble({ scope: key }));
    assert.match(prompt, /SIMS 助手/);
    assert.match(prompt, /connection.check/);
    assert.doesNotMatch(prompt, /原有工程助手/);
    const result = await service.tools.execute({ name: 'sims', arguments: { action: 'connection.check' }, callId: 'installed-check', agent: key, signal: new AbortController().signal });
    assert.equal(result.isError, false);
    assert.equal(result.value.status, 'CONFIGURATION_REQUIRED');
    console.log('installed standing preset: PASS');
  } finally {
    await scope?.dispose();
    await host?.dispose();
    await loader.dispose();
  }
}


// 新进程没有已缓存的 SIMS 模块，通过真实宿主名单验证卸载残留。
async function uninstalledProbe() {
  const assert = (await import('node:assert/strict')).default;
  const { readFile, access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
  const dir = process.cwd();
  process.env.DSH_HOME = join(dir, 'home');
  await assert.rejects(access(join(dir, 'node_modules/@dsh-ops/dsh-sims-agent')));
  const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  const expected = JSON.parse(await readFile(join(dir, 'expected-template.json'), 'utf8')).templates[0];
  assert.equal(settings['sims-agent-templates'].templates[0].digest, expected.digest);
  const ctx = new Context();
  const loader = ctx.plugin(Loader, { baseUrl: pathToFileURL(`${dir}/`).href });
  await loader.await();
  let owner;
  try {
    await ctx.loader.create({ name: '@deepseek-ai/dsh-session-projection' });
    await ctx.loader.create({ name: '@deepseek-ai/dsh-agent-presets', config: settings['agent-presets'] });
    await ctx.loader.await();
    let presets;
    owner = ctx.plugin({ inject: ['agentPresets'], apply(c) { presets = c.agentPresets; } });
    await owner.await();
    const retained = (await presets.list()).find(row => row.id === 'sims');
    assert.ok(retained);
    assert.ok(retained.broken);
    await access(retained.path);
    console.log('uninstalled retained broken template: PASS');
  } finally { await owner?.dispose(); await loader.dispose(); }
}

test('发行包真实安装、模板管理、卸载残留与原制品重装，保留 roster 及父工具', { timeout: 300000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sims-package-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packed = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: root })).stdout)[0];
  assert.ok(packed.files.some(row => row.path === 'presets/sims/agent.cordis.yml'));
  assert.ok(packed.files.every(row => !/node_modules|test\/|secret|package-lock/.test(row.path)));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  // 允许正常 npm 生命周期；不复制或 symlink 开发依赖，首次运行需要 npm registry 网络。
  await run('npm', ['install', '--no-audit', '--no-fund', join(dir, packed.filename), '@deepseek-ai/dsh@0.1.2-rc.1'], { cwd: dir, timeout: 150000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(dir, 'probe.mjs'), `(${installedProbe.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`);
  const { stdout } = await run(process.execPath, ['probe.mjs'], { cwd: dir, timeout: 20000 });
  assert.match(stdout, /installed standing preset: PASS/);
  await run('npm', ['uninstall', '--no-audit', '--no-fund', '@dsh-ops/dsh-sims-agent'], { cwd: dir, timeout: 60000 });
  await writeFile(join(dir, 'uninstalled.mjs'), `(${uninstalledProbe.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`);
  const removed = await run(process.execPath, ['uninstalled.mjs'], { cwd: dir, timeout: 20000 });
  assert.match(removed.stdout, /uninstalled retained broken template: PASS/);
  await run('npm', ['install', '--no-audit', '--no-fund', join(dir, packed.filename)], { cwd: dir, timeout: 150000, maxBuffer: 4 * 1024 * 1024 });
  const restored = await run(process.execPath, ['probe.mjs', 'restored'], { cwd: dir, timeout: 20000 });
  assert.match(restored.stdout, /installed standing preset: PASS/);
});
