import { importDiagnostic } from "../admin/journal-import-diagnostic";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { pool } from "../db/client";
import { submitJournalJob, readJournalJob, cancelJournalJob, jobView, type JobInput } from "../itinerary/journal-import-jobs";
import { Hono } from "hono";
import { AtlasAccessError, requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import { readJsonObject } from "./json-body";
import { prepareAuthorizedJournalImport, journalProviderInfo } from "../itinerary/journal-import-service";
import { hash } from "../admin/journal-import";

/** One-sentence + attached source entry point, with the same use-case as offline administration. */
export const journalImportIntentRoutes = new Hono();
journalImportIntentRoutes.onError((error,c)=>{
  if(error instanceof HTTPException)return error.getResponse();
  if(error instanceof AtlasAccessError)return c.json({error:error.code},error.status);
  const diagnostic=importDiagnostic(error,"llm-preview");
  const code=diagnostic.error;
  const status=code==="TARGET_NOT_FOUND"||code==="TARGET_PERMISSION_DENIED"?404:code==="INVALID_IMPORT"||code==="INVALID_TARGET"?400:code==="JOURNAL_JOB_BUSY"||code==="JOURNAL_JOB_CONFLICT"?409:"status" in diagnostic?diagnostic.status:500;
  return c.json(diagnostic,status as 400);
});
journalImportIntentRoutes.post("/journal-import", async c => {
  c.header("Cache-Control", "private, no-store");
  if (c.req.header("origin") !== serverConfig.appOrigin) return c.json({ error: "JOURNAL_ORIGIN_REQUIRED" }, 403);
  const { atlas, session } = await requireAtlasAccess(c.req.raw, "update");
  const body = await readJsonObject(() => c.req.json());
  if (!body || typeof body.journeyId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.journeyId)
    || typeof body.sentence !== "string" || typeof body.source !== "string" || typeof body.fallbackDate !== "string") return c.json({ error: "INVALID_IMPORT" }, 400);
  try {
  const envelope = await prepareAuthorizedJournalImport({ userId: session.user.id, email: session.user.email, atlasId: atlas.id, journeyId: body.journeyId },
    { sentence: body.sentence, source: body.source, fallbackDate: body.fallbackDate, provider: body.provider });
  return c.json({ intent: "journal-import", stage: "journal-preview", envelope, planDigest: hash(envelope),
    next: { journal: `/api/journeys/${body.journeyId}/journal`, hotels: `/api/journeys/${body.journeyId}/journal/hotels/preview` } });
  } catch (error) {
    if (error instanceof Error && ["TARGET_NOT_FOUND", "TARGET_PERMISSION_DENIED", "INVALID_TARGET"].includes(error.message)) return c.json({ error: "JOURNEY_NOT_FOUND" }, 404);
    throw error;
  }
});

journalImportIntentRoutes.get('/journal-import/provider', async c=>{
  await requireAtlasAccess(c.req.raw,'update', {disableCookieCache:true});
  c.header('Cache-Control','private, no-store');
  return c.json(journalProviderInfo());
});
journalImportIntentRoutes.post('/journal-import/jobs',async c=>{
  if(c.req.header('origin')!==serverConfig.appOrigin)return c.json({error:'JOURNAL_ORIGIN_REQUIRED'},403);
  const {atlas,session}=await requireAtlasAccess(c.req.raw,'update', {disableCookieCache:true});
  const body=await readJsonObject(()=>c.req.json());
  if(!body||typeof body.journeyId!=='string'||typeof body.requestId!=='string')return c.json({error:'INVALID_IMPORT'},400);
  const target={userId:session.user.id,email:session.user.email,atlasId:atlas.id,journeyId:body.journeyId};
  c.header('Cache-Control','private, no-store');
  return c.json(await submitJournalJob(target,body.requestId,body as unknown as JobInput),202);
});
async function authorizedJob(c:Context) {
  const {atlas,session}=await requireAtlasAccess(c.req.raw,'update', {disableCookieCache:true});
  const id=c.req.param('jobId');
  if(!id||!/^[a-f0-9-]{36}$/i.test(id))throw new HTTPException(404);
  // Resolve the journey only within the authenticated account/Atlas; then recheck domain access.
  const {rows}=await pool.query('SELECT journey_id FROM journal_import_jobs WHERE id=$1 AND user_id=$2 AND atlas_id=$3',[id,session.user.id,atlas.id]);
  if(!rows[0])throw new HTTPException(404);
  const target={userId:session.user.id,email:session.user.email,atlasId:atlas.id,journeyId:rows[0].journey_id};
  return {id,target,row:await readJournalJob(target,id)};
}
journalImportIntentRoutes.get('/journal-import/jobs/:jobId',async c=>{
  c.header('Cache-Control','private, no-store');return c.json(jobView((await authorizedJob(c)).row));
});
journalImportIntentRoutes.post('/journal-import/jobs/:jobId/cancel',async c=>{
  if(c.req.header('origin')!==serverConfig.appOrigin)return c.json({error:'JOURNAL_ORIGIN_REQUIRED'},403);
  const {target,id}=await authorizedJob(c);return c.json(await cancelJournalJob(target,id));
});
journalImportIntentRoutes.get('/journal-import/jobs/:jobId/events',async c=>{
  const {target,id}=await authorizedJob(c);
  c.header('Cache-Control','private, no-store');c.header('X-Accel-Buffering','no');
  return streamSSE(c,async stream=>{
    let closed=false;stream.onAbort(()=>{closed=true;});
    // Reconnect observes the same durable job and never triggers a model request.
    const until=Date.now()+60_000;let previous='';
    while(!closed&&Date.now()<until){
      const authorized=await authorizedJob(c);
      if(authorized.target.atlasId!==target.atlasId||authorized.target.userId!==target.userId)return;
      const view=jobView(authorized.row);const value=JSON.stringify(view);
      const terminal=['completed','failed','cancelled','interrupted'].includes(view.status);
      if(value!==previous||terminal){await stream.writeSSE({event:view.status==='interrupted'?'failed':terminal?view.status:'progress',data:value});previous=value;}
      if(terminal)return;
      await stream.sleep(500);
    }
  });
});
