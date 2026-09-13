import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import Settings from '@deepseek-ai/dsh-settings-file';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import SimsConnection from '../src/host.mjs';

const ownedKey = credentialKey('sims-agent', 'default');
const foreignKey = credentialKey('another-plugin', 'default');
// 仅验证外来 namespace 的字节值保留；真实 agent-presets roster 验收由集成任务承担。
const foreignSettings = { 'agent-presets': { default: 'custom', roots: [{ path: './my-presets', trust: 'user' }] } };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sims-host-'));
  const settingsPath = join(dir, 'settings.json');
  const credentialsPath = join(dir, 'credentials.yaml');
  await writeFile(settingsPath, JSON.stringify(foreignSettings));
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes.reverse()) await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  });
  async function start() {
    const ctx = new Context();
    const settingsFiber = ctx.plugin(Settings, { path: settingsPath, watch: false });
    const credentialsFiber = ctx.plugin(Credentials, { path: credentialsPath, watch: false });
    await settingsFiber.await();
    await credentialsFiber.await();
    const hostFiber = ctx.plugin(SimsConnection, {});
    await hostFiber.await();
    const runtime = {
      ctx, hostFiber, settings: ctx.get('settings'), credentials: ctx.get('credentials'),
      connection: ctx.get('simsConnection'),
      async stop() {
        await hostFiber.dispose();
        await credentialsFiber.dispose();
        await settingsFiber.dispose();
      },
    };
    runtimes.push(runtime);
    return runtime;
  }
  return { start, settingsPath, credentialsPath };
}

