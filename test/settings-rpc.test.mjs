import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Settings from '@deepseek-ai/dsh-settings-file';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import Host from '../src/host.mjs';
import { AgentPresets } from '@deepseek-ai/dsh-agent-presets';
import Projection from '@deepseek-ai/dsh-session-projection';
import * as Rpc from '../src/settings-rpc.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sims-rpc-'));
  const ctx = new Context(); ctx.baseUrl = new URL('../', import.meta.url).href; const fibers = [];
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(dir,{recursive:true,force:true}); });
  for (const [plugin, config] of [[Loader,{baseUrl:new URL('../',import.meta.url).href}], [Settings, {path: join(dir, 'settings.json'), watch:false}], [Credentials, {path:join(dir,'credentials.yaml'),watch:false}], [WebServer,{host:'127.0.0.1',port:0}], [Connection,{}], [Host,{}], [Projection,{}], [AgentPresets,{default:'standard',roots:[{path:join(dir,'presets'),trust:'user'}],includeUserRoot:false}], [Rpc,{}]]) {
    const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await Promise.race([fiber.await(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('fixture mount timeout: ' + (plugin.name || plugin.default?.name))), 2000); timer.unref(); })]);
  }
  const connection = ctx.get('connection');
  const web = ctx.get('webServer');
  const base = `http://127.0.0.1:${web.port}`;
  const unregister = web.register({kind:'exact',path:'/',handler:(req,res)=>{if(connection.authorizeIndex(req,res)) res.end('ready');}});
  t.after(unregister);
  const login = await fetch(connection.authenticatedUrl(base), {redirect:'manual'});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(endpoint, payload, headers = {cookie}) {
    return fetch(`${base}/sims-agent/${endpoint}`, {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({type:'client-request',rpcId:'test',method:endpoint,payload})});
  }
  const call = async (endpoint,payload) => (await (await request(endpoint,payload)).json()).result;
  return {ctx,request,call,cookie,dir};
}

test('真实 Web/Connection 拒绝未认证和跨来源 carrier，已认证可以管理', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('status.get',{},{})).status,401);
  assert.equal((await h.request('status.get',{}, {cookie:h.cookie,origin:'https://untrusted.example'})).status,403);
  assert.equal((await h.call('status.get',{})).ok,true);
});

test('管理输入严格校验、保存回读、旧 revision 冲突与授权只写', async t => {
  const h = await fixture(t); const initial = (await h.call('status.get',{})).value;
  for(const [endpoint,payload] of [['missing',{}],['status.get',{userId:7}],['config.set',{config:{userId:7},expectedRevision:0}],['auth.set',{token:'secret',userId:7}],['auth.clear',{userId:7}],['connection.check',{userId:7}]]) assert.equal((await h.call(endpoint,payload)).ok,false);
  const config={apiBaseUrl:'https://sims.example/api/v1',timeoutMs:1200};
  assert.equal((await h.call('config.set',{config,expectedRevision:initial.revision})).ok,true);
  assert.deepEqual((await h.call('status.get',{})).value.config,config);
  assert.equal((await h.call('config.set',{config,expectedRevision:initial.revision})).error.code,'sims/conflict');
  const saved=await h.call('auth.set',{token:'private.sims.token'});
  assert.equal(saved.value.credential.configured,true); assert.doesNotMatch(JSON.stringify(saved),/private.sims.token/);
  assert.equal((await h.call('auth.clear',{})).value.credential.configured,false);
});

test('真实存储故障原始异常不进入 RPC 错误包络', async t => {
  const h=await fixture(t);
  await h.call('auth.set',{token:'initial.token'});
  const credentialsPath=join(h.dir,'credentials.yaml');
  await rm(credentialsPath); await mkdir(credentialsPath);
  const result=await h.call('auth.set',{token:'private.sims.token'});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'sims/operation-failed');
  assert.doesNotMatch(JSON.stringify(result),/private.sims.token|EISDIR|credentials.yaml/);
});


test('真实认证 RPC 创建模板、重复拒绝、摘要移除与输入限制', async t => {
  const h = await fixture(t);
  assert.equal((await h.call('preset.inspect', {})).value.canCreate, true);
  const created = await h.call('preset.create', {id:'sims-rpc',name:'SIMS RPC 验收'});
  assert.equal(created.ok, true);
  const row = created.value.templates.find(item=>item.id==='sims-rpc');
  assert.ok(row.digest);
  assert.equal((await h.call('preset.create',{id:'sims-rpc',name:'重复'})).error.code,'sims/template-exists');
  assert.equal((await h.call('preset.create',{id:'../escape',name:'无效'})).error.code,'sims/template-invalid');
  assert.equal((await h.call('preset.inspect',{source:'/tmp'})).ok,false);
  assert.equal((await h.call('preset.remove',{id:'sims-rpc',expectedDigest:'stale'})).ok,false);
  assert.equal((await h.call('preset.remove',{id:'sims-rpc',expectedDigest:row.digest})).ok,true);
  assert.equal((await h.call('preset.inspect',{})).value.templates.length,0);
});
