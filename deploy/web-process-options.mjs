export function workerCount(environment=process.env){const raw=environment.WMS_WEB_WORKERS??'1';if(!['1','2'].includes(raw))throw Error('WMS_WEB_WORKERS must be 1 or 2');return Number(raw);}
export function poolMaximum(environment=process.env){const raw=environment.WMS_DB_POOL_MAX??'5';if(!/^[1-5]$/.test(raw))throw Error('WMS_DB_POOL_MAX must be an integer from 1 through 5');return Number(raw);}
export function poolPartition(count){if(count===1)return[5];if(count===2)return[3,2];throw Error('Unsupported worker count');}
export function workerEnvironment(environment,slot,poolMax){
 const env={...environment,NODE_ENV:'production',WMS_CLUSTER_MANAGED:'1',WMS_CLUSTER_SLOT:String(slot),WMS_DB_POOL_MAX:String(poolMax)};
 // cluster.fork merges this map over the primary's process.env. Explicit
 // undefined overrides inherited values; deleting a key would leak it back in.
 for(const key of new Set([...Object.keys(process.env),...Object.keys(env),'NEXT_MANUAL_SIG_HANDLE','NEXT_PRIVATE_WORKER','NODE_UNIQUE_ID','__NEXT_PRIVATE_STANDALONE_CONFIG']))if(key.startsWith('NEXT_PRIVATE_')||key==='__NEXT_PRIVATE_STANDALONE_CONFIG'||key==='NEXT_MANUAL_SIG_HANDLE'||key==='NODE_UNIQUE_ID')env[key]=undefined;
 env.NODE_OPTIONS=environment.NODE_OPTIONS;
 if(env.NODE_OPTIONS&&!/^--max-old-space-size=\d+$/.test(env.NODE_OPTIONS))throw Error('Cluster NODE_OPTIONS permits only a heap-size limit');
 for(const key of ['BOOTSTRAP_DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL']){if(environment[key])throw Error('Operations database bindings must not be provided to web cluster');env[key]=undefined;}
 return env;
}
