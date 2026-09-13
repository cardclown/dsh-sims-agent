import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRelease, preservesPresetConfig } from '../scripts/check-release.mjs';

test('实际发行 Bundle 不覆盖用户 Preset 配置', async () => {
  const report = await inspectRelease();
  assert.equal(report.blockers.some(x => x.code === 'PRESET_CONFIG_REPLACED'), false);
});

test('历史整段覆盖 patch 仍被拒绝', () => {
  assert.equal(preservesPresetConfig([{ id: 'agent-presets', config: { default: 'standard', roots: [] } }]), false);
});

test('仅插入自有插件不触碰现有 Preset 配置', () => {
  assert.equal(preservesPresetConfig([{ insert: [{ id: 'sims-settings', name: '@dsh-ops/dsh-sims-agent' }] }]), true);
});
