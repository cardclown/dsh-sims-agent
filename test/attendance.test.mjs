import assert from 'node:assert/strict';
import test from 'node:test';
import { attendanceQuery, projectAttendance } from '../src/attendance.mjs';
test('日期、分页与身份覆盖严格校验',()=>{
 assert.equal(attendanceQuery({date:'2026-09-13'}).get('startDate'),'2026-09-13');
 for(const value of [{date:'2026-02-30'},{date:'2026-09-13',size:51},{date:'2026-09-13',userId:1},{date:'2026-09-13',page:0}]) assert.throws(()=>attendanceQuery(value));
});
test('保留后端判定并明确分页，拒绝坏数据且不泄露额外字段',()=>{
 const row={employeeName:'员工',workDate:'2026-09-13',clockIn:null,clockOut:null,statusLabels:['未打卡'],accessToken:'secret'};
 const result=projectAttendance({records:[row],current:1,size:1,total:33},{date:'2026-09-13',page:1,size:1});
 assert.equal(result.hasMore,true); assert.deepEqual(result.records[0].statusLabels,['未打卡']);
 assert.equal(result.records[0].clockIn,null); assert.equal('accessToken' in result.records[0],false);
 assert.throws(()=>projectAttendance({records:[],current:1,size:1,total:-1},{date:'2026-09-13',page:1,size:1}));
});
