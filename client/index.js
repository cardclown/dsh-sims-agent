import React from 'react';

export const name = 'sims-agent-settings';
export const inject = ['slots', 'connection'];
const h = React.createElement;
const failure = 'SIMS 操作未完成，请检查配置或授权后重试。';

export function apply(ctx) {
  function SimsSettings() {
    const [snapshot, setSnapshot] = React.useState(null);
    const [draft, setDraft] = React.useState({ apiBaseUrl: '', timeoutMs: 15000 });
    const [token, setToken] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const [result, setResult] = React.useState(null);
    const [templates, setTemplates] = React.useState({ templates: [], canCreate: false });
    const [preset, setPreset] = React.useState({ id: 'sims', name: 'SIMS 助手' });
    const mounted = React.useRef(false);
    const pending = React.useRef(null);
    const call = async (endpoint, payload, signal) => {
      const response = await ctx.connection.rpc.call('/sims-agent', endpoint, payload, signal);
      if (!response.ok) {
        const error = new Error(failure); error.code = response.error?.code; throw error;
      }
      return response.value;
    };
    const readTemplates = async signal => {
      const value = await call('preset.inspect', {}, signal);
      if (mounted.current && !signal.aborted) setTemplates(value);
    };
    const read = async (signal) => {
      const value = await call('status.get', {}, signal);
      if (mounted.current && !signal.aborted) { setSnapshot(value); setDraft(value.config); }
      await readTemplates(signal);
    };
    const run = async (action) => {
      if (pending.current) return;
      const controller = new AbortController(); pending.current = controller;
      setBusy(true); setNotice('');
      try { await action(controller.signal); }
      catch (error) {
        if (mounted.current && !controller.signal.aborted) setNotice(error.code === 'sims/conflict'
          ? '设置已被其他页面更新，请刷新后重试；当前普通配置草稿已保留。'
          : error.code === 'sims/template-changed' ? '模板已修改，请到设置中的 Agent 预设管理页处理；本插件未删除。'
          : error.code === 'sims/template-exists' ? '标识已被占用，请换一个新标识；已有模板保持不变。' : failure);
      } finally {
        if (mounted.current) { setBusy(false); setToken(''); }
        if (pending.current === controller) pending.current = null;
      }
    };
    React.useEffect(() => {
      mounted.current = true; void run(read);
      return () => { mounted.current = false; pending.current?.abort(); };
    }, []);
    const save = () => run(async signal => {
      await call('config.set', { config: draft, expectedRevision: snapshot.revision }, signal);
      if (token.trim()) await call('auth.set', { token }, signal);
      await read(signal);
      if (mounted.current && !signal.aborted) { setNotice('配置已保存并回读。'); setResult(null); }
    });
    const disconnect = () => run(async signal => {
      await call('auth.clear', {}, signal); await read(signal);
      if (mounted.current && !signal.aborted) { setNotice('已解除绑定。'); setResult(null); }
    });
    const check = () => run(async signal => {
      const value = await call('connection.check', {}, signal);
      if (mounted.current && !signal.aborted) setResult(value);
    });
    const manageTemplate = (endpoint, payload) => run(async signal => {
      await call(endpoint, payload, signal); await readTemplates(signal);
      if (mounted.current && !signal.aborted) setNotice(endpoint === 'preset.create' ? '用户模板已创建并回读，可在新会话中选择。' : '用户模板已移除，插件与授权保持不变。');
    });
    const field = (label, props) => h('label', { style: { display: 'grid', gap: 6 } }, label,
      h('input', { ...props, disabled: busy, style: { padding: 8, border: '1px solid #8886', borderRadius: 6 } }));
    return h('section', { style: { display: 'grid', gap: 14, maxWidth: 680, padding: 16 } },
      h('h3', null, 'SIMS 助手'),
      h('p', null, '配置 SIMS API 与绑定账号；检查连接使用已保存配置。'),
      field('API 地址', { type: 'url', value: draft.apiBaseUrl, placeholder: 'https://站点/sims-api/v1',
        onChange: event => setDraft({ ...draft, apiBaseUrl: event.target.value }) }),
      field('超时（毫秒）', { type: 'number', min: 1, max: 60000, step: 1, value: draft.timeoutMs,
        onChange: event => setDraft({ ...draft, timeoutMs: Number(event.target.value) }) }),
      field('访问令牌（只写；留空保留现有绑定）', { type: 'password', value: token, autoComplete: 'new-password',
        onChange: event => setToken(event.target.value) }),
      h('p', null, snapshot?.credential.configured ? '当前已绑定授权。' : '当前未绑定授权。'),
      h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
        h('button', { disabled: busy || !snapshot, onClick: save }, '保存配置'),
        h('button', { disabled: busy || !snapshot, onClick: check }, '检查连接'),
        h('button', { disabled: busy || !snapshot?.credential.configured, onClick: disconnect }, '解除绑定'),
        h('button', { disabled: busy, onClick: () => run(read) }, '刷新')),
      h('h4', null, '用户模板'),
      !templates.canCreate && h('p', null, '宿主未开放可写用户模板目录或设置，暂时无法创建模板。'),
      h('p', null, '使用同一用户模板目录的 Profile 可发现模板；未安装插件时会显示不可用。卸载插件保留模板，移除按钮仅删除下列未修改的副本。'),
      field('模板标识', { value: preset.id, maxLength: 64, onChange: event => setPreset({ ...preset, id: event.target.value }) }),
      field('助手名称', { value: preset.name, maxLength: 80, onChange: event => setPreset({ ...preset, name: event.target.value }) }),
      h('button', { disabled: busy || !templates.canCreate, onClick: () => manageTemplate('preset.create', preset) }, '创建 SIMS 助手'),
      ...templates.templates.map(item => h('div', { key: item.id },
        h('p', null, `${item.name || item.id}（${item.id}）· 来源版本 ${item.version} · ${ ({ready:'可用',changed:'已修改，请到 Agent 预设管理',missing:'已不存在',broken:'不可用'})[item.status] || item.status}`),
        h('button', { disabled: busy || !['ready', 'broken'].includes(item.status), onClick: () => manageTemplate('preset.remove', {id:item.id, expectedDigest:item.digest}) }, `移除模板 ${item.id}`))),
      busy && h('p', { role: 'status' }, '处理中…'),
      notice && h('p', { role: 'status' }, notice),
      result && h('div', { role: 'status' },
        h('strong', null, result.status), h('p', null, result.message),
        result.account && h('p', null, `绑定账号：${result.account.displayName}（${result.account.username}）`),
        h('small', null, result.checkedAt)));
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'sims-agent', order: 24, label: () => 'SIMS 助手',
  }, SimsSettings));
}
