import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function openStore(path) {
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,status TEXT NOT NULL,config TEXT NOT NULL,target TEXT NOT NULL,checkpoint INTEGER NOT NULL DEFAULT 0,context TEXT NOT NULL DEFAULT '{}',boundary TEXT,report TEXT);
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),ordinal INTEGER NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,role TEXT NOT NULL,input TEXT NOT NULL,options TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'unsent',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,UNIQUE(run_id,ordinal));
    CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),at TEXT NOT NULL,kind TEXT NOT NULL,details TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intent(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),command TEXT NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(operations)').all().some(x=>x.name==='options'))db.exec("ALTER TABLE operations ADD COLUMN options TEXT NOT NULL DEFAULT '{}'");
  const parseRun=row=>row?{...row,config:JSON.parse(row.config),target:JSON.parse(row.target),context:JSON.parse(row.context),report:row.report?JSON.parse(row.report):null}:null;
  const parseOp=row=>row?{...row,input:JSON.parse(row.input),options:JSON.parse(row.options??'{}'),result:row.result?JSON.parse(row.result):null}:null;
  return {db,
    create(run,ops){db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO runs(id,created_at,status,config,target) VALUES(?,?,?,?,?)').run(run.id,new Date().toISOString(),'paused',JSON.stringify(run.config),JSON.stringify(run.target));const insert=db.prepare('INSERT INTO operations(id,run_id,ordinal,kind,label,role,input,options) VALUES(?,?,?,?,?,?,?,?)');for(const [ordinal,op]of ops.entries())insert.run(op.id,run.id,ordinal,op.kind,op.label,op.role,JSON.stringify(op.input),JSON.stringify(op.options??{}));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}},
    list(){return db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all().map(parseRun);},
    run(id){return parseRun(db.prepare('SELECT * FROM runs WHERE id=?').get(id));},
    updateRun(id,patch){const entries=Object.entries(patch);for(const [key]of entries)if(!['status','checkpoint','context','boundary','report'].includes(key))throw Error('Invalid run field');if(entries.length)db.prepare(`UPDATE runs SET ${entries.map(([key])=>key+'=?').join(',')} WHERE id=?`).run(...entries.map(([,value])=>typeof value==='object'?JSON.stringify(value):value),id);},
    operations(id){return db.prepare('SELECT * FROM operations WHERE run_id=? ORDER BY ordinal').all(id).map(parseOp);},
    operation(id){return parseOp(db.prepare('SELECT * FROM operations WHERE id=?').get(id));},
    updateOp(id,patch){const entries=Object.entries(patch);for(const [key]of entries)if(!['input','options','role','status','attempts','next_at','result','error'].includes(key))throw Error('Invalid operation field');if(entries.length)db.prepare(`UPDATE operations SET ${entries.map(([key])=>key+'=?').join(',')} WHERE id=?`).run(...entries.map(([,value])=>value&&typeof value==='object'?JSON.stringify(value):value),id);},
    observe(runId,kind,details){db.prepare('INSERT INTO observations(run_id,at,kind,details) VALUES(?,?,?,?)').run(runId,new Date().toISOString(),kind,JSON.stringify(details));},
    observations(id){return db.prepare('SELECT * FROM observations WHERE run_id=? ORDER BY id').all(id).map(row=>({...row,details:JSON.parse(row.details)}));},
    saveIntent(runId,operation,payload){db.prepare('INSERT INTO intent(id,run_id,command,payload,actor,at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(operation.id,runId,operation.input.command,JSON.stringify(payload),operation.role,new Date().toISOString());},
    intents(id){return db.prepare('SELECT * FROM intent WHERE run_id=? ORDER BY at,id').all(id).map(row=>({...row,payload:JSON.parse(row.payload)}));},
    close(){db.close();}
  };
}
