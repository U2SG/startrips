import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { launchQaBrowser } from './qa-browser.mjs';
import { verifyJournalScope } from './qa-journal-scope.mjs';
const origin = process.env.QA_ORIGIN ?? 'http://127.0.0.1:4173';
const output = 'artifacts/qa-journal-streaming-ui';
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await mkdir(output, { recursive: true });
await writeFile(`${output}/index.html`, '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="./harness.tsx"></script></html>');
await writeFile(`${output}/harness.tmp.tsx`, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DailyJournalPanel } from '/src/journey/DailyJournalPanel';
import { createJournalImportClient } from '/src/journey/journalImportApi';
import { previewJournalImport } from '/src/journey/dailyJournal';
import { AtlasViewProvider, createOwnerAtlasView } from '/src/journey/atlasView';
import '/src/styles/tokens.css';
import '/src/styles/controls.css';
import '/src/app.css';
const jobMap = new Map();
const frame = (event, data) => new TextEncoder().encode('event: ' + event + '\\r\\ndata: ' + JSON.stringify(data) + '\\r\\n\\r\\n');
const qa = window.__qa = { posts: 0, cancels: 0, observes: 0, snapshots: 0, writes: 0, closed: 0, scope: 0, account: 0, holdSubmit: false, holdCancel: false, jobs: [] };
const inputFor = scope => ({ id: scope ? '33333333-3333-4333-8333-333333333333' : '11111111-1111-4111-8111-111111111111', atlasId: scope ? 'other-atlas' : 'fictional-atlas', title: scope ? '另一合成旅程' : '合成流式验收旅程', startedOn: '2028-06-01', endedOn: null, note: '', lightColor: '#ffffff', revision: 0, createdByUserId: 'fictional', createdAt: '2028-06-01T00:00:00Z', updatedAt: '2028-06-01T00:00:00Z', routePoints: [], media: [] });
const progress = job => ({ jobId: job.id, status: job.status, phase: 'receiving', characters: job.characters, chunks: 1 });
function snapshot(job) { return job.final ?? progress(job); }
function emit(job, event, data) { for (const c of job.controllers) { try { c.enqueue(frame(event, data)); } catch {} } }
qa.progress = (index, characters) => { const job = qa.jobs[index]; job.characters = characters; emit(job, 'progress', progress(job)); };
qa.complete = index => { const job = qa.jobs[index], chapters = previewJournalImport(job.body.source, job.body.fallbackDate); job.status = 'completed'; job.final = { jobId: job.id, status: 'completed', planDigest: 'a'.repeat(64), envelope: { signature: 'b'.repeat(64), plan: { version: 2, target: { journeyId: job.body.journeyId, atlasId: job.atlasId }, before: { revision: 0, chapters: [] }, after: { revision: 1, chapters }, importedChapterIds: chapters.map(c => c.id), expires: Date.now() + 3600000 } } }; emit(job, 'completed', job.final); };
qa.disconnect = index => { for (const c of qa.jobs[index].controllers) { try { c.close(); } catch {} } };
qa.failPartial = index => { const job = qa.jobs[index]; job.status = 'failed'; job.final = {jobId:job.id,status:'failed',error:'INTENT_STREAM_INVALID'}; for(const c of job.controllers) {try {c.enqueue(new TextEncoder().encode('event: completed\\ndata: {')); c.close();} catch {}} };
async function fetcher(url, options = {}) {
  if (url.endsWith('/provider')) return Response.json({available:true,baseUrl:'provider:synthetic',model:'synthetic',displayName:'synthetic.invalid'});
  if (url.endsWith('/jobs') && options.method === 'POST') {
    qa.posts++; const body = JSON.parse(options.body); const job = {id:body.requestId,body,atlasId:inputFor(qa.scope).atlasId,status:'running',characters:1,controllers:[]}; jobMap.set(job.id,job); qa.jobs.push(job);
    if (qa.holdSubmit) return new Promise(resolve => {qa.accept = () => resolve(Response.json({jobId:job.id}));});
    return Response.json({jobId:job.id});
  }
  const match = /\\/jobs\\/([^/]+)(?:\\/(events|cancel))?$/.exec(url); if (!match) throw Error('Unexpected synthetic request ' + url);
  const job = jobMap.get(match[1]); if (!job) return new Response('',{status:404});
  if (match[2] === 'cancel') {
    qa.cancels++; const stopped = () => {job.status='cancelled';job.final={jobId:job.id,status:'cancelled'};return Response.json(job.final)};
    if (qa.holdCancel) return new Promise(resolve=>{qa.cancelled=()=>resolve(stopped())}); return stopped();
  }
  if (match[2] === 'events') {
    qa.observes++; return new Response(new ReadableStream({start(c){job.controllers.push(c); c.enqueue(frame(job.final ? job.final.status : 'progress', snapshot(job)));}}),{headers:{'content-type':'text/event-stream'}});
  }
  qa.snapshots++; return Response.json(snapshot(job));
}
const client = { importJournal:createJournalImportClient(fetcher), read:async()=>({revision:0,chapters:[]}), save:async(_id,draft)=>{qa.writes++; return {...draft,revision:1}}, suggest:async()=>[] };
function Harness() {
  const [scope,setScope]=useState(0), [account,setAccount]=useState(0), [open,setOpen]=useState(true);
  qa.switchJourney=()=>{qa.scope++;setScope(qa.scope)}; qa.switchAccount=()=>{qa.account++;setAccount(qa.account)};
  return <AtlasViewProvider value={createOwnerAtlasView()}>{open ? <DailyJournalPanel key={account+':'+scope} journey={inputFor(scope)} client={client} onClose={()=>{qa.closed++;setOpen(false)}} onPoint={()=>{}}/> : <p>面板已关闭</p>}</AtlasViewProvider>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
await rename(`${output}/harness.tmp.tsx`, `${output}/harness.tsx`);
const browser = await launchQaBrowser();
let cases = 0;
try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport }); const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const open = async () => { await page.goto(`${origin}/${output}/index.html`); await page.getByRole('button', {name:'用 AI 导入',exact:true}).waitFor(); };
    const fill = async marker => { try { await page.locator('.daily-journal__import textarea').fill(`2028-06-03\n23:30 实际：她在虚构城入住${marker}酒店。`, {timeout:5000}); } catch(error) { console.log(JSON.stringify({marker,body:await page.locator('body').innerText(),errors})); await page.screenshot({path:output+'/failure.png'}); throw error; } };
    const start = async () => { await page.getByRole('button',{name:'用 AI 导入',exact:true}).click(); await page.waitForFunction(()=>window.__qa.observes===1); };
    const noDraft = async () => assert.equal(await page.getByRole('button',{name:'确认保存',exact:true}).count(),0);
    const noOverflow = async () => assert.equal(await page.locator('.daily-journal').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
    await open(); await fill('持续接收'); await start();
    await page.evaluate(()=>window.__qa.progress(0,1250)); await page.getByText('正在接收 · 1,250 字',{exact:true}).waitFor(); await noDraft();
    await noOverflow(); await page.getByRole('button',{name:'停止',exact:true}).scrollIntoViewIfNeeded();
    const box = await page.getByRole('button',{name:'停止',exact:true}).boundingBox(); assert.ok(box && box.x>=0 && box.y>=0 && box.x+box.width<=viewport.width+1 && box.y+box.height<=viewport.height+1);
    await page.screenshot({path:`${output}/progress-${viewport.width}x${viewport.height}.png`});
    await page.evaluate(()=>window.__qa.disconnect(0)); await page.waitForFunction(()=>window.__qa.observes===2); assert.equal(await page.evaluate(()=>window.__qa.posts),1);
    await page.evaluate(()=>window.__qa.complete(0)); await page.getByRole('button',{name:'确认保存',exact:true}).waitFor(); assert.equal(await page.evaluate(()=>window.__qa.writes),0);
    await page.getByRole('button',{name:'确认保存',exact:true}).click(); await page.getByText('手记已保存。',{exact:true}).waitFor(); assert.equal(await page.evaluate(()=>window.__qa.writes),1); cases++;

    await open(); await fill('已停止旧请求'); await start(); await page.getByRole('button',{name:'停止',exact:true}).click(); await page.getByText('已停止，原文已保留。',{exact:true}).waitFor();
    await fill('新的'); await page.getByRole('button',{name:'用 AI 导入',exact:true}).click(); await page.waitForFunction(()=>window.__qa.observes===2);
    await page.evaluate(()=>{window.__qa.progress(0,999999);window.__qa.complete(0);window.__qa.progress(1,2400)});
    await page.getByText('正在接收 · 2,400 字',{exact:true}).waitFor(); await noDraft();
    assert.equal(await page.locator('.daily-journal__import textarea').inputValue(),'2028-06-03\n23:30 实际：她在虚构城入住新的酒店。');
    await page.evaluate(()=>window.__qa.complete(1)); await page.getByRole('button',{name:'确认保存',exact:true}).waitFor();
    assert.equal(await page.getByLabel('阅读正文',{exact:true}).first().inputValue(),'23:30 实际：她在虚构城入住新的酒店。'); assert.equal(await page.evaluate(()=>window.__qa.writes),0); cases++;

    await open(); await fill('提交中停止'); await page.evaluate(()=>window.__qa.holdSubmit=true); await page.getByRole('button',{name:'用 AI 导入',exact:true}).click(); await page.waitForFunction(()=>window.__qa.posts===1);
    await page.getByRole('button',{name:'停止',exact:true}).click(); await page.getByText('正在停止…',{exact:true}).waitFor(); await page.evaluate(()=>window.__qa.accept());
    await page.getByText('已停止，原文已保留。',{exact:true}).waitFor(); assert.deepEqual(await page.evaluate(()=>[window.__qa.posts,window.__qa.observes,window.__qa.cancels]),[1,0,1]); await noDraft(); cases++;

    for (const switcher of ['switchJourney','switchAccount']) {
      await open(); await fill('旧身份'); await start(); await page.evaluate(name=>window.__qa[name](),switcher);
      await page.waitForFunction(()=>document.querySelector('textarea')?.value==='');
      await page.evaluate(()=>{window.__qa.progress(0,999999);window.__qa.complete(0)}); await noDraft();
      assert.equal(await page.getByText('正在接收 · 999,999 字',{exact:true}).count(),0); assert.equal(await page.evaluate(()=>window.__qa.cancels),0);
      await fill('新身份'); await page.getByRole('button',{name:'用 AI 导入',exact:true}).click(); await page.waitForFunction(()=>window.__qa.observes===2); await page.evaluate(()=>window.__qa.complete(1));
      await page.getByRole('button',{name:'确认保存',exact:true}).waitFor(); assert.equal(await page.getByLabel('阅读正文',{exact:true}).first().inputValue(),'23:30 实际：她在虚构城入住新身份酒店。'); cases++;
    }

    await open(); await fill('断流'); await start(); await page.evaluate(()=>window.__qa.failPartial(0)); await page.getByRole('alert').filter({hasText:'未能完成导入'}).waitFor(); await noDraft(); assert.equal(await page.evaluate(()=>window.__qa.writes),0); cases++;

    await open(); await fill('离开前停止'); await start(); await page.evaluate(()=>window.__qa.holdCancel=true); await page.getByRole('button',{name:'返回 Stream',exact:true}).click();
    await page.getByRole('button',{name:'丢弃并返回',exact:true}).click(); await page.waitForFunction(()=>window.__qa.cancels===1); assert.equal(await page.evaluate(()=>window.__qa.closed),0);
    await page.evaluate(()=>window.__qa.cancelled()); await page.getByText('面板已关闭',{exact:true}).waitFor(); assert.equal(await page.evaluate(()=>window.__qa.closed),1); cases++;
    assert.deepEqual(errors,[]); await context.close();
  }
  cases += await verifyJournalScope(browser, origin, output);
  console.log(JSON.stringify({cases,viewports:['320x568','390x844','844x390'],screenshots:output,source}));
} finally { await browser.close(); }
