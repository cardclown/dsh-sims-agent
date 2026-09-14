import { queryAttendance } from './attendance.mjs';
import { Service } from '@deepseek-ai/cordis';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { HostConfig, validateHostConfig } from './config.mjs';
import { checkConnection, normalizeAccessToken } from './sims-client.mjs';

const namespace = 'sims-agent';
const key = credentialKey(namespace, 'default');

/** 只拥有自身 namespace 和 grant；每次检查读取宿主当前值。 */
export default class SimsConnection extends Service {
  static Config = HostConfig;
  static inject = ['settings', 'credentials'];
  _scope;
  _stopped = false;
  _closing = new AbortController();
  constructor(ctx, config) {
    super(ctx, 'simsConnection');
    this._scope = ctx.settings.register(namespace, HostConfig, { base: config, validate: validateHostConfig, applies: 'live' });
  }
  async *[Service.init]() {
    yield () => { this._stopped = true; this._closing.abort(); };
  }
  _assertActive() {
    if (this._stopped) throw new Error('SIMS 服务已停止');
  }
  async describe() {
    this._assertActive();
    const descriptor = this.ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === namespace);
    const info = await this.ctx.credentials.describeRecord(key);
    const { apiBaseUrl, timeoutMs } = this._scope.get();
    return { config: { apiBaseUrl, timeoutMs }, revision: descriptor.revision,
      credential: { configured: info.configured, writable: info.writable, ...(info.kind ? { kind: info.kind } : {}) } };
  }
  async configure(patch, expectedRevision) {
    this._assertActive();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(field => !['apiBaseUrl', 'timeoutMs'].includes(field))) throw new Error('无效配置字段');
    await this.ctx.settings.update(namespace, patch, expectedRevision);
    return this.describe();
  }
  async authorize(value) {
    this._assertActive();
    const accessToken = normalizeAccessToken(value);
    await this.ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { accessToken } }));
    return this.describe();
  }
  async disconnect() {
    this._assertActive();
    await this.ctx.credentials.deleteRecord(key);
    return this.describe();
  }
  async attendance(args, signal) {
    this._assertActive();
    const combined = signal ? AbortSignal.any([signal, this._closing.signal]) : this._closing.signal;
    return queryAttendance(this._scope.get(), args, combined, async () => {
      const record = await this.ctx.credentials.readRecord(key);
      return record?.kind === 'grant' ? record.payload?.accessToken : undefined;
    });
  }
  async check(signal) {
    this._assertActive();
    const combined = signal ? AbortSignal.any([signal, this._closing.signal]) : this._closing.signal;
    return checkConnection(this._scope.get(), combined, async () => {
      const record = await this.ctx.credentials.readRecord(key);
      return record?.kind === 'grant' ? record.payload?.accessToken : undefined;
    });
  }
}
