import { createPresetSetup } from './preset-setup.mjs';
export const name = 'sims-settings-rpc';
export const inject = ['connection', 'simsConnection', 'agentPresets', 'settings'];
const fields = {
  'status.get': [], 'config.set': ['config', 'expectedRevision'],
  'auth.set': ['token'], 'auth.clear': [], 'connection.check': [],
  'preset.inspect': [], 'preset.create': ['id', 'name'], 'preset.remove': ['id', 'expectedDigest'],
};
const failure = (code, message) => ({ ok: false, error: { code: `sims/${code}`, message, details: {} } });

/** 使用宿主全局 Host/Origin 与 cookie 认证；公开 handle 不支持逐 channel authority。 */
export function apply(ctx) {
  const presets = createPresetSetup(ctx);
  ctx.connection.rpc.handle('/sims-agent', async (endpoint, payload, signal) => {
    const allowed = fields[endpoint];
    if (!Object.hasOwn(fields, endpoint) || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== allowed.length || Object.keys(payload).some(key => !allowed.includes(key))) {
      return failure('invalid-request', '无效的 SIMS 管理请求。');
    }
    if (endpoint === 'config.set' && (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0)) return failure('invalid-request', '请重新读取设置后保存。');
    try {
      const host = ctx.simsConnection;
      const value = endpoint === 'status.get' ? await host.describe()
        : endpoint === 'config.set' ? await host.configure(payload.config, payload.expectedRevision)
        : endpoint === 'auth.set' ? await host.authorize(payload.token)
        : endpoint === 'auth.clear' ? await host.disconnect()
        : endpoint === 'preset.inspect' ? await presets.inspectTemplate()
        : endpoint === 'preset.create' ? await presets.createTemplate(payload)
        : endpoint === 'preset.remove' ? await presets.removeTemplate(payload)
        : await host.check(signal);
      return { ok: true, value };
    } catch (error) {
      const templateErrors = { TEMPLATE_CHANGED: '模板已被修改，请到原生 Agent 预设管理中处理。', TEMPLATE_EXISTS: '该模板标识已存在，请使用新标识。', TEMPLATE_UNAVAILABLE: '用户模板目录或包内资源不可用。', TEMPLATE_NOT_OWNED: '该模板不在本插件的创建记录中。', TEMPLATE_INVALID: '请检查模板标识和名称。' };
      if (Object.hasOwn(templateErrors, error?.code)) return failure(error.code.toLowerCase().replaceAll('_', '-'), templateErrors[error.code]);
      return error?.code === 'SETTINGS_CONFLICT'
        ? failure('conflict', '设置已被其他页面更新，请刷新后重试。')
        : failure('operation-failed', 'SIMS 操作未完成，请检查配置或授权后重试。');
    }
  });
}
