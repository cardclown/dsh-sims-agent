import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { createPresetSetup } from '../src/preset-setup.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sims-template-'));
  let root = join(dir, 'presets');
  await mkdir(root);
  let settingsPath = join(dir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ foreign: { keep: true } }));
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.dispose(); await rm(dir, { recursive: true, force: true }); });
  async function start() {
    const ctx = new Context();
    const loader = ctx.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href });
    await loader.await();
    for (const row of [
      { name: '@deepseek-ai/dsh-settings-file', config: { path: settingsPath, watch: false } },
      { name: '@deepseek-ai/dsh-session-projection' },
      { name: '@deepseek-ai/dsh-agent-presets', config: { default: 'other', roots: [{ path: root, trust: 'user' }], includeShippedRoot: false, includeUserRoot: false } },
    ]) await ctx.loader.create(row);
    await ctx.loader.await();
    let setup, service;
    const owner = ctx.plugin({ inject: ['settings', 'agentPresets'], apply(c) { service = c; setup = createPresetSetup(c); } });
    await owner.await();
    assert.ok(setup);
    const runtime = { setup, service, async dispose() { await owner.dispose(); await loader.dispose(); } };
    runtimes.push(runtime);
    return runtime;
  }
  return { dir, get root() { return root; }, get settingsPath() { return settingsPath; }, start, async relocate() {
    const next = join(dir, 'new-home');
    await mkdir(next);
    await rename(root, join(next, 'presets'));
    await rename(settingsPath, join(next, 'settings.json'));
    root = join(next, 'presets');
    settingsPath = join(next, 'settings.json');
  } };
}

test('真实 DSH 创作、重启识别和显式移除，保留其他设置与副本', async t => {
  const files = await fixture(t);
  const first = await files.start();
  const created = await first.setup.createTemplate({ id: 'my-sims', name: '我的 SIMS' });
  // 源码目录不是已安装发行包；真实发现应报告工具包不可解析。
  assert.equal(created.templates[0].status, 'broken');
  assert.doesNotMatch(await readFile(files.settingsPath, 'utf8'), /sims-template-/);
  assert.match(created.templates[0].digest, /^[a-f0-9]{64}$/);
  assert.equal((await first.service.agentPresets.resolve('my-sims')).name, '我的 SIMS');
  await first.service.agentPresets.copy('my-sims', 'other', '其他副本');
  await assert.rejects(first.setup.createTemplate({ id: 'other', name: '不能覆盖' }), { code: 'TEMPLATE_EXISTS' });
  await first.service.settings.update('agent-presets', { default: 'my-sims' });
  await first.dispose();
  await files.relocate();
  const restarted = await files.start();
  assert.deepEqual(await restarted.setup.inspectTemplate(), created);
  await assert.rejects(restarted.setup.removeTemplate({ id: 'other', expectedDigest: created.templates[0].digest }), { code: 'TEMPLATE_NOT_OWNED' });
  await restarted.setup.removeTemplate({ id: 'my-sims', expectedDigest: created.templates[0].digest });
  assert.equal((await restarted.service.agentPresets.list()).length, 1);
  assert.equal(restarted.service.agentPresets.defaultId, 'other');
  assert.deepEqual(JSON.parse(await readFile(files.settingsPath, 'utf8')).foreign, { keep: true });
});

test('完整名单冲突、并发创建、元数据与新增资产修改阻止删除', async t => {
  const files = await fixture(t);
  const { setup } = await files.start();
  await assert.rejects(setup.createTemplate({ id: 'a'.repeat(65), name: 'SIMS' }), { code: 'TEMPLATE_INVALID' });
  await assert.rejects(setup.createTemplate({ id: 'sims', name: 'a'.repeat(81) }), { code: 'TEMPLATE_INVALID' });
  const attempts = await Promise.allSettled([setup.createTemplate({ id: 'sims-copy', name: 'SIMS' }), setup.createTemplate({ id: 'sims-copy', name: 'SIMS' })]);
  assert.equal(attempts[0].status, 'fulfilled');
  assert.equal(attempts[1].reason.code, 'TEMPLATE_EXISTS');
  const { digest } = attempts[0].value.templates[0];
  for (const filename of ['new-asset.txt', 'preset.yml']) {
    const path = join(files.root, 'sims-copy', filename);
    const original = await readFile(path).catch(() => undefined);
    await writeFile(path, '用户编辑');
    assert.equal((await setup.inspectTemplate()).templates[0].status, 'changed');
    await assert.rejects(setup.removeTemplate({ id: 'sims-copy', expectedDigest: digest }), { code: 'TEMPLATE_CHANGED' });
    if (original) await writeFile(path, original);
    else await rm(path);
  }
});
