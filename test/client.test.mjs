import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkConnection } from '../src/sims-client.mjs';

// 仅协议测试使用临时 HTTP 服务；生产身份另由 live-check 验证。
async function fixture(t, respond) {
  const dir = await mkdtemp(join(tmpdir(), 'sims-contract-'));
  const tokenFile = join(dir, 'access.secret');
  await writeFile(tokenFile, 'fixture-access-token\n', { mode: 0o600 });
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization });
    respond(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { requests, config: { apiBaseUrl: `http://127.0.0.1:${server.address().port}/sims-api/api/v1`, tokenFile, timeoutMs: 1000 } };
}
const user = { id: 42, username: 'operator', realName: '接入人员', avatar: '/image', roles: ['viewer'], permissions: ['attendance:view'] };
function json(res, body, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

test('只请求带代理前缀的 auth/me 并只投影身份，令牌及其他字段不进入结果', async t => {
  const f = await fixture(t, (_, res) => json(res, { code: 200, success: true, data: { ...user, accessToken: 'unexpected-secret' } }));
  const result = await checkConnection(f.config);
  assert.equal(result.status, 'CONNECTED');
  assert.deepEqual(result.account, { id: '42', username: 'operator', displayName: '接入人员', roles: ['viewer'], permissions: ['attendance:view'] });
  assert.deepEqual(f.requests, [{ path: '/sims-api/api/v1/auth/me', method: 'GET', authorization: 'Bearer fixture-access-token' }]);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.doesNotMatch(JSON.stringify(result), /fixture-access-token|unexpected-secret|avatar/);
});

for (const [name, body, http, expected] of [
  ['HTTP 401', { message: 'fixture-access-token' }, 401, 'AUTH_REQUIRED'],
  ['业务 401', { code: 401, success: false }, 200, 'AUTH_REQUIRED'],
  ['HTTP 403', {}, 403, 'FORBIDDEN'],
  ['业务失败', { code: 500, success: false, data: user }, 200, 'UNAVAILABLE'],
  ['假成功', { code: 200, success: false, data: user }, 200, 'INVALID_RESPONSE'],
  ['缺少身份', { code: 200, success: true, data: {} }, 200, 'INVALID_RESPONSE'],
  ['登录页', null, 200, 'INVALID_RESPONSE'],
]) test(`${name} 不得显示连接成功或泄露错误正文`, async t => {
  const f = await fixture(t, (_, res) => body ? json(res, body, http) : res.end('<html>login</html>'));
  const result = await checkConnection(f.config);
  assert.equal(result.status, expected);
  assert.equal(result.account, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-access-token/);
});

test('重定向不继续携带凭据请求其他路径', async t => {
  const f = await fixture(t, (_, res) => { res.writeHead(302, { Location: '/other' }); res.end(); });
  assert.equal((await checkConnection(f.config)).status, 'INVALID_RESPONSE');
  assert.equal(f.requests.length, 1);
});

test('请求超过超时预算返回 TIMEOUT', async t => {
  const f = await fixture(t, () => {});
  assert.equal((await checkConnection({ ...f.config, timeoutMs: 30 })).status, 'TIMEOUT');
});

test('调用取消后不再发出请求', async t => {
  const f = await fixture(t, (_, res) => json(res, { code: 200, success: true, data: user }));
  assert.equal((await checkConnection(f.config, AbortSignal.abort())).status, 'CANCELLED');
  assert.equal(f.requests.length, 0);
});

test('缺少凭据或凭据权限过宽时不请求后端', async t => {
  const f = await fixture(t, () => {});
  await chmod(f.config.tokenFile, 0o644);
  assert.equal((await checkConnection(f.config)).status, 'CONFIGURATION_REQUIRED');
  assert.equal((await checkConnection({ ...f.config, tokenFile: '' })).status, 'CONFIGURATION_REQUIRED');
  assert.equal(f.requests.length, 0);
});

test('可由自有Host逐次解析凭据，无需令牌文件，解析失败不请求后端', async t => {
  const f = await fixture(t, (_, res) => json(res, { code: 200, success: true, data: user }));
  const config = { apiBaseUrl: f.config.apiBaseUrl, timeoutMs: 1000 };
  assert.equal((await checkConnection(config, undefined, async () => 'host-token')).status, 'CONNECTED');
  assert.equal(f.requests[0].authorization, 'Bearer host-token');
  assert.equal((await checkConnection(config, undefined, async () => undefined)).status, 'CONFIGURATION_REQUIRED');
  assert.equal(f.requests.length, 1);
});
