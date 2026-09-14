import { attendanceQuery } from './attendance.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { checkConnection, connectionStatuses } from './sims-client.mjs';
export { Config } from './config.mjs';

export const name = 'sims-tool';
export const inject = ['tools'];
const text = { type: 'string', required: true };
const list = { type: 'array', items: { type: 'string' }, required: true };

/** 仅从 SIMS Preset 挂载：作用域限制不会影响其他智能体。 */
export function apply(ctx, config) {
  let host;
  ctx.inject(['simsConnection'], scoped => {
    host = scoped.simsConnection;
    return () => { host = undefined; };
  });
  // standing 的限制也会应用于子 agent；仅拒绝已有全局名，保留自身 sims 的继承。
  let mask = '', disposeMask, updating = false;
  const refreshMask = () => {
    if (updating) return;
    const deny = ctx.tools.schemas().map(tool => tool.name).filter(name => !['sims', 'run_code'].includes(name)).sort();
    const next = JSON.stringify(deny);
    if (next === mask) return;
    updating = true;
    try { disposeMask?.(); disposeMask = deny.length ? ctx.tools.restrict({ deny }) : undefined; mask = next; }
    finally { updating = false; }
  };
  ctx.on('tools/change', refreshMask);
  refreshMask();
  ctx.tools.guard(exec => exec.name === 'sims' ? undefined : 'SIMS 仅允许 sims 工具。');
  ctx.tools.presentAs('native');
  ctx.tools.register(defineTool({
    name: 'sims',
    description: '检查真实 SIMS 连接和本插件绑定账号。支持 connection.check 和 attendance.summary；考勤需明确 date，按 page/size 分页；不要请求用户在聊天中提供密码或令牌。仅支持单日只读考勤，不支持写入。',
    parameters: {
      action: { type: 'string', enum: ['connection.check', 'attendance.summary'], required: true, description: '检查连接或查询单日考勤' },
      date: { type: 'string', description: '考勤日期 YYYY-MM-DD，考勤动作必填' },
      page: { type: 'integer', description: '页码，从 1 开始' },
      size: { type: 'integer', description: '每页 1–50，默认 20' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', enum: [...connectionStatuses, 'OK'], required: true },
          date: { type: 'string' }, page: { type: 'integer' }, size: { type: 'integer' }, total: { type: 'integer' }, hasMore: { type: 'boolean' },
          records: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            employeeName: text, workDate: text, statusLabels: list,
            ...Object.fromEntries(['organizationName','clockIn','clockOut','shiftInfo'].map(k=>[k,{oneOf:[{type:'string'},{type:'null'}]} ])),
            ...Object.fromEntries(['lateMinutes','earlyLeaveMinutes','inWorkDuration'].map(k=>[k,{oneOf:[{type:'number'},{type:'null'}]} ])),
          } } },
          checkedAt: text,
          message: text,
          account: { type: 'object', additionalProperties: false, properties: { id: text, username: text, displayName: text, roles: list, permissions: list } },
        },
      },
      render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: args.action === 'attendance.summary' ? '查询 SIMS 单日考勤' : '检查 SIMS 连接与绑定账号', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.action === 'attendance.summary') {
        const { action, ...query } = args; attendanceQuery(query);
        if (config.mode === 'legacy-file') throw new Error('考勤查询请先在设置页配置 Host 授权。');
        if (host) return host.attendance(query, exec.signal);
        return { status: 'CONFIGURATION_REQUIRED', checkedAt: new Date().toISOString(), message: '请启用 SIMS Host 并配置绑定账号。' };
      }
      // 参数 DSL 的隐式根允许扩展字段；显式拒绝凭据、URL 和身份覆盖。
      if (Object.keys(args).length !== 1 || args.action !== 'connection.check') throw new Error('仅允许 action="connection.check"，不接受其他参数。');
      if (config.mode === 'legacy-file') return checkConnection(config, exec.signal);
      if (host) return host.check(exec.signal);
      return { status: 'CONFIGURATION_REQUIRED', checkedAt: new Date().toISOString(), message: '请启用 SIMS Host 并配置绑定账号。' };
    },
  }));
}
