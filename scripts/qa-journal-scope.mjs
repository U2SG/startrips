import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/** Exercises the actual control without a key/remount hiding its scope cleanup. */
export async function verifyJournalScope(browser, origin, output) {
  await writeFile(`${output}/scope.html`, '<!doctype html><html><meta charset="utf-8"><div id="root"></div><script type="module" src="./scope.tsx"></script></html>');
  await writeFile(`${output}/scope.tsx`, `
import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JournalImportControl} from '/src/journey/JournalImportControl';
const qa=window.__scope={runs:[],busy:false,previews:0,cancels:0,mounts:0,phase:'observing'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const done={status:'completed',draft:{revision:0,chapters:[]}};
function makeClient(){return {
 prepare:async(input,requestId,signal)=>{const run={input,signal,submit:deferred(),observe:deferred(),cancel:deferred()};qa.runs.push(run);return {...input,requestId,run}},
 submit:async prepared=>{const run=prepared.run;run.id=prepared.requestId;return qa.phase==='submitting'?run.submit.promise:run.id},
 observe:async(id,input,signal,progress)=>{const run=qa.runs.find(r=>r.id===id);run.progress=progress;run.signal=signal;progress({phase:'receiving',characters:10,chunks:1});if(qa.phase==='paused')throw Error('synthetic disconnect');return run.observe.promise},
 cancel:async(id,input,signal)=>{qa.cancels++;const run=qa.runs.find(r=>r.id===id);run.signal=signal;return run.cancel.promise}
}}
const initialClient=makeClient();
function Harness(){
 const [client,setClient]=useState(()=>initialClient),[journey,setJourney]=useState('journey-a'),[atlas,setAtlas]=useState('atlas-a');
 const [busy,setBusy]=useState(false);const control=useRef(null);const mounted=useRef(false);
 if(!mounted.current){mounted.current=true;qa.mounts++}
 qa.switchScope=kind=>{qa.phase='observing';if(kind==='client')setClient(makeClient());else if(kind==='journey')setJourney('journey-b');else setAtlas('atlas-b')};
 qa.late=()=>{const run=qa.runs[0];run.submit.resolve(run.id);run.progress?.({phase:'receiving',characters:999999,chunks:99});run.observe.resolve(done);run.cancel.resolve({status:'cancelled'})};
 return <><output aria-label="parent busy">{String(busy)}</output><JournalImportControl client={client} control={control}
 input={{journeyId:journey,atlasId:atlas,source:'2028-06-03 实际：合成记录',fallbackDate:'2028-06-03'}} disabled={false}
 onBusy={value=>{qa.busy=value;setBusy(value)}} onPreview={()=>qa.previews++}/></>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
  const context = await browser.newContext({viewport:{width:390,height:844}});
  const page = await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  let cases=0;
  try {
    for(const kind of ['client','journey','atlas']) for(const phase of ['submitting','observing','paused','stopping']) {
      await page.goto(`${origin}/${output}/scope.html`);
      await page.evaluate(value=>window.__scope.phase=value,phase);
      const start=page.getByRole('button',{name:'用 AI 导入',exact:true});
      await start.click(); await page.waitForFunction(()=>window.__scope.busy);
      if(phase==='paused') await page.getByRole('button',{name:'继续接收',exact:true}).waitFor();
      else if(phase==='submitting') await page.getByText('正在开始导入…',{exact:true}).waitFor();
      else await page.getByText('正在接收 · 10 字',{exact:true}).waitFor();
      if(phase==='stopping') {await page.getByRole('button',{name:'停止',exact:true}).click();await page.waitForFunction(()=>window.__scope.cancels===1)}
      const instance=await start.elementHandle();
      await page.evaluate(value=>window.__scope.switchScope(value),kind);
      await page.waitForFunction(()=>!window.__scope.busy);
      assert.equal(await instance.evaluate(el=>el===document.querySelector('button')),true,'control must retain its DOM instance');
      assert.equal(await start.isEnabled(),true); assert.equal(await page.getByLabel('parent busy').textContent(),'false');
      assert.equal(await page.evaluate(()=>window.__scope.runs[0].signal.aborted),true);
      await start.click(); await page.waitForFunction(()=>window.__scope.runs.length===2 && window.__scope.busy);
      await page.evaluate(()=>window.__scope.late());
      await page.getByText('正在接收 · 10 字',{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>({busy:window.__scope.busy,previews:window.__scope.previews,cancels:window.__scope.cancels,mounts:window.__scope.mounts})),
        {busy:true,previews:0,cancels:phase==='stopping'?1:0,mounts:1});
      assert.equal(await start.isDisabled(),true);
      const target=await page.evaluate(()=>window.__scope.runs[1].input);
      assert.equal(target.journeyId,kind==='journey'?'journey-b':'journey-a');assert.equal(target.atlasId,kind==='atlas'?'atlas-b':'atlas-a');
      await page.evaluate(()=>window.__scope.runs[1].observe.resolve({status:'completed',draft:{revision:0,chapters:[]}}));
      await page.waitForFunction(()=>window.__scope.previews===1 && !window.__scope.busy);
      cases++;
    }
    assert.deepEqual(errors,[]);
    return cases;
  } finally {await context.close()}
}
