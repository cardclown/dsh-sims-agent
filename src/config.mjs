import Schema from '@deepseek-ai/schemastery';
import { isAbsolute } from 'node:path';

export const HostConfig = Schema.object({
  apiBaseUrl: Schema.string().default('').description('SIMS 对外 API 根地址，例如 https://站点/sims-api/v1；保留实际代理前缀，留空时返回待配置'),
  timeoutMs: Schema.number().min(1).max(60000).default(15000).description('单次连接检查超时，毫秒'),
});

export const Config = Schema.object({
  mode: Schema.union(['host', 'legacy-file']).default('host').description('默认使用宿主绑定；旧令牌文件必须显式选择 legacy-file'),
  ...HostConfig.dict,
  tokenFile: Schema.string().default('').description('仅当前运行账号可读的访问令牌文件绝对路径，不填写令牌正文'),
});

export function validateHostConfig(config) {
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60000) throw new Error('无效超时配置');
  if (config.apiBaseUrl !== '') {
    try { connectionConfig(config, { requireTokenFile: false }); }
    catch { throw new Error('无效 API 根地址或超时配置'); }
  }
}

/** 根地址由部署提供；工具只允许在该根地址下读取 auth/me。 */
export function connectionConfig(config, { requireTokenFile = true } = {}) {
  const url = new URL(config.apiBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('无效 API 根地址');
  if (requireTokenFile && (typeof config.tokenFile !== 'string' || !isAbsolute(config.tokenFile))) throw new Error('缺少令牌文件');
  const timeoutMs = config.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('无效超时配置');
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/auth/me`;
  return { url, tokenFile: config.tokenFile, timeoutMs };
}
