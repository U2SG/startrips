import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "vite";
import { launchQaBrowser } from "./qa-browser.mjs";
const width = Number(process.argv.find(arg=>/^\d+$/.test(arg)) ?? 390);
const out = `artifacts/story-repair/editor-navigation-${width}`;
await fs.mkdir(out, {recursive:true});
const server = process.env.QA_ORIGIN ? null : await createServer({server:{host:"127.0.0.1",port:4297,strictPort:true},logLevel:"error"});
if (server) await server.listen();
const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4297";
const browser = await launchQaBrowser({args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const context = await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,reducedMotion:"reduce",recordVideo:{dir:`${out}/raw`,size:{width,height:844}}});
const page = await context.newPage();
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
const saves = [], errors = [], result = {width, presentationExits: [], layouts: []};
let holdJourneyRead = false;
const heldJourneyReads = new Set();
const json = (body,status=200) => ({status,contentType:"application/json",body:JSON.stringify(body)});
page.on("pageerror",e=>errors.push(e.message));
await page.route("**/api/auth/**",route=>{const path=new URL(route.request().url()).pathname;return route.fulfill(json(path.endsWith("/get-session") ? session : path.endsWith("/organization/list") ? [{id:"qa-org",name:"QA Atlas",slug:"qa-atlas"}] : {}));});
await page.route("**/api/account-preferences/media-presentation",async route=>{if(route.request().method()==="GET"){preferenceReads++;if(rejectNextRead){rejectNextRead=false;return route.fulfill(json({error:"read-unavailable"},500));}}if(route.request().method()==="PUT"){const next=route.request().postDataJSON().style;saves.push(next);if(holdNextSave){holdNextSave=false;await new Promise(resolve=>{releaseSave=resolve;});}if(rejectNextSave){rejectNextSave=false;return route.fulfill(json({error:"rejected"},500));}style=next;}return route.fulfill(json({style}));});
await page.route("**/api/account-preferences/earth-experience",route=>route.fulfill(json({earthExperience:"default",revision:0,updatedAt:null})));
await page.route("**/api/atlases/current",route=>route.fulfill(json({atlas:{id:id(2),title:"QA Atlas",dedication:"同行"},role:"owner"})));
await page.route("**/api/journeys",route=>route.fulfill(json({journeys:[journey]})));
await page.route(`**/api/journeys/${journey.id}`, async route => {
 if (holdJourneyRead) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  heldJourneyReads.add(release);
  await pending;
  heldJourneyReads.delete(release);
 }
 await route.fulfill(json({journey})).catch(() => {});
});
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
const story = page.locator('.journey-story');
const account = page.locator('.account-sheet');
const exit = () => page.getByRole('button', {name:'退出媒体呈现',exact:true});
const enter = () => page.getByRole('button', {name:'进入媒体呈现',exact:true});
const exportButton = () => story.getByRole('button', {name:'导出短片',exact:true});
async function openAccount() {
 // Immersive readers own the screen. Use the user's icon exit before opening
 // Account from the editable in-context Story, never click behind a modal.
 if (await enter().count() === 0) await leavePresentation();
 await page.locator('.mobile-v2__account-trigger').click();
 await account.waitFor({state:'visible'});
}
async function closeAccount() {
 await account.locator('.account-sheet__handle').click();
 await account.waitFor({state:'detached'});
}
async function waitStyle(next) {
 await page.waitForFunction(expected => {
  const selector = expected === 'book' ? '.journey-book' : expected === 'book-3d' ? '.journey-book-3d' : expected === 'stream' ? '.journey-stream' : '.journey-story';
  const reader = document.querySelector(selector);
  return reader && !reader.hasAttribute('data-story-editing')
   && document.querySelector('button[aria-label="退出媒体呈现"]')
   && (!['classic','note-overlay'].includes(expected) || reader.dataset.storyPresentation === expected);
 }, next);
}
async function cycleAccountStyle() {
 const previous = style;
 await openAccount();
 const entry = account.locator('[data-media-presentation-entry="sheet"]');
 assert.equal(await entry.getAttribute('data-media-presentation-value'),previous);
 await entry.click();
 await account.waitFor({state:'detached'});
 assert.notEqual(style,previous);
 await waitStyle(style);
}
async function choose(next) {
 for (let i=0; style!==next && i<5; i++) await cycleAccountStyle();
 assert.equal(style,next);
 await waitStyle(next);
}
async function assertIcon(button, label) {
 await button.waitFor({state:'visible'});
 assert.equal((await button.textContent()).trim(),'','presentation navigation must remain icon-only');
 assert.equal(await button.getAttribute('data-tooltip'),label);
 assert.equal(await button.locator('svg').count(),1);
 const box=await button.boundingBox();
 assert.ok(box && box.width>=43.5 && box.height>=43.5,`${label} must have a 44px touch target`);
 assert.ok(box.x>=-1 && box.x+box.width<=page.viewportSize().width+1,`${label} is horizontally clipped: ${JSON.stringify({box,viewport:page.viewportSize(),handoff:await page.evaluate(()=>window.__qaEditorNavigationGeometry)})}`);
}
async function assertEditor() {
 await page.waitForFunction(() => {
  const reader=document.querySelector('.journey-story');
  return reader?.dataset.storyEditing==='true'
   && (reader.dataset.storyLayout==='desktop' || reader.dataset.mobileMode==='manage');
 });
 assert.equal(await story.getAttribute('data-story-presentation'),'classic');
 assert.equal(await story.getByRole('textbox',{name:'旅程感想',exact:true}).isVisible(),true);
 assert.equal(await story.getByRole('combobox',{name:'切换媒体呈现',exact:true}).count(),0);
 await assertIcon(enter(),'进入媒体呈现');
 const button=exportButton();
 await button.waitFor({state:'visible'});
 assert.equal(await button.evaluate(el=>Boolean(el.closest('.journey-story__editor-actions'))),true);
 assert.equal(await button.evaluate(el=>Boolean(el.closest('footer'))),false);
 const box=await button.boundingBox();
 assert.ok(box && box.y>=0 && box.y+box.height<=page.viewportSize().height,'export must be discoverable without scrolling to the footer');
 assert.ok(box.x>=0 && box.x+box.width<=page.viewportSize().width+1,'export control is clipped');
}
async function leavePresentation() {
 const writes=saves.length, saved=style;
 await assertIcon(exit(),'退出媒体呈现');
 await exit().click();
 // Mobile Manage intentionally commits focus across two animation frames. The
 // classic reader can reuse the clicked button, so focus equality alone is not
 // completion. Observe stable geometry, without accepting/retrying bad bounds.
 await page.evaluate(()=>{window.__qaEditorNavigationGeometry=null;});
 await page.waitForFunction(()=>{
  const reader=document.querySelector('.journey-story');
  if(reader?.dataset.storyEditing!=='true') return false;
  if(reader.dataset.storyLayout!=='mobile') return true;
  const button=reader.querySelector('button[aria-label="进入媒体呈现"]');
  if(!button) return false;
  const header=button.closest('header');
  const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const sample={button:rect(button),header:rect(header),story:rect(reader),
   scrollLeft:reader.scrollLeft,scrollTop:reader.scrollTop,clientWidth:reader.clientWidth,scrollWidth:reader.scrollWidth,
   headerScrollLeft:header.scrollLeft,headerWidth:header.clientWidth,headerScrollWidth:header.scrollWidth,
   view:reader.dataset.classicView,mode:reader.dataset.mobileMode,focused:document.activeElement===button};
  const signature=JSON.stringify(sample),prior=window.__qaEditorNavigationGeometry;
  const stable=prior?.signature===signature ? prior.stable+1 : 0;
  window.__qaEditorNavigationGeometry={signature,stable,sample};
  return stable>=2 && sample.focused;
 },null,{polling:'raf'});
 await assertEditor();
 assert.equal(style,saved,'local editor entry changed the account preference');
 assert.equal(saves.length,writes,'local editor entry issued a preference write');
}
async function returnPresentation() {
 const writes=saves.length, saved=style;
 await enter().click();
 await waitStyle(saved);
 assert.equal(style,saved);
 assert.equal(saves.length,writes,'local presentation re-entry issued a preference write');
}
async function waitExportFocus() {
 await page.waitForFunction(() => {
  const trigger=document.querySelector('.journey-story__editor-actions button[data-story-film-export-trigger]')
   ?? [...document.querySelectorAll('.journey-story__editor-actions button')].find(el=>el.textContent.includes('导出短片'));
  return trigger && document.activeElement===trigger && trigger.getClientRects().length>0;
 });
}
let settings;
try {
 await page.goto(`${origin}/?qaState=atlas-gateway&qaLite=1`,{waitUntil:'networkidle'});
 await page.locator('.mobile-v2__journey-chip').click();
 await page.locator('.mobile-v2__sheet').getByRole('button',{name:/打开故事/}).click();
 await waitStyle('book');
 await page.screenshot({path:`${out}/01-book.png`});
 result.initialReader=await activeReader();
 assert.equal(await page.getByRole('combobox',{name:'切换媒体呈现',exact:true}).count(),0);
 // Every presentation exits to an editable session and re-enters the same saved reader.
 for (const saved of ['book','book-3d','stream','classic','note-overlay']) {
  await choose(saved);
  await leavePresentation();
  await page.screenshot({path:`${out}/editor-from-${saved}.png`});
  await returnPresentation();
  result.presentationExits.push(saved);
 }
 await choose('classic');
 // Real local preference controls in another tab exercise storage notifications,
 // including changes while this owner is already in the editor.
 settings=await page.context().newPage();
 await settings.route('**/api/auth/get-session',route=>route.fulfill(json(null)));
 await settings.route('**/api/uploads/assets/*/read-url',route=>route.fulfill(json({url:`${origin}/artworks/monet-water-lilies.jpg`,expiresAt:'2099-01-01T00:00:00.000Z'})));
 await settings.goto(`${origin}/?qaState=journey-story&qaClassicControls=1`,{waitUntil:'networkidle'});
 const localEntry=settings.locator('[data-mobile-classic-view-entry]');
 const dialog=page.getByRole('dialog',{name:'导出旅程短片',exact:true});
 const initialLocalPreference=await page.evaluate(()=>localStorage.getItem('startrips.mobile-classic-view.v1'));
 for (const [index,layout] of ['light','thumb','photo','earth'].entries()) {
  if (index) {
   await settings.getByRole('button',{name:/切换经典视图/}).click();
   assert.equal(await localEntry.getAttribute('data-mobile-classic-view-value'),layout);
  }
  await page.waitForFunction(view=>document.querySelector('.journey-story')?.dataset.classicView===view,layout);
  await leavePresentation();
  assert.equal(await story.getAttribute('data-classic-view'),layout);
  await story.getByRole('button',{name:'管理当前媒体',exact:true}).click();
  const mediaMenu=story.getByRole('dialog',{name:'媒体管理',exact:true});
  await mediaMenu.waitFor({state:'visible'});
  const mediaBox=await story.locator('.journey-story__media').boundingBox();
  const menuBox=await mediaMenu.boundingBox();
  const backdrop=story.getByRole('button',{name:'关闭媒体管理',exact:true});
  const backdropBox=await backdrop.boundingBox();
  assert.ok(menuBox.y>=mediaBox.y && menuBox.y+menuBox.height<=mediaBox.y+mediaBox.height+1,'media menu escapes the selected aperture');
  assert.ok(Math.abs(backdropBox.width-mediaBox.width)<=2 && Math.abs(backdropBox.height-mediaBox.height)<=2,'management dismissal must cover the picture');
  for (const command of ['整理媒体','移动媒体 / 重新归类','删除媒体']) {
   const button=mediaMenu.getByRole('button',{name:command,exact:true});
   await button.scrollIntoViewIfNeeded();
   const box=await button.boundingBox();
   const currentMenuBox=await mediaMenu.boundingBox();
   assert.ok(box.y>=currentMenuBox.y && box.y+box.height<=currentMenuBox.y+currentMenuBox.height+1,`${command} is clipped`);
   assert.equal(await button.isEnabled(),true);
  }
  // Native pointer dismissal in the exposed strip beside the menu.
  await backdrop.click({position:{x:3,y:3}});
  await mediaMenu.waitFor({state:'hidden'});
  assert.equal(await story.getAttribute('data-story-editing'),'true');
  // Closing with each supported route must restore focus to the visible operation row.
  for (const close of ['button','Escape','Back']) {
   await exportButton().click();
   await dialog.waitFor({state:'visible'});
   if (close==='button') await dialog.getByRole('button',{name:'关闭短片导出',exact:true}).click();
   else if (close==='Escape') await page.keyboard.press('Escape');
   else await page.goBack();
   await dialog.waitFor({state:'hidden'});
   await waitExportFocus();
   assert.equal(await story.getAttribute('data-story-editing'),'true');
  }
  await page.screenshot({path:`${out}/layout-${layout}-editor.png`});
  await returnPresentation();
  assert.equal(await story.getAttribute('data-classic-view'),layout);
  assert.equal(await page.evaluate(()=>localStorage.getItem('startrips.mobile-classic-view.v1')),index===0 ? initialLocalPreference : layout);
  result.layouts.push({layout,exportCloseFocus:true});
 }
 // Cycle back to A while the editor is open: no stage/account reset or hidden actions.
 await leavePresentation();
 const writesBeforeLayout=saves.length;
 await settings.getByRole('button',{name:/切换经典视图/}).click();
 await page.waitForFunction(()=>document.querySelector('.journey-story')?.dataset.classicView==='light');
 await assertEditor();
 assert.equal(saves.length,writesBeforeLayout);
 result.liveEditorLayoutChange=true;
 // Hold authorization before export work starts; cancellation must not publish an artifact.
 holdJourneyRead=true;
 await exportButton().click();
 await dialog.waitFor({state:'visible'});
 const exportRead=page.waitForRequest(request=>new URL(request.url()).pathname===`/api/journeys/${journey.id}`);
 await dialog.getByRole('button',{name:'生成 MP4',exact:true}).click();
 await exportRead;
 await dialog.getByRole('button',{name:'取消导出',exact:true}).click();
 holdJourneyRead=false;
 for (const release of heldJourneyReads) release();
 await dialog.getByText('已取消导出。',{exact:true}).waitFor({state:'visible'});
 assert.equal(await dialog.getByRole('button',{name:'下载 MP4',exact:true}).count(),0);
 await dialog.getByRole('button',{name:'关闭短片导出',exact:true}).click();
 await dialog.waitFor({state:'hidden'});
 await waitExportFocus();
 result.exportCancelPreservesEditor=true;
 await returnPresentation();

 // Keep the note-only handoff and native single-scroller regressions from the
 // original presentation flow. These run in the ordinary reader, then editor entry.
 await story.getByRole('button',{name:'选择停靠点',exact:true}).click();
 await story.locator(`[data-route-point-id="${id(5)}"]`).click();
 const note=page.locator('.journey-story [data-current-media-kind="note"] .story-media-pages__note-text');
 await note.waitFor({state:'visible'});
 const selectedNoteText=await note.textContent();
 assert.ok(selectedNoteText.includes('这里没有拍照'));
 result.note=await note.evaluate(el=>{const card=el.closest('.story-media-pages__note');return {background:getComputedStyle(card).backgroundColor,text:el.textContent.length,scroll:el.scrollHeight>el.clientHeight};});
 assert.notEqual(result.note.background,'rgba(0, 0, 0, 0)');
 const noteBefore=await note.evaluate(el=>el.scrollTop);
 await swipeUp(note,130);
 await page.waitForFunction(before=>document.querySelector('.journey-story [data-current-media-kind="note"] .story-media-pages__note-text')?.scrollTop>before+40,noteBefore);
 const paintedNeighbours=await page.locator('.journey-story [data-current-media-kind="note"] > .story-media-pages__page:not([data-media-presented="true"])').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).visibility==='visible').length);
 assert.equal(paintedNeighbours,0);
 await leavePresentation();
 await returnPresentation();
 await note.waitFor({state:'visible'});
 assert.equal(await note.textContent(),selectedNoteText,'editor return selected a different note');
 result.notePositionPreserved=true;
 result.noteNativeScroll=true;
 await page.screenshot({path:`${out}/03-note-only.png`});
 await story.getByRole('button',{name:'选择停靠点',exact:true}).click();
 await story.locator(`[data-route-point-id="${id(4)}"]`).click();
 await page.addStyleTag({content:'.journey-story[data-classic-view] { --story-safe-bottom: 34px; }'});
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{window.__storyFrames=[];window.__storyTrace=true;window.__storyTracePhase='expand';let prior=performance.now();const frame=now=>{const story=document.querySelector('.journey-story');window.__storyFrames.push({phase:window.__storyTracePhase,dt:now-prior,scroll:story?.scrollTop,height:story?.getBoundingClientRect().height});prior=now;if(window.__storyTrace)requestAnimationFrame(frame);};requestAnimationFrame(frame);});
 await story.getByRole('button',{name:'展开旅程故事',exact:true}).click();
 await page.waitForFunction(()=>{const s=document.querySelector('.journey-story');return s?.dataset.mobilePresentation==='expanded'&&!s.getAnimations().some(a=>a.playState==='running');});
 const expandedBox=await story.boundingBox();
 assert.ok(Math.abs(expandedBox.height-844)<=1,`safe-area padding grew the sheet to ${expandedBox.height}`);
 result.simulatedSafeBottom={px:34,expandedHeight:expandedBox.height};
 const scrollBefore=await story.evaluate(el=>({top:el.scrollTop,copy:el.querySelector('.journey-story__copy').scrollTop,document:document.scrollingElement.scrollTop}));
 await page.evaluate(()=>{window.__storyTracePhase='scroll';});
 await swipeUp(story,230);
 await page.waitForFunction(before=>document.querySelector('.journey-story')?.scrollTop>before+50,scrollBefore.top);
 const scrollAfter=await story.evaluate(el=>({top:el.scrollTop,copy:el.querySelector('.journey-story__copy').scrollTop,document:document.scrollingElement.scrollTop,copyOverflow:getComputedStyle(el.querySelector('.journey-story__copy')).overflowY}));
 assert.equal(scrollAfter.copy,scrollBefore.copy);assert.equal(scrollAfter.document,scrollBefore.document);assert.equal(scrollAfter.copyOverflow,'visible');
 const frames=await page.evaluate(()=>{window.__storyTrace=false;return window.__storyFrames;});
 const deltas=frames.filter(f=>f.phase==='scroll').map(f=>f.dt).sort((a,b)=>a-b);
 result.nativeScroll={before:scrollBefore,after:scrollAfter,frames:frames.length,p95Ms:deltas[Math.floor(deltas.length*.95)],maxMs:Math.max(...deltas)};
 await fs.writeFile(`${out}/scroll-frames.json`,JSON.stringify(frames));
 await page.screenshot({path:`${out}/04-expanded-scroll.png`});
 await story.getByRole('button',{name:'收起旅程故事',exact:true}).click();
 await page.emulateMedia({reducedMotion:'reduce'});
 await leavePresentation();

 // A rejected account choice remains retryable from the reader's status.
 // Local exit/re-entry must neither clear the failed intent nor overwrite it.
 const accountRetryStart=saves.length;
 rejectNextSave=true;
 await openAccount();
 await account.locator('[data-media-presentation-entry="sheet"]').click();
 await account.getByRole('status').filter({hasText:'无法确认'}).waitFor({state:'visible'});
 assert.deepEqual(saves.slice(accountRetryStart),['note-overlay']);
 assert.equal(style,'classic');
 await closeAccount();
 await assertEditor();
 await returnPresentation();
 await page.locator('.story-presentation-picker__error').waitFor({state:'visible'});
 await leavePresentation();
 await page.locator('.story-presentation-picker__error').getByRole('button',{name:'重试',exact:true}).click();
 await waitStyle('note-overlay');
 assert.deepEqual(saves.slice(accountRetryStart),['note-overlay','note-overlay']);
 result.accountFailureRetriedFromEditor=true;
 // The account entry retries the same failed intent instead of advancing the cycle.
 rejectNextSave=true;
 const accountOwnRetryStart=saves.length;
 await openAccount();
 await account.locator('[data-media-presentation-entry="sheet"]').click();
 await account.getByRole('status').filter({hasText:'无法确认'}).waitFor({state:'visible'});
 await closeAccount();
 await openAccount();
 await account.locator('[data-media-presentation-entry="sheet"]').click();
 await account.waitFor({state:'detached'});
 await waitStyle('book');
 assert.deepEqual(saves.slice(accountOwnRetryStart),['book','book']);
 result.accountRetryPreservesFailedIntent=true;
 await leavePresentation();
 // Keep a pending confirmed account write from admitting new editor mutations.
 holdNextSave=true;
 const heldRequest=page.waitForRequest(request=>request.url().endsWith('/api/account-preferences/media-presentation')&&request.method()==='PUT');
 await openAccount();
 await account.locator('[data-media-presentation-entry="sheet"]').click();
 await heldRequest;
 assert.equal(await story.locator('.journey-story__layout').evaluate(el=>el.inert),true);
 assert.equal(await story.locator('[data-story-film-export-trigger="true"]').evaluate(el=>el.disabled || Boolean(el.closest('[inert]'))),true);
 assert.equal(await exportButton().count(),0,'pending export must leave the accessibility tree');
 releaseSave();
 await account.waitFor({state:'detached'});
 await waitStyle('book-3d');
 result.pendingChangeBlocksNewEdit=true;
 result.confirmedAccountChangeLeavesEditor=true;
 await choose('classic');
 await leavePresentation();
 const draft='这段尚未保存，切换呈现不能丢失。';
 await page.getByRole('textbox',{name:'旅程感想',exact:true}).fill(draft);
 assert.equal(await enter().isDisabled(),true);
 const writesBefore=saves.length;
 await openAccount();
 await account.locator('[data-media-presentation-entry="sheet"]').click();
 await account.getByRole('status').filter({hasText:'请先保存'}).waitFor({state:'visible'});
 assert.equal(saves.length,writesBefore);
 assert.equal(await page.getByRole('textbox',{name:'旅程感想',exact:true}).inputValue(),draft);
 await closeAccount();
 await page.getByRole('button',{name:'放弃更改',exact:true}).click();
 await page.locator('.story-presentation-picker__error').getByRole('button',{name:'重试',exact:true}).click();
 await waitStyle('note-overlay');
 assert.deepEqual(saves.slice(writesBefore),['note-overlay']);
 result.unsavedEditProtected=true;
 result.blockedAccountIntentRetriedAfterDiscard=true;
 // Closing the editor and opening the same journey must recover the saved presentation.
 await leavePresentation();
 await story.getByRole('button',{name:'退出旅程故事',exact:true}).click();
 // The first close may return from manage mode; the second closes Story itself.
 if (await story.count()) await story.getByRole('button',{name:'退出旅程故事',exact:true}).click();
 await story.waitFor({state:'detached'});
 await page.locator('.mobile-v2__journey-chip').click();
 await page.locator('.mobile-v2__sheet').getByRole('button',{name:/打开故事/}).click();
 await waitStyle('note-overlay');
 result.closeAndReopenRestoresSavedPresentation=true;
 // A fresh read error retries GET only, even after earlier failed PUT intents.
 rejectNextRead=true;
 const writesBeforeReload=saves.length;
 await page.reload({waitUntil:'networkidle'});
 await page.locator('.mobile-v2__journey-chip').click();
 await page.locator('.mobile-v2__sheet').getByRole('button',{name:/打开故事/}).click();
 await page.locator('.story-presentation-picker__error').filter({hasText:'无法读取'}).waitFor({state:'visible'});
 const readsBeforeRetry=preferenceReads;
 await leavePresentation();
 await page.getByRole('textbox',{name:'旅程感想',exact:true}).fill(draft);
 await openAccount();
 await account.locator('[data-media-presentation-entry="sheet"]').click();
 await account.getByRole('status').filter({hasText:'请先保存'}).waitFor({state:'visible'});
 assert.equal(preferenceReads,readsBeforeRetry,'Account read-error retry bypassed the draft guard');
 assert.equal(await page.getByRole('textbox',{name:'旅程感想',exact:true}).inputValue(),draft);
 await closeAccount();
 await page.getByRole('button',{name:'放弃更改',exact:true}).click();
 await page.locator('.story-presentation-picker__error').getByRole('button',{name:'重试',exact:true}).click();
 await waitStyle(style);
 assert.equal(saves.length,writesBeforeReload,'read recovery wrote a preference');
 assert.ok(preferenceReads>readsBeforeRetry);
 result.readFailureRetriesOnlyGet=true;
 // Resize the real mounted product across the desktop breakpoint. Account writes
 // still go through the verified mobile entry before each desktop scenario.
 result.desktop=[];
 for (const saved of ['book','classic']) {
  await choose(saved);
  await page.setViewportSize({width:1280,height:900});
  await waitStyle(saved);
  await leavePresentation();
  assert.equal(await story.getAttribute('data-story-layout'),'desktop');
  assert.equal(await story.getAttribute('data-classic-view'),null);
  for (const close of ['button','Escape']) {
   await exportButton().click();
   await dialog.waitFor({state:'visible'});
   if (close==='button') await dialog.getByRole('button',{name:'关闭短片导出',exact:true}).click();
   else await page.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'});
   await waitExportFocus();
  }
  await page.getByRole('textbox',{name:'旅程感想',exact:true}).fill(draft);
  assert.equal(await enter().isDisabled(),true);
  await story.getByRole('button',{name:'退出旅程故事',exact:true}).click();
  assert.equal(await story.getAttribute('data-story-editing'),'true');
  assert.equal(await page.getByRole('textbox',{name:'旅程感想',exact:true}).inputValue(),draft);
  // Clear the Close warning through another real edit so Back must produce a
  // fresh guard response; the prior message cannot satisfy the assertion.
  const rotatedDraft=`${draft}旋转后也保留。`;
  await page.getByRole('textbox',{name:'旅程感想',exact:true}).fill(rotatedDraft);
  await story.locator('.story-notes-editor__message').waitFor({state:'hidden'});
  // Desktop ownership must register the parent Story before compact Manage.
  // Back after rotation cannot consume the parent and bypass the dirty guard.
  await page.setViewportSize({width,height:844});
  await page.waitForFunction(()=>document.querySelector('.journey-story')?.dataset.mobileMode==='manage');
  await page.goBack();
  await story.locator('.story-notes-editor__message').filter({hasText:'还有未保存的感想'}).waitFor({state:'visible'});
  assert.equal(await page.getByRole('textbox',{name:'旅程感想',exact:true}).inputValue(),rotatedDraft);
  assert.equal(await story.getAttribute('data-story-editing'),'true');
  await page.setViewportSize({width:1280,height:900});
  await page.waitForFunction(()=>document.querySelector('.journey-story')?.dataset.storyLayout==='desktop');
  await page.getByRole('button',{name:'放弃更改',exact:true}).click();
  await page.screenshot({path:`${out}/desktop-editor-from-${saved}.png`});
  await returnPresentation();
  await page.setViewportSize({width,height:844});
  if (saved==='classic') {
   await page.waitForFunction(()=>document.querySelector('.journey-story')?.dataset.storyLayout==='mobile');
   assert.equal(await story.getAttribute('data-classic-view'),'light');
  }
  result.desktop.push({saved,editor:true,exportCloseFocus:true,dirtyDraftProtected:true});
 }
 assert.deepEqual(errors,[]);
 await fs.writeFile(`${out}/result.json`,JSON.stringify({...result,saves,errors,ok:true},null,2));
 console.log(JSON.stringify({...result,ok:true}));
} catch(error) {
 await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});
 await fs.writeFile(`${out}/failure.json`,JSON.stringify({message:error.message,result,saves,errors,body:(await page.locator('body').innerText()).slice(-5000)},null,2));
 throw error;
} finally {
 releaseSave();
 for (const release of heldJourneyReads) release();
 await settings?.close();
 const video=page.video();
 await page.close();
 if(video) await video.saveAs(`${out}/story-presentation-flow.webm`);
 await context.close();
 await browser.close();
 if(server) await server.close();
}
