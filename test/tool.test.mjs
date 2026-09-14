import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Settings from '@deepseek-ai/dsh-settings-file';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import Host from '../src/host.mjs';
import * as Sims from '../src/tool.mjs';

async function harness(t, config = {}) {
  const ctx = new Context();
  const dir = await mkdtemp(join(tmpdir(), 'sims-tool-'));
  const providers=[];
  for(const [plugin,config] of [[Settings,{path:join(dir,'settings.json'),watch:false}],[Credentials,{path:join(dir,'credentials.yaml'),watch:false}],[Host,{}]]) {
    const fiber=ctx.plugin(plugin,config); providers.push(fiber); await fiber.await();
  }
  t.after(async()=>{for(const fiber of providers.reverse()) await fiber.dispose(); await rm(dir,{recursive:true,force:true});});
  const prompt = ctx.plugin(SystemPrompt);
  const runtime = ctx.plugin(Tools, { mode: 'both' });
  await prompt.await(); await runtime.await();
  let scope, tools;
  const standingKey = {}; const key = {};
  const host = ctx.plugin({ name: 'sims-test-host', inject: ['tools'], apply(hostCtx) {
    tools = hostCtx.tools;
    tools.register(defineTool({ name: 'parent_tool', description: '原有工具', parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: async () => 'original' }));
    scope = createScope(hostCtx, standingKey);
  } });
  await host.await();
  const agentScope = createScope(scope.ctx, key, {parent:standingKey});
  const sims = scope.ctx.plugin(Sims, config);
  await sims.await();
  t.after(async () => { await agentScope.dispose(); await scope.dispose(); await host.dispose(); await runtime.dispose(); await prompt.dispose(); });
  return { ctx, key, tools, sims };
}

test('SIMS scope 仅出现 sims；父 scope 原工具保留，停用后撤销工具与限制', async t => {
  const h = await harness(t);
  assert.deepEqual(h.tools.schemas(h.key).map(x => x.name), ['sims']);
  assert.equal(h.tools.get('parent_tool', h.key), undefined);
  assert.ok(h.tools.get('parent_tool'));
  await h.sims.dispose();
  assert.equal(h.tools.get('sims', h.key), undefined);
  assert.ok(h.tools.get('parent_tool', h.key));
});

test('真实 DSH 执行管线返回未配置，不将其解释为已连接', async t => {
  const h = await harness(t);
  const result = await h.tools.execute({ name: 'sims', arguments: { action: 'connection.check' }, callId: 'sims-check', agent: h.key, signal: new AbortController().signal });
  assert.equal(result.isError, false);
  assert.equal(result.value.status, 'CONFIGURATION_REQUIRED');
  assert.match(result.content[0].text, /配置/);
});

test('拒绝其他动作及身份、URL、凭据等额外参数', async t => {
  const h = await harness(t);
  for (const args of [{ action: 'inventory.write' }, { action: 'connection.check', token: 'forbidden' }, { action: 'connection.check', userId: 1 }]) {
    const result = await h.tools.execute({ name: 'sims', arguments: args, callId: 'invalid', agent: h.key, signal: new AbortController().signal });
    assert.equal(result.isError, true);
  }
});

test('standing 挂载后新增的全局工具仍不进入 SIMS 子 agent，父作用域可用', async t => {
  const h=await harness(t);
  const dispose=h.tools.register(defineTool({name:'late_tool',description:'后注册工具',parameters:{},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:async()=>'late'}));
  t.after(dispose);
  assert.deepEqual(h.tools.schemas(h.key).map(x=>x.name),['sims']);
  assert.ok(h.tools.get('late_tool'));
  const result=await h.tools.execute({name:'late_tool',arguments:{},callId:'late',agent:h.key,signal:new AbortController().signal});
  assert.equal(result.isError,true);
});

test('默认工具读取真实 Host 已保存设置与凭据，不回退文件', async t => {
  const {createServer}=await import('node:http'); const {once}=await import('node:events');
  let authorization;
  const server=createServer((req,res)=>{authorization=req.headers.authorization;res.writeHead(401);res.end();});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const h=await harness(t,{tokenFile:'/does/not/exist'});
  const host=h.ctx.get('simsConnection');
  await host.configure({apiBaseUrl:`http://127.0.0.1:${server.address().port}/api`,timeoutMs:1000});
  await host.authorize('host.test.token');
  const result=await h.tools.execute({name:'sims',arguments:{action:'connection.check'},callId:'host-check',agent:h.key,signal:new AbortController().signal});
  assert.equal(result.isError,false); assert.equal(result.value.status,'AUTH_REQUIRED');
  assert.equal(authorization,'Bearer host.test.token');
});

test('考勤动作仍走单工具管线：缺少授权明确失败，拒绝日期与身份覆盖', async t => {
  const h=await harness(t);
  const run=arguments_=>h.tools.execute({name:'sims',arguments:arguments_,callId:'attendance-check',agent:h.key,signal:new AbortController().signal});
  const result=await run({action:'attendance.summary',date:'2026-09-13'});
  assert.equal(result.isError,false);assert.equal(result.value.status,'CONFIGURATION_REQUIRED');
  for(const args of [{action:'attendance.summary'},{action:'attendance.summary',date:'2026-02-30'},{action:'attendance.summary',date:'2026-09-13',userId:1}]) assert.equal((await run(args)).isError,true);
});
