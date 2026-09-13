import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';
import { COMPOSITION_FILE, copyComposition, writableRoot } from '@deepseek-ai/dsh-agent-presets';

const namespace = 'sims-agent-templates';
const source = { id: 'sims', trust: 'system', path: fileURLToPath(new URL('../presets/sims/agent.cordis.yml', import.meta.url)) };
const schema = Schema.object({ templates: Schema.array(Schema.object({
  id: Schema.string().required(), name: Schema.string().required(), version: Schema.string().required(),
  digest: Schema.string().required(),
})).default([]) });
const fail = code => Object.assign(new Error(code), { code });

// 整个目录都是用户资产；新增文件、元数据及链接变化均阻止插件删除。
async function digestTree(path) {
  const hash = createHash('sha256');
  async function walk(current, relative) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw fail('TEMPLATE_CHANGED');
    hash.update(JSON.stringify([relative, stat.isDirectory() ? 'directory' : 'file']));
    if (stat.isDirectory()) {
      for (const name of (await readdir(current)).sort()) await walk(join(current, name), `${relative}/${name}`);
    } else {
      const bytes = await readFile(current);
      hash.update(String(bytes.length));
      hash.update(':');
      hash.update(bytes);
    }
  }
  await walk(path, '');
  return hash.digest('hex');
}

/** 由调用插件的 fiber 拥有设置注册；只通过公开创作接口创建和移除副本。 */
export function createPresetSetup(ctx) {
  const scope = ctx.settings.register(namespace, schema, { applies: 'live' });
  let tail = Promise.resolve();
  const serial = action => {
    const result = tail.then(action).catch(error => { throw error.code?.startsWith('TEMPLATE_') ? error : fail('TEMPLATE_FAILED'); });
    tail = result.catch(() => {});
    return result;
  };
  const writable = () => {
    try { return ctx.settings.writable && !!writableRoot(ctx.agentPresets.roots, 'sims'); } catch { return false; }
  };
  async function inspectTemplate() {
    const roster = await ctx.agentPresets.list();
    const templates = await Promise.all(scope.get().templates.map(async record => {
      const path = join(writableRoot(ctx.agentPresets.roots, record.id), record.id, COMPOSITION_FILE);
      const preset = roster.find(row => row.id === record.id);
      let status = 'missing';
      if (preset) {
        try {
          status = preset.path !== path || await digestTree(dirname(path)) !== record.digest ? 'changed' : preset.broken ? 'broken' : 'ready';
        } catch { status = 'changed'; }
      }
      return { ...record, status };
    }));
    return { templates, canCreate: writable() };
  }
  return {
    inspectTemplate: () => serial(inspectTemplate),
    createTemplate: ({ id, name } = {}) => serial(async () => {
      if (typeof id !== 'string' || id.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(id) || typeof name !== 'string' || !name.trim() || name.length > 80) throw fail('TEMPLATE_INVALID');
      if (!writable()) throw fail('TEMPLATE_UNAVAILABLE');
      if ((await ctx.agentPresets.list()).some(row => row.id === id) || scope.get().templates.some(row => row.id === id)) throw fail('TEMPLATE_EXISTS');
      const directory = await copyComposition(ctx.agentPresets.roots, source, id, name.trim());
      const preset = await ctx.agentPresets.resolve(id);
      if (dirname(preset.path) !== directory) throw fail('TEMPLATE_CHANGED');
      const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      const record = { id, name: name.trim(), version, digest: await digestTree(directory) };
      // 若持久化失败，保留已创建副本交由原生界面管理，不擅自回滚用户目录。
      await ctx.settings.update(namespace, { templates: [...scope.get().templates, record] });
      return inspectTemplate();
    }),
    removeTemplate: ({ id, expectedDigest } = {}) => serial(async () => {
      if (!writable()) throw fail('TEMPLATE_UNAVAILABLE');
      const record = scope.get().templates.find(row => row.id === id);
      if (!record) throw fail('TEMPLATE_NOT_OWNED');
      const preset = (await ctx.agentPresets.list()).find(row => row.id === id);
      if (!preset) throw fail('TEMPLATE_MISSING');
      const path = join(writableRoot(ctx.agentPresets.roots, id), id, COMPOSITION_FILE);
      if (expectedDigest !== record.digest || preset.path !== path || await digestTree(dirname(path)) !== record.digest) throw fail('TEMPLATE_CHANGED');
      await ctx.agentPresets.remove(id);
      await ctx.settings.update(namespace, { templates: scope.get().templates.filter(row => row.id !== id) });
      return inspectTemplate();
    }),
  };
}
