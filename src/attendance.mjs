import { connectionConfig } from './config.mjs';
import { checkConnection, normalizeAccessToken } from './sims-client.mjs';

export function attendanceQuery(args) {
  if (!args || Object.keys(args).some(k => !['date','page','size'].includes(k))) throw new Error('只接受 date、page、size。');
  const {date,page=1,size=20}=args;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) throw new Error('请提供有效日期 YYYY-MM-DD。');
  if (!Number.isSafeInteger(page)||page<1||page>10000||!Number.isSafeInteger(size)||size<1||size>50) throw new Error('page 为 1–10000，size 为 1–50。');
  return new URLSearchParams({startDate:date,endDate:date,page:String(page),size:String(size)});
}

export function projectAttendance(data,args) {
  const page=args.page??1,size=args.size??20;
  if (!data || !Array.isArray(data.records) || data.records.length>size || data.current!==page || data.size!==size || !Number.isSafeInteger(data.total)||data.total<0||data.records.length>data.total) throw new Error('无效分页');
  const records=data.records.map(row=>{
    if (!row || row.workDate!==args.date || typeof row.employeeName!=='string' || !Array.isArray(row.statusLabels)||row.statusLabels.some(x=>typeof x!=='string')) throw new Error('无效考勤');
    const out={employeeName:row.employeeName,workDate:row.workDate,statusLabels:row.statusLabels};
    for(const key of ['organizationName','clockIn','clockOut','shiftInfo']) {
      if(row[key]!=null && typeof row[key]!=='string') throw new Error('无效文本');
      out[key]=row[key]??null;
    }
    for(const key of ['lateMinutes','earlyLeaveMinutes','inWorkDuration']) {
      if(row[key]!=null && (typeof row[key]!=='number'||!Number.isFinite(row[key])||row[key]<0)) throw new Error('无效数值');
      out[key]=row[key]??null;
    }
    return out;
  });
  return {date:args.date,page,size,total:data.total,hasMore:page*size<data.total,records};
}

/** 固定只读接口；用同一凭据快照核对身份和读取业务，权限与状态判定由 SIMS 执行。 */
export async function queryAttendance(config,args,signal,resolveToken) {
  const query=attendanceQuery(args);
  let token;
  try { token=normalizeAccessToken(await resolveToken()); } catch { return {status:'CONFIGURATION_REQUIRED',checkedAt:new Date().toISOString(),message:'请先配置 SIMS 绑定账号。'}; }
  const identity=await checkConnection(config,signal,async()=>token);
  if(identity.status!=='CONNECTED') return identity;
  const target=connectionConfig(config,{requireTokenFile:false});
  target.url.pathname=target.url.pathname.replace(/auth\/me$/,'attendance/summary');target.url.search=query.toString();
  const timeout=AbortSignal.timeout(target.timeoutMs);
  const combined=signal?AbortSignal.any([signal,timeout]):timeout;
  const fail=status=>({status,checkedAt:new Date().toISOString(),message:'考勤查询未成功；请检查授权、网络或接口状态，不能视为空数据。'});
  try {
    const response=await fetch(target.url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:combined});
    try {
      if(response.status===401)return fail('AUTH_REQUIRED');if(response.status===403)return fail('FORBIDDEN');if(response.status>=500)return fail('UNAVAILABLE');if(!response.ok)return fail('INVALID_RESPONSE');
      let bytes=0;const chunks=[];
      for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>1048576)return fail('INVALID_RESPONSE');chunks.push(chunk);}
      let body,data;
      try {body=JSON.parse(Buffer.concat(chunks).toString());}catch{return fail('INVALID_RESPONSE');}
      if(body.code===401)return fail('AUTH_REQUIRED');if(body.code===403)return fail('FORBIDDEN');
      if(body.code!==200||body.success!==true)return fail('INVALID_RESPONSE');
      try {data=projectAttendance(body.data,args);}catch{return fail('INVALID_RESPONSE');}
      if(signal?.aborted)return fail('CANCELLED');
      return {status:'OK',checkedAt:new Date().toISOString(),message:'仅为绑定账号可见范围内的本页考勤；total 是记录数，不是异常人数。判定来自 SIMS，未触发同步。',account:identity.account,...data};
    } finally {if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}
  }catch{return fail(signal?.aborted?'CANCELLED':timeout.aborted?'TIMEOUT':'UNAVAILABLE');}
}
