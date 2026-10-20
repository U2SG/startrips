// Real signed-in Atlas -> reader preference -> owner MP4, across #695/#701.
// Only authenticated HTTP fixtures/media bytes are synthetic; readers and encoder are real.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import sharp from "sharp";
import { launchQaBrowser } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const out = "artifacts/journey-film-export/story-integration";
await fs.mkdir(out, { recursive: true });
const ffprobe = process.env.FFPROBE_PATH ?? (process.platform === "win32" ? "D:/tools/ffmpeg/bin/ffprobe.exe" : "ffprobe");
const bytes = await sharp({ create: { width: 320, height: 480, channels: 3, background: "#426f98" } }).jpeg().toBuffer();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const createdAt = "2026-10-01T00:00:00.000Z";
const journey = { id:id(1), atlasId:id(2), title:"Story MP4 沿途", startedOn:"2026-10-01", endedOn:"2026-10-02", note:"", lightColor:"#77c8c2", lightEffect:null, coverMediaAssetId:null, revision:1, createdByUserId:id(3), createdAt, updatedAt:createdAt,
  routePoints:[{id:id(4),label:"海边",isStop:true,note:null},{id:id(5),label:"路上的一句话",isStop:false,note:"没有拍照，也要留下这段感想。"}].map((point,i)=>({...point,journeyId:id(1),sortOrder:i,latitude:22.5+i*.1,longitude:114+i*.1,occurredAt:null,createdAt})),
  media:[{id:id(100),journeyId:id(1),routePointId:id(4),mimeType:"image/jpeg",fileName:"coast.jpg",bytes:bytes.length,sortOrder:0,contentHash:createHash("sha256").update(bytes).digest("hex"),contentHashVerified:true,createdAt}] };
