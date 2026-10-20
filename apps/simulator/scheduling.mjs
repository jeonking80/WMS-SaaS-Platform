export function nextWorkingTime(now,start='00:00',end='24:00'){
 const minutes=value=>{const m=String(value).match(/^(\d{2}):(\d{2})$/);if(!m||Number(m[1])>24||Number(m[2])>59||Number(m[1])===24&&Number(m[2])!==0)throw Error('INVALID_WORKING_TIME');return Number(m[1])*60+Number(m[2]);};
 const a=minutes(start),b=minutes(end),kst=now+9*3600000,day=Math.floor(kst/86400000),minute=Math.floor(kst/60000)%1440;
 if(a===b||a<b&&minute>=a&&minute<b||a>b&&(minute>=a||minute<b))return now;
 let next=day*86400000+a*60000-9*3600000;if(next<=now)next+=86400000;return next;
}
export function compareReports(left,right){
 const values=run=>({run_id:run.id,scenario:run.config.scenario,seed:run.config.seed,mode:run.config.mode,verdict:run.report?.verdict??'not_generated',workflow_version:run.report?.boundary?.workflow_version??null,api_calls:run.report?.counts?.api_calls??0,unique_events:run.report?.counts?.unique_external_events??0,physical_commands:run.report?.counts?.physical_commands??0,latency_p95_ms:run.report?.latency?.p95_ms??null,differences:run.report?.differences?.length??null,expected:run.report?.expected?.totals??null,configuration:run.config});
 const a=values(left),b=values(right);return {left:a,right:b,conditions_equal:JSON.stringify(left.config)===JSON.stringify(right.config),deltas:Object.fromEntries(['api_calls','unique_events','physical_commands','latency_p95_ms','differences'].map(k=>[k,typeof a[k]==='number'&&typeof b[k]==='number'?b[k]-a[k]:null]))};
}