async function identityServer(t, username, status = 200) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify({ code: 200, success: true, data: {
      id: 7, username, realName: username, roles: ['reader'], permissions: ['self:read'],
    } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { apiBaseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, requests };
}

test('自有设置与凭据使用真实宿主存储，保留其他插件配置且不回传令牌', async t => {
  const files = await fixture(t);
  const { connection, credentials } = await files.start();
  assert.ok(connection);
  await credentials.modifyRecord(foreignKey, async () => ({ kind: 'grant', payload: { accessToken: 'foreign.token' } }));
  const config = { apiBaseUrl: 'https://sims.example/api/v1', timeoutMs: 1200 };
  await connection.configure(config);
  const described = await connection.authorize('first.sims.token');
  assert.deepEqual(described.config, config);
  assert.equal(described.credential.configured, true);
  assert.doesNotMatch(JSON.stringify(described), /first\.sims\.token|accessToken/);
  const storedSettings = JSON.parse(await readFile(files.settingsPath, 'utf8'));
  assert.deepEqual(storedSettings['agent-presets'], foreignSettings['agent-presets']);
  assert.doesNotMatch(JSON.stringify(storedSettings), /token|credential/i);
  assert.equal((await credentials.readRecord(ownedKey)).payload.accessToken, 'first.sims.token');
  await connection.disconnect();
  assert.equal((await connection.describe()).credential.configured, false);
  assert.equal(await credentials.readRecord(ownedKey), undefined);
  assert.equal((await credentials.readRecord(foreignKey)).payload.accessToken, 'foreign.token');
  assert.deepEqual((await connection.describe()).config, config);
});

test('下一次真实 HTTP 身份请求立即使用新地址和新凭据，卸载后重启保留授权', async t => {
  const files = await fixture(t);
  const first = await identityServer(t, 'first-account');
  const second = await identityServer(t, 'second-account');
  const runtime = await files.start();
  const { connection } = runtime;
  await connection.configure({ apiBaseUrl: first.apiBaseUrl, timeoutMs: 1500 });
  await connection.authorize('first.sims.token');
  const firstCheck = await connection.check();
  assert.equal(firstCheck.status, 'CONNECTED');
  assert.equal(firstCheck.account.username, 'first-account');
  assert.deepEqual(first.requests, [{ method: 'GET', path: '/api/v1/auth/me', authorization: 'Bearer first.sims.token' }]);
  await connection.configure({ apiBaseUrl: second.apiBaseUrl, timeoutMs: 1800 });
  await connection.authorize('second.sims.token');
  const secondCheck = await connection.check();
  assert.equal(secondCheck.account.username, 'second-account');
  assert.deepEqual(second.requests, [{ method: 'GET', path: '/api/v1/auth/me', authorization: 'Bearer second.sims.token' }]);
  assert.doesNotMatch(JSON.stringify(secondCheck), /second\.sims\.token/);
  await runtime.hostFiber.dispose();
  assert.equal(runtime.ctx.get('simsConnection'), undefined);
  assert.equal(runtime.settings.get('sims-agent'), undefined);
  assert.equal((await runtime.credentials.readRecord(ownedKey)).payload.accessToken, 'second.sims.token');
  await runtime.stop();
  const restarted = await files.start();
  assert.deepEqual((await restarted.connection.describe()).config, { apiBaseUrl: second.apiBaseUrl, timeoutMs: 1800 });
  assert.equal((await restarted.connection.describe()).credential.configured, true);
  assert.equal((await restarted.connection.check()).account.username, 'second-account');
  assert.equal(second.requests.length, 2);
  assert.equal(first.requests.length, 1);
});

test('未配置时不联网，并发旧版本写入被宿主拒绝', async t => {
  const files = await fixture(t);
  const { connection } = await files.start();
  assert.equal((await connection.check()).status, 'CONFIGURATION_REQUIRED');
  const initial = await connection.describe();
  assert.equal(initial.credential.configured, false);
  assert.equal(typeof initial.revision, 'number');
  await connection.configure({ apiBaseUrl: 'https://sims.example/api/v1', timeoutMs: 1200 }, initial.revision);
  await assert.rejects(connection.configure({ timeoutMs: 2300 }, initial.revision), { name: 'SettingsConflictError' });
  assert.equal((await connection.describe()).config.timeoutMs, 1200);
});

test('拒绝非法地址、超时、未知字段和令牌，错误与持久设置不含输入令牌', async t => {
  const { connection, settings } = await (await fixture(t)).start();
  for (const patch of [{ apiBaseUrl: 'https://user:secret@example.com' }, { apiBaseUrl: 'https://example.com?token=secret' }, { apiBaseUrl: 'https://example.com#secret' }, { apiBaseUrl: 'file:///secret' }, { timeoutMs: 1.5 }, { timeoutMs: 0 }, { timeoutMs: 60001 }, { accessToken: 'secret' }]) {
    await assert.rejects(connection.configure(patch), error => !error.message.includes('secret'));
  }
  for (const token of ['', 'Bearer secret', 'secret\ninvalid', 'a'.repeat(16385)]) {
    await assert.rejects(connection.authorize(token), { message: '令牌格式无效' });
  }
  assert.doesNotMatch(JSON.stringify(settings.get('sims-agent')), /secret|accessToken/);
});

test('缺少宿主 provider 时不注册服务', async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(SimsConnection, {});
  await fiber.await();
  assert.equal(ctx.get('simsConnection'), undefined);
  await fiber.dispose();
});

test('已取消检查不发 HTTP，卸载取消在途检查且拒绝新管理调用', async t => {
  const files = await fixture(t);
  const runtime = await files.start();
  const { connection } = runtime;
  let requests = 0;
  const server = createServer(() => { requests++; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await connection.configure({ apiBaseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
  await connection.authorize('valid.token');
  assert.equal((await connection.check(AbortSignal.abort())).status, 'CANCELLED');
  assert.equal(requests, 0);
  const received = once(server, 'request');
  const pending = connection.check();
  await received;
  await runtime.hostFiber.dispose();
  assert.equal((await pending).status, 'CANCELLED');
  await assert.rejects(connection.configure({ timeoutMs: 100 }), /服务已停止/);
  assert.equal((await runtime.credentials.readRecord(ownedKey)).payload.accessToken, 'valid.token');
});

 test('过期 Host 授权返回 AUTH_REQUIRED，解除授权后不再发送请求', async t => {
  const { connection } = await (await fixture(t)).start();
  const server = await identityServer(t, 'expired', 401);
  await connection.configure({ apiBaseUrl: server.apiBaseUrl });
  await connection.authorize('expired.token');
  assert.equal((await connection.check()).status, 'AUTH_REQUIRED');
  await connection.disconnect();
  assert.equal((await connection.check()).status, 'CONFIGURATION_REQUIRED');
  assert.equal(server.requests.length, 1);
});