const session = {session:{id:"integration-session",userId:id(3),token:"fixture-token",expiresAt:"2099-01-01T00:00:00.000Z",createdAt,updatedAt:createdAt,activeOrganizationId:"qa-org"},user:{id:id(3),name:"QA",email:"qa@example.com",emailVerified:true,createdAt,updatedAt:createdAt}};
const browser = await launchQaBrowser({args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,reducedMotion:"reduce",acceptDownloads:true});
let style="book", holdPreference=false, releasePreference=()=>{}, holdSource=false, heldSourceCount=0;
const sourceReleases=new Set(), errors=[], requests=[], downloads=[], checks=[];
let acknowledgeSourceHeld, acknowledgeSourceSettled;
const sourceHeld=new Promise(resolve=>{acknowledgeSourceHeld=resolve;});
const sourceSettled=new Promise(resolve=>{acknowledgeSourceSettled=resolve;});
const page=await context.newPage();
// This lane verifies the real anchor-download fallback; keep native picker
// availability from changing its download-event observation.
await page.addInitScript(() => {
  Object.defineProperty(globalThis, "showSaveFilePicker", { configurable: true, value: undefined });
});
page.setDefaultTimeout(20_000);
page.on("pageerror",e=>errors.push(e.message));
page.on("download",d=>downloads.push(d.suggestedFilename()));
const json=(body,status=200)=>({status,contentType:"application/json",body:JSON.stringify(body)});
await context.route("**/api/auth/**",route=>{const path=new URL(route.request().url()).pathname;return route.fulfill(json(path.endsWith("/get-session")?session:path.endsWith("/organization/list")?[{id:"qa-org",name:"QA",slug:"qa"}]:{}));});
await context.route("**/api/account-preferences/media-presentation",async route=>{
  if(route.request().method()==="PUT") { const next=route.request().postDataJSON().style; requests.push(next);if(holdPreference){holdPreference=false;await new Promise(resolve=>{releasePreference=resolve;});}style=next; }
  await route.fulfill(json({style}));
});
await context.route("**/api/account-preferences/earth-experience",route=>route.fulfill(json({earthExperience:"default",revision:0,updatedAt:null})));
await context.route("**/api/atlases/current",route=>route.fulfill(json({atlas:{id:id(2),title:"Integration Atlas",dedication:"同行"},role:"owner"})));
await context.route("**/api/journeys",route=>route.fulfill(json({journeys:[journey]})));
await context.route(`**/api/journeys/${journey.id}`,route=>route.fulfill(json({journey})));
await context.route("**/api/home-bases",route=>route.fulfill(json({periods:[]})));
await context.route("**/api/home-bases/dismissal",route=>route.fulfill(json({dismissals:[]})));
await context.route("**/api/media-evidence/*",route=>route.fulfill(json({evidence:{mediaAssetId:id(100),revision:0,recorded:{spatial:{source:"unknown",granularity:"unknown",latitude:null,longitude:null,accuracyMeters:null,label:null},captureTime:{source:"unknown",timezone:"unknown",local:null,instant:null,offsetMinutes:null}},display:{hidden:false,correction:null},effective:null,updatedAt:null}})));
await context.route("**/api/uploads/assets/*/read-url",route=>route.fulfill(json({url:`${origin}/__integration_photo.jpg`,expiresAt:"2099-01-01T00:00:00.000Z"})));
await context.route("**/__integration_photo.jpg",route=>route.fulfill({body:bytes,contentType:"image/jpeg"}).catch(()=>{}));
await context.route(`**/api/cover-reveal/journeys/${journey.id}`,route=>route.fulfill(json({
  derivative:{id:id(101),journeyId:journey.id,sourceMediaAssetId:journey.media[0].id,sourceContentHash:journey.media[0].contentHash,
    generationKind:"paper-collage-memory",generationVersion:1,presetId:"guided-ribbon",mimeType:"image/jpeg",width:320,height:480},
  display:{url:`${origin}/__integration_opening.jpg`,expiresAt:"2099-01-01T00:00:00.000Z"},
})));
await context.route("**/__integration_opening.jpg",async route=>{
  const held=holdSource&&route.request().resourceType()==="fetch";
  if(held) {
    heldSourceCount++;let release;const promise=new Promise(resolve=>{release=resolve;});
    sourceReleases.add(release);acknowledgeSourceHeld(route.request());
    await promise;sourceReleases.delete(release);
  }
  try {await route.fulfill({body:bytes,contentType:"image/jpeg"}).catch(()=>{});}
  finally {if(held)acknowledgeSourceSettled();}
});
const account=page.locator(".account-sheet");
const exitPresentation=()=>page.getByRole("button",{name:"退出媒体呈现",exact:true});
const enterPresentation=()=>page.getByRole("button",{name:"进入媒体呈现",exact:true});
const story=page.locator(".journey-story");
const exportButton=()=>page.getByRole("button",{name:"导出短片",exact:true});
const dialog=page.getByRole("dialog",{name:"导出旅程短片",exact:true});
async function ready(next) {
  await page.waitForFunction(value=>{
    const selector=value==="book"?".journey-book":value==="book-3d"?".journey-book-3d":value==="stream"?".journey-stream":".journey-story";
    const reader=document.querySelector(selector);
    const exit=document.querySelector('button[aria-label="退出媒体呈现"]');
    return reader && exit && !exit.disabled && reader.getAttribute('data-story-editing')!=="true"
      && (!["classic","note-overlay"].includes(value) || reader.getAttribute('data-story-presentation')===value);
  },next);
}
async function openAccount() {
  // Full-screen readers own a modal. Leave through their exit icon before
  // opening Account from the editable Story, without writing a preference.
  await manage();
  await page.locator('.mobile-v2__account-trigger').click();
  await account.waitFor({state:"visible"});
}
async function choose(next) {
  // Saved presentation changes still belong to Account. Story's icon only
  // leaves/enters the current presentation within this editing session.
  for(let i=0;style!==next&&i<5;i++) {
    const previous=style;
    await openAccount();
    const entry=account.locator('[data-media-presentation-entry="sheet"]');
    assert.equal(await entry.getAttribute('data-media-presentation-value'),previous);
    await entry.click();
    await account.waitFor({state:"detached"});
    assert.notEqual(style,previous);
    await ready(style);
  }
  assert.equal(style,next);
  await ready(next);
}
async function manage() {
  const saved=style, writes=requests.length;
  if(await story.count()===0 || await story.getAttribute("data-mobile-mode")!=="manage") {
    await exitPresentation().click();
  }
  await page.waitForFunction(()=>{
    const reader=document.querySelector('.journey-story');
    return reader?.getAttribute('data-story-editing')==="true" && reader.getAttribute('data-mobile-mode')==="manage";
  });
  await enterPresentation().waitFor({state:"visible"});
  await exportButton().waitFor({state:"visible"});
  assert.equal(await exportButton().evaluate(el=>Boolean(el.closest('.journey-story__editor-actions'))),true);
  assert.equal(style,saved,"editor entry replaced the saved account presentation");
  assert.equal(requests.length,writes,"editor entry wrote an account preference");
}
async function returnToPresentation() {
  const saved=style, writes=requests.length;
  await enterPresentation().click();
  await ready(saved);
  assert.equal(requests.length,writes,"presentation re-entry wrote an account preference");
}
async function assertExportReturnFocus(exit){
  const state=await exportButton().evaluate(el=>({same:el===document.activeElement,activeTag:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label'),mode:el.closest('.journey-story')?.getAttribute('data-mobile-mode'),inert:Boolean(el.closest('[inert]'))}));
  console.log('STORY_FILM_RETURN_FOCUS',exit,JSON.stringify(state));
  assert.equal(state.same,true,`${exit} lost the collapsed Story export opener: ${JSON.stringify(state)}`);
  assert.equal(state.inert,false);
}
let phase="open";
const mark=name=>{phase=name;console.log("STORY_FILM_STAGE",name);};
const watchdog=setTimeout(()=>{console.error("STORY_FILM_TIMEOUT",phase);process.exit(1);},150_000);
try {
  await page.goto(`${origin}/?qaState=atlas-gateway&qaLite=1`,{waitUntil:"networkidle"});
  await page.locator('.mobile-v2__journey-chip').click();
  await page.locator('.mobile-v2__sheet').getByRole('button',{name:/打开故事/}).click();
  await ready("book");await manage();await returnToPresentation();
  await choose("stream");await manage();await returnToPresentation();
  await choose("classic");await manage();
  mark("pending preference preserves export control without allowing activation");
  holdPreference=true;
  const pending=page.waitForRequest(r=>r.url().endsWith('/api/account-preferences/media-presentation')&&r.method()==='PUT');
  await openAccount();
  await account.locator('[data-media-presentation-entry="sheet"]').click();await pending;
  assert.equal(requests.at(-1),"note-overlay","Account must advance the saved classic preference");
  // Inert controls intentionally leave the accessibility tree. Include them
  // only for this DOM-preservation observation, never for a user interaction.
  const pendingExport=page.getByRole("button",{name:"导出短片",exact:true,includeHidden:true});
  assert.equal(await pendingExport.count(),1,"export was lost during conflict resolution");
  assert.equal(await pendingExport.evaluate(el=>Boolean(el.closest('[inert]'))),true,"pending preference leaves export clickable");
  assert.equal(await exportButton().count(),0,"pending export remains exposed to accessibility actions");
  assert.equal(await dialog.count(),0);
  releasePreference();await account.waitFor({state:"detached"});await ready("note-overlay");await manage();
  checks.push("#695 export entry and #701 pending-preference inert both preserved");
  mark("real MP4 after presentation round trips");
  await exportButton().click();await dialog.waitFor({state:"visible"});
  assert.equal(await dialog.evaluate(el=>el.matches(':modal')),true);
  const savesBefore=requests.length;
  await page.keyboard.press("Tab");
  assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true,"export modal lost keyboard ownership");
  assert.equal(requests.length,savesBefore);
  await dialog.getByLabel("基础时长（非上限）", { exact: true }).selectOption("15");
  await dialog.getByLabel("包含途径点感想字幕").check();
  await dialog.getByLabel("使用已生成的艺术封面（没有则使用原图）").uncheck();
  await dialog.getByRole("button",{name:"生成 MP4",exact:true}).click();
  await dialog.getByRole("button",{name:"下载 MP4",exact:true}).waitFor({state:"visible",timeout:120_000});
  const event=page.waitForEvent("download");await dialog.getByRole("button",{name:"下载 MP4",exact:true}).click();
  const download=await event;assert.equal(download.suggestedFilename(),"Startrips-Story MP4 沿途.mp4");
  const file=`${out}/presentation-roundtrip.mp4`;await download.saveAs(file);
  const probe=spawnSync(ffprobe,["-v","error","-count_frames","-show_streams","-show_format","-of","json",file],{encoding:"utf8",timeout:30_000,windowsHide:true});
  assert.equal(probe.status,0,probe.stderr);const parsed=JSON.parse(probe.stdout);const video=parsed.streams.find(s=>s.codec_type==="video");
  assert.equal(video.codec_name,"h264");assert.equal(video.width,1080);assert.equal(video.height,1920);assert.equal(video.avg_frame_rate,"30/1");assert.ok(Number(video.nb_read_frames)>=450);assert.equal(parsed.streams.filter(s=>s.codec_type==="audio").length,0);
  checks.push("real signed-in shell -> book/stream/classic/note-overlay -> H.264 1080p/30 silent MP4 with note-only via captions enabled");
  await page.screenshot({path:`${out}/mp4-ready.png`});
  mark("Escape returns to collapsed Story export");
  await page.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
  await assertExportReturnFocus("Escape");
  await choose("book-3d");await choose("classic");await manage();
  await exportButton().click();await dialog.waitFor({state:"visible"});
  assert.equal(await dialog.getByRole("button",{name:"下载 MP4",exact:true}).count(),0,"old artifact revived after reader replacement");
  checks.push("export close returns focus; 3D reader round trip does not revive an old artifact");
  mark("cancel before switching away, reject late source completion");
  // The real encoder reads its opening before encoding any map frames. Holding
  // this private byte fetch makes cancellation independent of encoder throughput.
  // Original-media reads are lazy and may follow hundreds of encoded frames.
  await page.emulateMedia({reducedMotion:"no-preference"});
  await dialog.getByLabel("使用已生成的艺术封面（没有则使用原图）").check();holdSource=true;
  let sourceDeadline, heldRequest;
  try {
    [heldRequest]=await Promise.all([
      Promise.race([sourceHeld,new Promise((_,reject)=>{sourceDeadline=setTimeout(()=>reject(new Error("opening source was never held")),20_000);})]),
      dialog.getByRole("button",{name:"生成 MP4",exact:true}).click(),
    ]);
  } finally {clearTimeout(sourceDeadline);}
  assert.equal(heldSourceCount,1,"the export must reach exactly one held source read");
  assert.equal(sourceReleases.size,1,"Back must run while the source response is still held");
  // Closing a view alone can hide an abandoned encoder. Require the exact held
  // browser request to abort, not merely a fresh dialog with no old artifact.
  const [failedSource]=await Promise.all([
    page.waitForEvent("requestfailed",request=>request===heldRequest),
    (async()=>{
      await page.goBack();await dialog.waitFor({state:"hidden"});
      await assertExportReturnFocus("Back");
      await page.emulateMedia({reducedMotion:"reduce"});
      await choose("stream");holdSource=false;for(const release of sourceReleases)release();sourceReleases.clear();
      await sourceSettled;
    })(),
  ]);
  assert.equal(failedSource.failure()?.errorText,"net::ERR_ABORTED","Back must abort the held private source request");
  await choose("classic");await manage();await exportButton().click();await dialog.waitFor({state:"visible"});
  assert.equal(await dialog.getByRole("button",{name:"下载 MP4",exact:true}).count(),0);assert.equal(downloads.length,1);
  checks.push("Back aborts export at a held private opening read; late source after reader changes cannot publish/download stale MP4");
  assert.deepEqual(errors,[]);
  await fs.writeFile(`${out}/evidence.json`,JSON.stringify({ok:true,checks,requests,downloads,heldSourceCount,sourceFailure:failedSource.failure(),video:{codec:video.codec_name,width:video.width,height:video.height,frames:video.nb_read_frames},errors},null,2));
  console.log(JSON.stringify({ok:true,checks}));
} catch(error) {
  await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});
  await fs.writeFile(`${out}/failure.json`,JSON.stringify({phase,message:error.message,requests,checks,errors,body:(await page.locator('body').innerText()).slice(-4500)},null,2));throw error;
} finally {releasePreference();for(const release of sourceReleases)release();await context.close();await browser.close();clearTimeout(watchdog);}
