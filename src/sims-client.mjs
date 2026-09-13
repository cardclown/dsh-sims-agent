import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { connectionConfig } from './config.mjs';

const messages = {
  CONNECTED: '已通过 SIMS 实际接口核对绑定账号；这不代表当前聊天用户的身份或全部业务接口可用。',
  CONFIGURATION_REQUIRED: '请在 SIMS 插件设置中配置 API 地址和访问授权。',
  AUTH_REQUIRED: 'SIMS 访问令牌缺失、无效或已过期，请更新插件授权后重试。',
  FORBIDDEN: 'SIMS 拒绝了当前绑定账号的访问，请核对授权范围。',
  UNAVAILABLE: 'SIMS 网关或身份接口暂时不可用，未确认连接成功。',
  INVALID_RESPONSE: 'SIMS 未返回有效的身份信息，未确认连接成功。',
  TIMEOUT: 'SIMS 身份检查超时，未确认连接成功。',
  CANCELLED: '本次身份检查已取消。',
};
export const connectionStatuses = Object.freeze(Object.keys(messages));
const result = (status, account) => ({ status, checkedAt: new Date().toISOString(), message: messages[status], ...(account ? { account } : {}) });

export function normalizeAccessToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length > 16384 || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(token)) throw new Error('令牌格式无效');
  return token;
}

async function readToken(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16384) throw new Error('令牌文件无效');
    return normalizeAccessToken(await file.readFile('utf8'));
  } finally { await file.close(); }
}

function accountProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效身份');
  const id = typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0 ? String(value.id) : value.id;
  if (typeof id !== 'string' || !/^[1-9]\d*$/u.test(id)) throw new Error('无效用户 ID');
  if (typeof value.username !== 'string' || !value.username.trim() || value.username.length > 256) throw new Error('无效账号');
  for (const field of ['roles', 'permissions']) {
    if (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string')) throw new Error('无效权限信息');
  }
  return { id, username: value.username, displayName: typeof value.realName === 'string' ? value.realName : value.username, roles: value.roles, permissions: value.permissions };
}

/** 单次只读请求；仅返回允许的身份字段，不转发后端正文、凭据或底层异常。 */
export async function checkConnection(config, callerSignal, resolveToken) {
  if (callerSignal?.aborted) return result('CANCELLED');
  let target, token;
  try { target = connectionConfig(config, { requireTokenFile: !resolveToken }); token = resolveToken ? normalizeAccessToken(await resolveToken()) : await readToken(target.tokenFile); }
  catch { return result(callerSignal?.aborted ? 'CANCELLED' : 'CONFIGURATION_REQUIRED'); }
  const timeout = AbortSignal.timeout(target.timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const response = await fetch(target.url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal });
    try {
      if (response.status === 401) return result('AUTH_REQUIRED');
      if (response.status === 403) return result('FORBIDDEN');
      if (response.status >= 500) return result('UNAVAILABLE');
      if (!response.ok) return result('INVALID_RESPONSE');
      // auth/me 是小响应；限制读取规模，避免把错误页面或任意大文件放入会话。
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 262144) return result('INVALID_RESPONSE');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return result('INVALID_RESPONSE'); }
      if (body?.code === 401) return result('AUTH_REQUIRED');
      if (body?.code === 403) return result('FORBIDDEN');
      if (Number.isInteger(body?.code) && body.code >= 500) return result('UNAVAILABLE');
      if (body?.code !== 200 || body?.success !== true) return result('INVALID_RESPONSE');
      let account;
      try { account = accountProjection(body.data); } catch { return result('INVALID_RESPONSE'); }
      if (callerSignal?.aborted) return result('CANCELLED');
      return result('CONNECTED', account);
    } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  } catch {
    return result(callerSignal?.aborted ? 'CANCELLED' : timeout.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
  }
}
