import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
const profile=resolve('home/profiles/web');
const req=createRequire(join(profile,'package.json'));
const dshPath=req.resolve('@deepseek-ai/dsh/package.json');
const dsh=createRequire(dshPath), base=createRequire(dsh.resolve('@deepseek-ai/dsh-base/package.json'));
const subprocess=createRequire(base.resolve('@deepseek-ai/dsh-subprocess-local'));
await new Promise((done,reject)=>{
  let output='';const pty=subprocess('node-pty').spawn('/bin/sh',['-c','printf offline-native-ok'],{name:'xterm',cols:80,rows:24,cwd:profile,env:process.env});
  const timer=setTimeout(()=>{pty.kill();reject(new Error('native PTY timeout'));},10000);
  pty.onData(value=>{output+=value;});pty.onExit(()=>{clearTimeout(timer);/offline-native-ok/.test(output)?done():reject(new Error('native PTY failed'));});
});
const pkg=req('@deepseek-ai/dsh/package.json');
const cli=join(dirname(dshPath),typeof pkg.bin==='string'?pkg.bin:pkg.bin.dsh);
const child=spawn(process.execPath,[cli,'--profile','web','--no-open','--port','18461'],{env:{...process.env,DSH_HOME:resolve('home')},stdio:['ignore','pipe','pipe']});
try {
  const url=await new Promise((done,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('DSH boot timeout')),30000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);reject(new Error(`DSH exited: ${code}`));});
    child.stdout.on('data',read);child.stderr.on('data',read);
    function read(data){output+=data.toString();const match=output.match(/http:\/\/127\.0\.0\.1:18461\/[^\s]*/);if(match){clearTimeout(timer);done(match[0]);}}
  });
  const login=await fetch(url,{redirect:'manual'});
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie,'DSH authenticated launch cookie');
  async function call(endpoint,payload){
    const response=await fetch(`http://127.0.0.1:18461/sims-agent/${endpoint}`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({type:'client-request',rpcId:endpoint,method:endpoint,payload})});
    assert.equal(response.status,200);const result=(await response.json()).result;assert.equal(result.ok,true,JSON.stringify(result.error));return result.value;
  }
  const created=await call('preset.create',{id:'offline-sims',name:'离线验收助手'});
  assert.equal(created.templates[0].status,'ready');
  assert.equal((await call('connection.check',{})).status,'CONFIGURATION_REQUIRED');
  await call('preset.remove',{id:'offline-sims',expectedDigest:created.templates[0].digest});
  assert.equal((await call('preset.inspect',{})).templates.length,0);
  console.log(JSON.stringify({status:'PASS',platform:process.platform,arch:process.arch,node:process.version,nativePty:'PASS',host:'real DSH CLI + authenticated RPC',template:'ready/create/remove',connection:'CONFIGURATION_REQUIRED'}));
} finally {child.kill('SIGTERM');}
