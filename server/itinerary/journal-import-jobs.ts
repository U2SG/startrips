import { isPersistedCalendarDate } from "../../src/journey/calendarDate";
import { JOURNAL_MAX_TEXT } from "../../src/journey/dailyJournal";
/** Durable preview jobs: the application owns the model request, not an SSH/client connection. */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { pool, db } from '../db/client';
import { hash, lockedTarget, sealJournalDraft, type Target, type Envelope } from '../admin/journal-import';
import { journalImportModel, journalProviderInfo } from './journal-import-service';
import { prepareJournalImport } from './journal-import-workflow';
import { importDiagnostic } from '../admin/journal-import-diagnostic';
export type JobInput = { sentence: string; source: string; fallbackDate: string; provider: {baseUrl:string;model:string} };
const fail = (code:string):never => {throw new Error(code);};
export async function submitJournalJob(target:Target, requestId:string, input:JobInput) {
  if(!target||!input||!input.provider)fail('INVALID_IMPORT');
  target={userId:target.userId,email:target.email,atlasId:target.atlasId,journeyId:target.journeyId};
  input={source:input.source,sentence:input.sentence,fallbackDate:input.fallbackDate,provider:{baseUrl:input.provider.baseUrl,model:input.provider.model}};
  if (!/^[a-f0-9-]{36}$/i.test(requestId) || typeof input.source !== 'string' || input.source.length > JOURNAL_MAX_TEXT || !input.source.trim() || typeof input.sentence !== 'string' || input.sentence.length > 500 || !input.sentence.trim() || !isPersistedCalendarDate(input.fallbackDate)) fail('INVALID_IMPORT');
  const configured=journalImportModel(input.provider);
  const identity=journalProviderInfo();input.provider={baseUrl:identity.baseUrl,model:identity.model};
  const configDigest=hash({baseUrl:configured.baseUrl,model:configured.model,apiKey:configured.apiKey});
  const digest=hash({target,input,configDigest});
  await db.transaction(async tx=>{
    const before=await lockedTarget(tx,target);
    const existing=await tx.execute(sql`SELECT input_digest,user_id FROM journal_import_jobs WHERE id=${requestId}`);
    if(existing.rows.length){
      if(existing.rows[0].user_id!==target.userId||existing.rows[0].input_digest!==digest)fail('JOURNAL_JOB_CONFLICT');
      return;
    }
    // Atlas lock serializes submissions; one active job per Atlas bounds cost and queue growth.
    const active=await tx.execute(sql`SELECT id FROM journal_import_jobs WHERE atlas_id=${target.atlasId} AND status IN ('queued','running') LIMIT 1`);
    if(active.rows.length)fail('JOURNAL_JOB_BUSY');
    const payload=JSON.stringify({target,input,before,configDigest});
    const inserted=await tx.execute(sql`INSERT INTO journal_import_jobs (id,user_id,atlas_id,journey_id,input_digest,payload) VALUES (${requestId},${target.userId},${target.atlasId},${target.journeyId},${digest},${payload}::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`);
    if(!inserted.rows.length)fail('JOURNAL_JOB_CONFLICT');
  });
  return {jobId:requestId};
}
export async function readJournalJob(target:Target,id:string):Promise<Record<string,any>> {
  return db.transaction(async tx=>{
    await lockedTarget(tx,target);
    const result=await tx.execute(sql`SELECT * FROM journal_import_jobs WHERE id=${id} AND user_id=${target.userId} AND atlas_id=${target.atlasId} AND journey_id=${target.journeyId}`);
    const row=result.rows[0] as Record<string,any>|undefined;if(!row)return fail('TARGET_NOT_FOUND');return {...row,envelope:typeof row.envelope==='string'?JSON.parse(row.envelope):null};
  });
}
export function jobView(row:any) {
  const common={jobId:row.id,status:row.status,phase:row.phase,characters:row.characters,chunks:row.chunks};
  const {status:statusCode,...error}=row.error??{};
  return row.status==='completed' ? {...common,envelope:row.envelope as Envelope,planDigest:hash(row.envelope)} : row.error ? {...common,...error,...(statusCode?{statusCode}:{})} : common;
}
export async function cancelJournalJob(target:Target,id:string) {
  await db.transaction(async tx=>{
    await lockedTarget(tx,target);
    const result=await tx.execute(sql`SELECT id FROM journal_import_jobs WHERE id=${id} AND user_id=${target.userId} AND atlas_id=${target.atlasId} AND journey_id=${target.journeyId} FOR UPDATE`);
    if(!result.rows.length)fail('TARGET_NOT_FOUND');
    await tx.execute(sql`UPDATE journal_import_jobs SET status='cancelled',updated_at=now(),payload=NULL WHERE id=${id} AND status IN ('queued','running')`);
  });
  return jobView(await readJournalJob(target,id));
}
/** Single step is also injectable in integration tests. No automatic replay of failed/interrupted calls. */
export async function runJournalJob(signal?:AbortSignal) {
  await pool.query(`DELETE FROM journal_import_jobs WHERE created_at < now()-interval '24 hours' AND status NOT IN ('running','queued')`);
  await pool.query(`UPDATE journal_import_jobs SET status='interrupted',payload=NULL,error='{"error":"JOURNAL_JOB_INTERRUPTED","kind":"operation"}',updated_at=now() WHERE status='running' AND updated_at < now()-interval '20 seconds'`);
  const token=randomUUID();
  const {rows}=await pool.query(`UPDATE journal_import_jobs SET status='running',phase='connecting',lease=$1,updated_at=now() WHERE id=(SELECT id FROM journal_import_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[token]);
  const row=rows[0];if(!row)return;
  const controller=new AbortController(); const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let progress={phase:'connecting',characters:0,chunks:0};let ticking=false;
  const heartbeat=setInterval(()=>{if(ticking)return;ticking=true;void pool.query(`UPDATE journal_import_jobs SET phase=$3,characters=$4,chunks=$5,updated_at=now() WHERE id=$1 AND lease=$2 AND status='running' RETURNING id`,[row.id,token,progress.phase,progress.characters,progress.chunks]).then(r=>{if(!r.rowCount)controller.abort();}).catch(()=>controller.abort()).finally(()=>{ticking=false;});},500);
  try {
    const {target,input,before,configDigest}=row.payload;
    const current=await db.transaction(tx=>lockedTarget(tx,target));if(hash(current)!==hash(before))fail('JOURNAL_CHANGED');
    const model=journalImportModel(input.provider);
    if(hash({baseUrl:model.baseUrl,model:model.model,apiKey:model.apiKey})!==configDigest)fail('JOURNAL_PROVIDER_CHANGED');
    model.stream={signal:controller.signal,onProgress:p=>{progress=p;}};
    const draft=await prepareJournalImport(input,before,model);
    progress={...progress,phase:'validating'};
    const finalModel=journalImportModel(input.provider);
    if(hash({baseUrl:finalModel.baseUrl,model:finalModel.model,apiKey:finalModel.apiKey})!==configDigest)fail('JOURNAL_PROVIDER_CHANGED');
    await db.transaction(async tx=>{
      if(hash(await lockedTarget(tx,target))!==hash(before))fail('JOURNAL_CHANGED');
      if(controller.signal.aborted)fail('JOURNAL_JOB_INTERRUPTED');
      const envelope=sealJournalDraft(target,input.source,before,draft.chapters,draft.importedChapterIds,input.provider);
      await tx.execute(sql`UPDATE journal_import_jobs SET status='completed',phase='validating',envelope=${JSON.stringify(envelope)},payload=NULL,characters=${progress.characters},chunks=${progress.chunks},updated_at=now() WHERE id=${row.id} AND lease=${token} AND status='running'`);
    });
  } catch(error) {
    const diagnostic=importDiagnostic(error,'llm-preview');
    await pool.query(`UPDATE journal_import_jobs SET status=$3,error=$4,payload=NULL,updated_at=now() WHERE id=$1 AND lease=$2 AND status='running'`,[row.id,token,signal?.aborted?'interrupted':'failed',JSON.stringify(diagnostic)]);
  } finally {clearInterval(heartbeat);signal?.removeEventListener('abort',abort);controller.abort();}
}
export function startJournalImportWorker() {
  const controller=new AbortController();let active:Promise<void>|undefined;
  const tick=()=>{if(!active&&!controller.signal.aborted)active=runJournalJob(controller.signal).catch(()=>undefined).finally(()=>{active=undefined;});};
  const timer=setInterval(tick,1000);tick();
  return {stop:async()=>{clearInterval(timer);controller.abort();await active;}};
}
