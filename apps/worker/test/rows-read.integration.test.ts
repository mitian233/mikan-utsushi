import { env,reset,runInDurableObject } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';

afterEach(async()=>{await reset();});
async function schedulingReads(count:number){
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 return runInDurableObject(ns.get(ns.idFromName(`qq:group:rows-${count}`)),async(_instance,state)=>{
  const sql=state.storage.sql;
  sql.exec(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?)
   INSERT INTO qq_turns(id,status,termination,created_at,settled_at) SELECT i,'completed','silent',i,i FROM seq`,count);
  sql.exec("INSERT INTO qq_turns(status,created_at) VALUES('queued',?)",count+1);
  sql.exec("INSERT INTO qq_turns(status,attempt_count,created_at) VALUES('active',1,?)",count+2);
  const queued=sql.exec("SELECT id FROM qq_turns WHERE status='queued' ORDER BY id LIMIT 1"),queuedRows=queued.toArray(),queuedReads=queued.rowsRead;
  const active=sql.exec("SELECT id,status,attempt_count,retry_at FROM qq_turns WHERE status IN ('active','retry_wait') LIMIT 1"),activeRows=active.toArray(),activeReads=active.rowsRead;
  return {queuedRows,activeRows,queuedReads,activeReads};
 });
}
it('finds queued and active work through bounded indexes after twenty thousand settled turns',async()=>{
 const small=await schedulingReads(2000),large=await schedulingReads(20000);
 expect(large.queuedRows).toEqual([{id:20001}]);expect(large.activeRows).toEqual([{id:20002,status:'active',attempt_count:1,retry_at:null}]);
 expect(small.queuedReads).toBeLessThanOrEqual(1);expect(large.queuedReads).toBe(small.queuedReads);
 expect(small.activeReads).toBeLessThanOrEqual(1);expect(large.activeReads).toBe(small.activeReads);
});
