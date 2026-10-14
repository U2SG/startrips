import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "vite";
import { launchQaBrowser } from "./qa-browser.mjs";
const baseline = process.argv.includes("--baseline");
const width = Number(process.argv.find(arg=>/^\d+$/.test(arg)) ?? 390);
const retryProof = process.argv.includes("--retry-baseline") ? "retry-baseline" : "retry-fixed";
const out = `artifacts/story-repair/${baseline ? "baseline" : `${retryProof}-${width}`}`;
await fs.mkdir(out, {recursive:true});
const server = process.env.QA_ORIGIN ? null : await createServer({server:{host:"127.0.0.1",port:4297,strictPort:true},logLevel:"error"});
if (server) await server.listen();
const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4297";
const browser = await launchQaBrowser({args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const page = await browser.newPage({viewport:{width,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,reducedMotion:"reduce",recordVideo:{dir:`${out}/raw`,size:{width,height:844}}});
page.setDefaultTimeout(10000);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const now = "2026-10-01T00:00:00.000Z";
const journey = {id:id(1),atlasId:id(2),title:"沿途的光与文字",startedOn:"2026-10-01",endedOn:"2026-10-03",note:"在路上，不着急。每一段路都值得慢慢读。\n".repeat(48),lightColor:"#77c8c2",lightEffect:null,coverMediaAssetId:null,revision:1,createdByUserId:id(3),createdAt:now,updatedAt:now,
 routePoints:[{id:id(4),label:"海边",note:null},{id:id(5),label:"山间的一页",note:"这里没有拍照，只留下了这段感想。\n".repeat(28)},{id:id(6),label:"返程",note:null}].map((p,i)=>({...p,journeyId:id(1),sortOrder:i,latitude:22.5+i,longitude:114+i,isStop:true,occurredAt:null,createdAt:now})),
 media:[{id:id(100),routePointId:id(4),fileName:"coast.jpg"},{id:id(101),routePointId:id(6),fileName:"return.jpg"}].map((a,i)=>({...a,journeyId:id(1),storageDriver:"qa",storageKey:`qa/${i}.jpg`,mimeType:"image/jpeg",bytes:100,sortOrder:i,uploadedByUserId:id(3),createdAt:now}))};
const session = {session:{id:"qa-session",userId:id(3),token:"qa-token",expiresAt:"2099-01-01T00:00:00.000Z",createdAt:now,updatedAt:now,activeOrganizationId:"qa-org"},user:{id:id(3),name:"QA",email:"qa@example.com",emailVerified:true,createdAt:now,updatedAt:now}};
let style = "book";
let rejectNextSave = false;
let rejectNextRead = false;
let preferenceReads = 0;
let holdNextSave = false;
let releaseSave = () => {};
const saves = [], errors = [], result = {baseline};
const json = (body,status=200) => ({status,contentType:"application/json",body:JSON.stringify(body)});
page.on("pageerror",e=>errors.push(e.message));
await page.route("**/api/auth/**",route=>{const path=new URL(route.request().url()).pathname;return route.fulfill(json(path.endsWith("/get-session") ? session : path.endsWith("/organization/list") ? [{id:"qa-org",name:"QA Atlas",slug:"qa-atlas"}] : {}));});
await page.route("**/api/account-preferences/media-presentation",async route=>{if(route.request().method()==="GET"){preferenceReads++;if(rejectNextRead){rejectNextRead=false;return route.fulfill(json({error:"read-unavailable"},500));}}if(route.request().method()==="PUT"){const next=route.request().postDataJSON().style;saves.push(next);if(holdNextSave){holdNextSave=false;await new Promise(resolve=>{releaseSave=resolve;});}if(rejectNextSave){rejectNextSave=false;return route.fulfill(json({error:"rejected"},500));}style=next;}return route.fulfill(json({style}));});
await page.route("**/api/account-preferences/earth-experience",route=>route.fulfill(json({earthExperience:"default",revision:0,updatedAt:null})));
await page.route("**/api/atlases/current",route=>route.fulfill(json({atlas:{id:id(2),title:"QA Atlas",dedication:"同行"},role:"owner"})));
await page.route("**/api/journeys",route=>route.fulfill(json({journeys:[journey]})));
await page.route("**/api/home-bases",route=>route.fulfill(json({periods:[]})));
await page.route("**/api/media-evidence/*",route=>route.fulfill(json({evidence:{mediaAssetId:new URL(route.request().url()).pathname.split('/').at(-1),revision:0,recorded:{spatial:{source:"unknown",granularity:"unknown",latitude:null,longitude:null,accuracyMeters:null,label:null},captureTime:{source:"unknown",timezone:"unknown",local:null,instant:null,offsetMinutes:null}},display:{hidden:false,correction:null},effective:null,updatedAt:null}})));

await page.route("**/api/home-bases/dismissal",route=>route.fulfill(json({dismissals:[]})));
await page.route("**/api/uploads/assets/*/read-url",route=>route.fulfill(json({url:`${origin}/artworks/${route.request().url().includes(id(100)) ? "hokusai-wave.jpg" : "monet-water-lilies.jpg"}`,expiresAt:"2099-01-01T00:00:00.000Z"})));
const activeReader = () => page.evaluate(()=>document.querySelector('.journey-book-3d') ? "book-3d" : document.querySelector('.journey-book') ? "book" : document.querySelector('.journey-stream') ? "stream" : document.querySelector('.journey-story') ? "classic" : "none");
async function swipeUp(element, distance=180){
 const box=await element.boundingBox();assert.ok(box);
 const x=Math.min(330,Math.max(60,box.x+box.width/2));
 const y=Math.min(700,Math.max(350,box.y+box.height*0.65));
 const cdp=await page.context().newCDPSession(page);
 await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y}]});
 for(let i=1;i<=8;i++){await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x,y:y-distance*i/8}]});await page.waitForTimeout(16);}
 await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});await cdp.detach();
}
async function choose(next){
 await page.getByRole("combobox",{name:"切换媒体呈现",exact:true}).selectOption(next);
 await waitStyle(next);
}
async function waitStyle(next){
 await page.waitForFunction(expected=>{
  const picker=document.querySelector('select[aria-label="切换媒体呈现"]');
  const selector=expected==="book"?".journey-book":expected==="book-3d"?".journey-book-3d":expected==="stream"?".journey-stream":".journey-story";
  const reader=document.querySelector(selector);
  return reader&&picker?.value===expected&&!picker.disabled&&(!["classic","note-overlay"].includes(expected)||reader.dataset.storyPresentation===expected);
 },next);
}
try {
 await page.goto(`${origin}/?qaState=atlas-gateway&qaLite=1`,{waitUntil:"networkidle"});
 await page.locator('.mobile-v2__journey-chip').click();
 await page.locator('.mobile-v2__sheet').getByRole('button',{name:/打开故事/}).click();
 await page.locator('.journey-book').waitFor({state:"visible"});
 await page.screenshot({path:`${out}/01-book.png`});
 result.initialReader=await activeReader();
 if(baseline) await page.getByRole('button',{name:'经典视图',exact:true}).click();
 else await choose('classic');
 await page.locator('.journey-story').waitFor({state:"visible"});
 await page.locator('.mobile-v2__account-trigger').click();
 const account=page.locator('.account-sheet');
 await account.waitFor({state:'visible'});
 await account.locator('[data-media-presentation-entry="sheet"]').click();
 // The account and renderer must agree after the server-confirmed update.
 await page.waitForFunction(()=>!document.querySelector('[aria-label="切换媒体呈现"]')?.disabled);
 result.accountStyle=style;result.readerAfterAccount=await activeReader();
 if(!baseline)assert.equal(await page.locator('.journey-story').getAttribute('data-story-presentation'),style);
 await page.screenshot({path:`${out}/02-account-change.png`});
 if(baseline){await fs.writeFile(`${out}/result.json`,JSON.stringify({...result,saves,errors},null,2));console.log(JSON.stringify(result));}
 else {
  await account.waitFor({state:'detached'});
  assert.equal(await page.locator('[aria-label="切换媒体呈现"]').inputValue(),style);
  assert.deepEqual(await page.getByRole('combobox',{name:'切换媒体呈现',exact:true}).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)),['classic','note-overlay','book','book-3d','stream']);
  await choose('book'); await choose('book-3d'); await choose('stream'); await choose('classic');
  result.bidirectional=true;
  holdNextSave=true;
  const heldRequest=page.waitForRequest(request=>request.url().endsWith('/api/account-preferences/media-presentation')&&request.method()==='PUT');
  await page.getByRole('combobox',{name:'切换媒体呈现',exact:true}).selectOption('book');
  await heldRequest;
  assert.equal(await page.locator('.journey-story__layout').evaluate(el=>el.inert),true);
  assert.equal(await page.locator('.journey-story > footer').evaluate(el=>el.inert),true);
  assert.equal(await page.getByRole('button',{name:'退出旅程故事',exact:true}).isEnabled(),true);
  releaseSave();
  await page.locator('.journey-book').waitFor({state:'visible'});
  await choose('classic');
  assert.equal(await page.locator('.journey-story__layout').evaluate(el=>el.inert),false);
  result.pendingChangeBlocksNewEdit=true;

  const story=page.locator('.journey-story');
  await story.getByRole('button',{name:'选择停靠点',exact:true}).click();
  await story.locator(`[data-route-point-id="${id(5)}"]`).click();
  const note=page.locator('.journey-story [data-current-media-kind="note"] .story-media-pages__note-text');
  await note.waitFor({state:'visible'});
  assert.ok((await note.textContent()).includes('这里没有拍照'));
  result.note=await note.evaluate(el=>{const card=el.closest('.story-media-pages__note');return {background:getComputedStyle(card).backgroundColor,text:el.textContent.length,scroll:el.scrollHeight>el.clientHeight};});
  assert.notEqual(result.note.background,'rgba(0, 0, 0, 0)');
  const noteBefore=await note.evaluate(el=>el.scrollTop);
  await swipeUp(note,130);
  await page.waitForFunction(before=>document.querySelector('.journey-story [data-current-media-kind="note"] .story-media-pages__note-text')?.scrollTop>before+40,noteBefore);
  result.noteNativeScroll=true;
  const paintedNeighbours=await page.locator('.journey-story [data-current-media-kind="note"] > .story-media-pages__page:not([data-media-presented="true"])').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).visibility==='visible').length);
  assert.equal(paintedNeighbours,0);

  await page.screenshot({path:`${out}/03-note-only.png`});
  await choose('book'); await choose('classic');
  await note.waitFor({state:'visible'});result.notePositionPreserved=true;
  // One failed intent must follow the user to the other surface. Do not call
  // choose() to finish a retry: that would hide which request Retry emitted.
  const accountRetryStart=saves.length;
  rejectNextSave=true;
  await page.locator('.mobile-v2__account-trigger').click();
  await account.locator('[data-media-presentation-entry="sheet"]').click();
  await account.getByRole('status').filter({hasText:'无法确认'}).waitFor({state:'visible'});
  assert.deepEqual(saves.slice(accountRetryStart),['note-overlay']);
  await account.locator('.account-sheet__handle').click();
  await account.waitFor({state:'detached'});
  const retryResponse=page.waitForResponse(response=>response.url().endsWith('/api/account-preferences/media-presentation')&&response.request().method()==='PUT');
  await page.locator('.story-presentation-picker__error').getByRole('button',{name:'重试',exact:true}).click();
  await retryResponse;
  assert.deepEqual(saves.slice(accountRetryStart),['note-overlay','note-overlay'],
    'Account failure was retried as a stale Story style');
  await waitStyle('note-overlay');
  result.accountFailureRetriedFromStory=true;
  await choose('classic');
  await note.waitFor({state:'visible'});

  rejectNextSave=true;
  await page.getByRole('combobox',{name:'切换媒体呈现',exact:true}).selectOption('stream');
  await page.getByRole('status').filter({hasText:'无法确认'}).waitFor({state:'visible'});
  assert.equal(await activeReader(),'classic');result.rejectedSavePreservesReader=true;
  const pickerRetryStart=saves.length;
  await page.locator('.mobile-v2__account-trigger').click();
  await account.locator('[data-media-presentation-entry="sheet"]').click();
  await account.waitFor({state:'detached'});
  assert.deepEqual(saves.slice(pickerRetryStart),['stream'],
    'Account retry advanced the cycle instead of retrying the failed Story choice');
  await waitStyle('stream');
  result.storyFailureRetriedFromAccount=true;
  await choose('classic');
  await note.waitFor({state:'visible'});
  rejectNextSave=true;
  await page.getByRole('combobox',{name:'切换媒体呈现',exact:true}).selectOption('stream');
  await page.locator('.story-presentation-picker__error').waitFor({state:'visible'});
  await choose('book');
  assert.equal(await page.locator('.story-presentation-picker__error').count(),0);
  result.newChoiceClearsOldRetry=true;
  await choose('classic');
  await note.waitFor({state:'visible'});

  await story.getByRole('button',{name:'选择停靠点',exact:true}).click();
  await story.locator(`[data-route-point-id="${id(4)}"]`).click();
  await page.addStyleTag({content:'.journey-story[data-classic-view] { --story-safe-bottom: 34px; }'});
  await page.emulateMedia({reducedMotion:"no-preference"});
  await page.evaluate(()=>{window.__storyFrames=[];window.__storyTrace=true;window.__storyTracePhase="expand";let prior=performance.now();const frame=now=>{const story=document.querySelector('.journey-story');window.__storyFrames.push({phase:window.__storyTracePhase,dt:now-prior,scroll:story?.scrollTop,height:story?.getBoundingClientRect().height});prior=now;if(window.__storyTrace)requestAnimationFrame(frame);};requestAnimationFrame(frame);});
  await story.getByRole('button',{name:'展开旅程故事',exact:true}).click();
  await page.waitForFunction(()=>{const s=document.querySelector('.journey-story');return s?.dataset.mobilePresentation==='expanded'&&!s.getAnimations().some(a=>a.playState==='running');});
  const expandedBox=await story.boundingBox();
  assert.ok(Math.abs(expandedBox.height-844)<=1,`safe-area padding grew the sheet to ${expandedBox.height}`);
  result.simulatedSafeBottom={px:34,expandedHeight:expandedBox.height};
  const scrollBefore=await story.evaluate(el=>({top:el.scrollTop,copy:el.querySelector('.journey-story__copy').scrollTop,document:document.scrollingElement.scrollTop}));
  await page.evaluate(()=>{window.__storyTracePhase="scroll";});
  await swipeUp(story,230);
  await page.waitForFunction(before=>document.querySelector('.journey-story')?.scrollTop>before+50,scrollBefore.top);
  const scrollAfter=await story.evaluate(el=>({top:el.scrollTop,copy:el.querySelector('.journey-story__copy').scrollTop,document:document.scrollingElement.scrollTop,copyOverflow:getComputedStyle(el.querySelector('.journey-story__copy')).overflowY}));
  assert.equal(scrollAfter.copy,scrollBefore.copy);assert.equal(scrollAfter.document,scrollBefore.document);assert.equal(scrollAfter.copyOverflow,'visible');
  const frames=await page.evaluate(()=>{window.__storyTrace=false;return window.__storyFrames;});
  const deltas=frames.filter(f=>f.phase==="scroll").map(f=>f.dt).sort((a,b)=>a-b);
  result.nativeScroll={before:scrollBefore,after:scrollAfter,frames:frames.length,p95Ms:deltas[Math.floor(deltas.length*.95)],maxMs:Math.max(...deltas)};
  await fs.writeFile(`${out}/scroll-frames.json`,JSON.stringify(frames));
  await page.screenshot({path:`${out}/04-expanded-scroll.png`});
  await story.getByRole('button',{name:'收起旅程故事',exact:true}).click();
  await story.getByRole('button',{name:'更多查看选项',exact:true}).click();
  await story.getByRole('button',{name:'管理旅程',exact:true}).click();
  await page.getByRole('textbox',{name:'旅程感想',exact:true}).fill('这段尚未保存，切换呈现不能丢失。');
  assert.equal(await page.getByRole('combobox',{name:'切换媒体呈现',exact:true}).isDisabled(),true);
  const writesBefore=saves.length;
  await page.locator('.mobile-v2__account-trigger').click();
  await page.locator('.account-sheet [data-media-presentation-entry="sheet"]').click();
  await page.locator('.account-sheet').getByRole('status').filter({hasText:'请先保存'}).waitFor({state:'visible'});
  assert.equal(saves.length,writesBefore);
  assert.equal(await page.getByRole('textbox',{name:'旅程感想',exact:true}).inputValue(),'这段尚未保存，切换呈现不能丢失。');
  result.unsavedEditProtected=true;
  await account.locator('.account-sheet__handle').click();
  await account.waitFor({state:'detached'});
  await page.getByRole('button',{name:'放弃更改',exact:true}).click();
  const guardedRetryStart=saves.length;
  await page.locator('.story-presentation-picker__error').getByRole('button',{name:'重试',exact:true}).click();
  await waitStyle('note-overlay');
  assert.deepEqual(saves.slice(guardedRetryStart),['note-overlay']);
  result.blockedAccountIntentRetriedAfterDiscard=true;
  // A fresh provider read failure is not a failed selection. Its retry must
  // never send a stale PUT from the preceding errors or reader instances.
  rejectNextRead=true;
  const writesBeforeReload=saves.length;
  await page.reload({waitUntil:'networkidle'});
  await page.locator('.mobile-v2__journey-chip').click();
  await page.locator('.mobile-v2__sheet').getByRole('button',{name:/打开故事/}).click();
  await page.locator('.story-presentation-picker__error').filter({hasText:'无法读取'}).waitFor({state:'visible'});
  const readsBeforeRetry=preferenceReads;
  await page.locator('.story-presentation-picker__error').getByRole('button',{name:'重试',exact:true}).click();
  await waitStyle(style);
  assert.equal(saves.length,writesBeforeReload,'read recovery wrote a preference');
  assert.ok(preferenceReads>readsBeforeRetry);
  result.readFailureRetriesOnlyGet=true;




  assert.deepEqual(errors,[]);
  await fs.writeFile(`${out}/result.json`,JSON.stringify({...result,saves,errors,ok:true},null,2));console.log(JSON.stringify({...result,ok:true}));
 }
} catch(error) {
 await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});
 await fs.writeFile(`${out}/failure.json`,JSON.stringify({message:error.message,result,saves,errors,body:(await page.locator('body').innerText()).slice(-5000)},null,2));throw error;
} finally {const video=page.video();await page.close();if(video)await video.saveAs(`${out}/story-presentation-flow.webm`);await browser.close();if(server)await server.close();}
