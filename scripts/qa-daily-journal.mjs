import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchQaBrowser } from "./qa-browser.mjs";
const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const output = "artifacts/daily-journal";
await mkdir(output, { recursive: true });
const fixture = { id: "11111111-1111-4111-8111-111111111111", atlasId: "fictional-atlas", title: "虚构旅行手记验收", note: "", startedOn: "2027-04-03", endedOn: null, lightColor: "#74e7d0", revision: 1, createdByUserId: "fictional-owner", createdAt: "2027-04-03T00:00:00Z", updatedAt: "2027-04-03T00:00:00Z", routePoints: [{ id: "22222222-2222-4222-8222-222222222222", journeyId: "11111111-1111-4111-8111-111111111111", sortOrder: 0, latitude: 1, longitude: 2, label: "虚构海湾", isStop: true, occurredAt: null, createdAt: "2027-04-03T00:00:00Z" }], media: [] };
await writeFile(`${output}/harness.tsx`, `import React, {useState,useEffect} from "react";
import {createRoot} from "react-dom/client";
import JourneyStream from "/src/journey/JourneyStream";
import {AtlasViewProvider,createOwnerAtlasView} from "/src/journey/atlasView";
import "/src/styles/tokens.css";
import "/src/styles/controls.css";
import "/src/app.css";
import "/src/styles/living-atlas.css";
const fixture=${JSON.stringify(fixture)};
const view=createOwnerAtlasView();
if(new URLSearchParams(location.search).has("media")) {
fixture.media=[{id:"photo-one",journeyId:fixture.id,routePointId:null,fileName:"虚构照片.svg",mimeType:"image/svg+xml",bytes:100,sortOrder:0,createdAt:fixture.createdAt}];
view.readMedia=async()=>({url:"/artifacts/daily-journal/fictional-photo.svg",expiresAt:"2099-01-01T00:00:00Z"});
}
if(new URLSearchParams(location.search).has("layout")) {
fixture.title="虚构旅行与很长的章节标题".repeat(8);
fixture.routePoints[0].note="沿途文字与路线记录。".repeat(80);
fixture.media.push({id:"music",journeyId:fixture.id,routePointId:null,fileName:"虚构配乐.wav",mimeType:"audio/wav",bytes:50,sortOrder:1,createdAt:fixture.createdAt});
const read=view.readMedia; view.readMedia=async asset=>asset==="music" ? {url:"data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==",expiresAt:"2099-01-01T00:00:00Z"} : read(asset);
}
function Harness(){const [journey,setJourney]=useState(fixture);const [epoch,setEpoch]=useState(0);
useEffect(()=>{const remount=()=>setEpoch(n=>n+1);window.addEventListener("qa-remount-stream",remount);return()=>window.removeEventListener("qa-remount-stream",remount)},[]);
useEffect(()=>{const switcher=()=>setJourney({...fixture,atlasId:"other-atlas",id:"33333333-3333-4333-8333-333333333333",title:"另一账号"}); window.addEventListener("qa-account-switch",switcher);return()=>window.removeEventListener("qa-account-switch",switcher)},[]);
return <AtlasViewProvider value={view}><main className="living-atlas"><JourneyStream key={epoch} onJourneyUpdated={j=>{window.__ownerJourney=j;setJourney(j)}} journeys={[journey]} journeyId={journey.id} onClose={()=>{}} onOpenClassic={()=>{}} onObservationChange={v=>window.__observation=v}/></main></AtlasViewProvider>}
createRoot(document.getElementById("root")).render(<Harness/>);`);
await writeFile(`${output}/index.html`, '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
await writeFile(`${output}/fictional-photo.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#4a6970"/><circle cx="300" cy="150" r="60" fill="#edce92"/><path d="M0 400L200 220L400 400Z" fill="#193844"/></svg>');
// These are fictional model outputs, not a replacement for the production recognizer.
function fictionalChapters(source) {
  const chapters = [];
  for (const line of source.split("\n")) {
    const heading = line.match(/^(?:### )?2027(?:-|年)0?4(?:-|月)(\d{1,2})(?:日)?(.*)$/);
    if (heading) {
      const date = `2027-04-${heading[1].padStart(2,"0")}`;
      chapters.push({id:`chapter-${chapters.length}`,date,importDate:date,title:heading[2],source:line,suggestions:[],events:[]});
      continue;
    }
    const chapter = chapters.at(-1);
    assert.ok(chapter, "fictional inputs must begin with a known date heading");
    chapter.source += "\n" + line;
    if (!line.trim()) continue;
    const time = line.match(/^(\d{2}:\d{2}) /)?.[1] ?? null;
    chapter.events.push({id:`${chapter.id}-event-${chapter.events.length}`,source:line,text:line,
      status:line.startsWith("取消：") || line === "计划公园取消" ? "cancelled" : line.startsWith("计划：") ? "planned" : "actual",
      localDate:null,localTime:time,timeContext:"当地时间（具体时区未确认）",routePointId:null,mediaIds:[],edited:false});
  }
  return chapters;
}
async function mockImports(page, getSaved) {
  const state = {posts:0,observes:0,cancels:0,hold:false,release:null};
  const jobs = new Map();
  state.waitForObserver = () => new Promise(resolve => { state.observerReady = resolve; });
  await page.route(/\/api\/intents\/journal-import\//, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/provider")) return route.fulfill({json:{available:true,baseUrl:"provider:synthetic",model:"synthetic"}});
    if (path.endsWith("/jobs")) {
      state.posts++; state.release=null;
      const body = request.postDataJSON(), before = structuredClone(getSaved());
      const imported = fictionalChapters(body.source);
      const chapters = [...before.chapters];
      for (const chapter of imported) if (!chapters.some(old => old.source === chapter.source)) chapters.push(chapter);
      const final = {jobId:body.requestId,status:"completed",planDigest:"a".repeat(64),envelope:{signature:"b".repeat(64),plan:{
        version:2,target:{journeyId:body.journeyId,atlasId:fixture.atlasId},before,after:{revision:before.revision+1,chapters},
        importedChapterIds:chapters.map(c=>c.id),expires:Date.now()+3600000}}};
      jobs.set(body.requestId,{final,release:null});
      return route.fulfill({json:{jobId:body.requestId}});
    }
    const match = path.match(/\/jobs\/([^/]+)(?:\/(events|cancel))?$/);
    assert.ok(match,"unexpected fictional import request");
    const job = jobs.get(match[1]); assert.ok(job);
    if (match[2] === "cancel") {
      state.cancels++; job.final={jobId:match[1],status:"cancelled"}; job.release?.();
      return route.fulfill({json:job.final});
    }
    if (match[2] === "events") {
      state.observes++;
      if (state.hold) await new Promise(resolve=>{job.release=resolve;state.release=resolve;state.observerReady?.();state.observerReady=null;});
      return route.fulfill({contentType:"text/event-stream",body:`event: ${job.final.status}\ndata: ${JSON.stringify(job.final)}\n\n`}).catch(()=>{});
    }
    return route.fulfill({json:job.final});
  });
  return state;
}
// Wrapped label text includes the controlled textarea value after React updates it.
const sourceInput = page => page.locator(".daily-journal__import textarea");
async function importPreview(page, source) {
  await sourceInput(page).fill(source);
  await page.getByRole("button",{name:"用 AI 导入",exact:true}).click();
  await page.getByRole("button",{name:"确认保存",exact:true}).waitFor();
  await page.getByText("识别完成，已填入预览，尚未保存。",{exact:true}).waitFor();
}
const browser = await launchQaBrowser();
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    let saved = { revision: 0, chapters: [] }, writes = 0;
    let releaseSave;
    const imports = await mockImports(page, () => saved);
    await page.route(/\/api\/journeys\/[^/]+\/journal$/, async route => {
      const request = route.request();
      if (request.method() === "PUT") {
        writes++; await new Promise(resolve => { releaseSave = resolve; }); saved = { revision: saved.revision + 1, chapters: request.postDataJSON().chapters };
        await route.fulfill({ json: { journal: saved } });
      } else await route.fulfill({ json: { journal: request.url().includes(fixture.id) ? saved : {revision:0,chapters:[]} } });
    });
    // Saving an AI-imported preview continues straight into the hotel preview.
    let hotelPreviews=0;
    await page.route(/\/api\/journeys\/[^/]+\/journal\/hotels\/preview$/, route=>{hotelPreviews++;return route.fulfill({json:{preview:{token:"synthetic",hotels:[],questions:[]}}});});
    const errors=[]; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${origin}/${output}/index.html`);
    await page.getByRole("button",{name:"每日手记",exact:true}).click();
    const source="2027-04-03\n23:30 她出发\n18:20 她抵达\n计划公园取消\n" + "她记下沿途所见。".repeat(120);
    assert.equal(await page.getByRole("button",{name:"生成导入预览"}).count(),0);
    assert.equal(await page.getByRole("button",{name:"用 AI 整理原文"}).count(),0);
    // Hold a fictional job to prove double clicks do not submit twice and Stop does not save.
    imports.hold=true;
    await sourceInput(page).fill(source);
    const submitted=page.waitForRequest(r=>r.method()==="POST" && r.url().endsWith("/journal-import/jobs"));
    await page.getByRole("button",{name:"用 AI 导入",exact:true}).dblclick(); await submitted;
    await page.getByRole("button",{name:"停止",exact:true}).click();
    await page.getByText("已停止，原文已保留。",{exact:true}).waitFor();
    assert.equal(imports.posts,1); assert.equal(imports.cancels,1); assert.equal(writes,0);
    assert.equal(await sourceInput(page).inputValue(),source,"Stop preserves the original input");
    assert.equal(await sourceInput(page).isEnabled(),true,"Stop releases the input for another import");
    imports.hold=false;
    await importPreview(page,source);
    assert.equal(await page.getByLabel("阅读正文",{exact:true}).count(),0,"completion defaults to reading view");
    await page.getByRole("button",{name:"取消预览"}).click();
    assert.equal(writes,0); assert.equal(saved.chapters.length,0);
    await importPreview(page,source);
    await page.getByRole("button",{name:"编辑预览",exact:true}).click();
    assert.equal(await page.getByLabel("事件状态",{exact:true}).nth(0).inputValue(),"actual");
    assert.equal(await page.getByLabel("事件状态",{exact:true}).nth(2).inputValue(),"cancelled");
    await page.getByLabel("阅读正文",{exact:true}).nth(0).fill("她手工修订了出发记录。");
    await page.getByText("时间、地图点与照片（选填）",{exact:true}).nth(0).click();
    assert.equal(await page.getByLabel("原文明确的当地钟点（可空）",{exact:true}).nth(0).inputValue(),"23:30");
    await page.getByLabel("已确认的实际地点",{exact:true}).nth(0).selectOption(fixture.routePoints[0].id);
    await page.getByText("时间、地图点与照片（选填）",{exact:true}).nth(2).click();
    assert.equal(await page.getByLabel("已确认的实际地点",{exact:true}).nth(2).isDisabled(),true);
    await page.getByRole("button",{name:"返回阅读",exact:true}).click();
    await page.getByRole("button",{name:"编辑预览",exact:true}).click();
    assert.equal(await page.getByLabel("阅读正文",{exact:true}).nth(0).inputValue(),"她手工修订了出发记录。");
    const saveRequested=page.waitForRequest(r=>r.method()==="PUT" && r.url().endsWith("/journal"));
    await page.getByRole("button",{name:"确认保存"}).dblclick();
    await saveRequested;
    assert.equal(await page.getByRole("button",{name:"返回 Stream",exact:true}).isDisabled(),true);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button",{name:"丢弃并返回",exact:true}).count(),0);
    releaseSave();
    await page.getByText("手记已保存。",{exact:true}).waitFor(); assert.equal(writes,1);
    assert.equal(saved.chapters.length,1);
    assert.equal(saved.chapters[0].source,source);
    await page.getByText("没有可可靠确认的住宿地点；未写入。",{exact:true}).waitFor(); assert.equal(hotelPreviews,1);
    await importPreview(page,source);
    await page.getByRole("button",{name:"编辑预览",exact:true}).click();
    assert.equal(await page.getByLabel("阅读正文",{exact:true}).nth(0).inputValue(),"她手工修订了出发记录。");
    await page.getByRole("button",{name:"取消预览"}).click();
    await page.getByRole("heading",{level:2}).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true);
    await page.screenshot({path:`${output}/journal-${width}.png`});
    await page.getByRole("button",{name:/在 Stream 中查看地点/}).click();
    await page.waitForFunction(id=>window.__observation?.routePointId===id,fixture.routePoints[0].id);
    await page.getByRole("button",{name:"每日手记",exact:true}).click();
    // An old account's late completed response must not populate the new account.
    imports.hold=true;
    await sourceInput(page).fill(source);
    const observing=imports.waitForObserver();
    await page.getByRole("button",{name:"用 AI 导入",exact:true}).click(); await observing;
    await page.getByRole("button",{name:"停止",exact:true}).waitFor();
    await page.evaluate(()=>window.dispatchEvent(new Event("qa-account-switch")));
    imports.release?.();
    await page.getByRole("button",{name:"每日手记",exact:true}).click();
    await page.getByText("还没有每日手记。可以先导入文字，无照片和坐标也能保存阅读。",{exact:true}).waitFor();
    assert.equal(await page.getByText("她手工修订了出发记录。",{exact:true}).count(),0);
    assert.deepEqual(errors,[]);
    await context.close();
    console.log(`daily journal browser regression passed: ${width}px`);
  }
  const context = await browser.newContext({viewport:{width:390,height:844},reducedMotion:"reduce"});
  const page=await context.newPage();
  let stored={revision:0,chapters:[]};
  await mockImports(page,()=>stored);
  await page.route(/\/hotels\/preview$/, route=>route.fulfill({json:{preview:{token:"synthetic",hotels:[],questions:[]}}}));
  await page.route(/\/api\/journeys\/[^/]+\/journal$/, async route=>{
    if(route.request().method()==="PUT") {
      // The fictional server marks the chapters this save adds from the import as one undoable batch.
      const body=route.request().postDataJSON(); savedImportIds=body.importedChapterIds;
      stored={revision:1,chapters:body.chapters.map(c=>body.importedChapterIds?.includes(c.id)?{...c,importBatch:{id:"batch-fortnight",at:"2027-04-15T00:00:00.000Z",digest:"c".repeat(64),pointIds:[]}}:c)};
    }
    await route.fulfill({json:{journal:stored}});
  });
  let savedImportIds, undoBodies=[];
  await page.route(/\/journal\/imports\/batch-fortnight\/undo$/, route=>{
    const body=route.request().postDataJSON(); undoBodies.push(body);
    if(!body.confirmEdited) return route.fulfill({status:409,json:{error:"JOURNAL_IMPORT_EDITED",edited:1}});
    stored={revision:2,chapters:[]};
    return route.fulfill({json:{journal:stored,journey:fixture}});
  });
  await page.goto(`${origin}/${output}/index.html?media=1`);
  await page.getByRole("button",{name:"每日手记",exact:true}).click();
  const fortnight=Array.from({length:14},(_,i)=>`### 2027年4月${i+1}日${i%2 ? "(虚构记录)" : "（虚构记录）"}\n实际：她留下了一张照片。\n计划：次日虚构公园\n取消：原定花园`).join("\n");
  await importPreview(page,fortnight);
  await page.getByRole("button",{name:"编辑预览",exact:true}).click();
  await page.getByText("时间、地图点与照片（选填）",{exact:true}).nth(0).click();
  await page.getByLabel("关联照片或视频（可多选）",{exact:true}).nth(0).selectOption(["photo-one"]);
  await page.getByRole("button",{name:"确认保存"}).click();
  await page.getByText("手记已保存。",{exact:true}).waitFor();
  await page.getByAltText("虚构照片.svg").scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector(".daily-journal__media img")?.naturalWidth===600);
  assert.deepEqual(stored.chapters[0].events[0].mediaIds,["photo-one"]);
  assert.equal(stored.chapters.length,14);
  assert.deepEqual(stored.chapters.map(chapter=>chapter.date),Array.from({length:14},(_,i)=>`2027-04-${String(i+1).padStart(2,"0")}`));
  assert.equal(stored.chapters.map(chapter=>chapter.source).join("\n"),fortnight);
  for(const chapter of stored.chapters) assert.deepEqual(chapter.events.map(e=>e.status),["actual","planned","cancelled"]);
  assert.equal(await page.getByRole("navigation",{name:"手记日期目录"}).getByRole("link").count(),14);
  await page.screenshot({path:`${output}/journal-media-390.png`});
  assert.equal(savedImportIds.length,14);
  // One step undoes the whole saved import; edited chapters need a second, explicit confirmation.
  await page.getByRole("button",{name:"撤销这次导入",exact:true}).click();
  await page.getByText("撤销这次导入会移除 14 章。",{exact:true}).waitFor();
  await page.getByRole("button",{name:"确认撤销",exact:true}).click();
  await page.getByText("其中 1 章导入后有修改，撤销会一并丢失。",{exact:true}).waitFor();
  assert.equal(stored.chapters.length,14);
  await page.getByRole("button",{name:"确认撤销",exact:true}).click();
  await page.getByText("已撤销这次导入。",{exact:true}).waitFor();
  await page.getByText("还没有每日手记。可以先导入文字，无照片和坐标也能保存阅读。",{exact:true}).waitFor();
  assert.deepEqual(undoBodies,[{baseRevision:1,confirmEdited:false},{baseRevision:1,confirmEdited:true}]);
  assert.equal(await page.getByRole("button",{name:"撤销这次导入",exact:true}).count(),0);
  await context.close();
  console.log("daily journal inline media passed");
  for(const [width,height] of [[320,700],[390,844],[844,390],[1112,402],[1280,900]]) {
    const context=await browser.newContext({viewport:{width,height},reducedMotion:"reduce"});
    const page=await context.newPage();
    const long="虚构的长篇记录，保留原有叙事顺序。".repeat(160);
    const chapters=[1,2].map(day=>({id:`day-${day}`,date:`2027-04-0${day}`,importDate:`2027-04-0${day}`,title:"虚构章节".repeat(20),source:long,suggestions:[],events:[{id:`event-${day}`,source:long,text:long,status:"uncertain",localDate:null,localTime:null,timeContext:"当地时间",routePointId:null,mediaIds:[],edited:false}]}));
    await page.route(/\/api\/journeys\/[^/]+\/journal$/,route=>route.fulfill({json:{journal:{revision:1,chapters}}}));
    await page.goto(`${origin}/${output}/index.html?media=1&layout=1`);
    await page.getByRole("button",{name:"每日手记",exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.journey-stream__header button[aria-label="播放配乐"]')?.disabled===false);
    const assertLayout=async()=>{
      const bounds=await page.evaluate(()=>{
        const header=document.querySelector(".journey-stream__header").getBoundingClientRect();
        const flow=document.querySelector(".journey-stream__flow").getBoundingClientRect();
        const button=document.querySelector(".journey-stream__text-action");
        return {bottom:header.bottom,top:flow.top,height:flow.height,right:header.right,width:innerWidth,buttonHeight:button?.getBoundingClientRect().height,buttons:[...document.querySelectorAll(".journey-stream__header button")].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})};
      });
      assert.ok(bounds.top>=bounds.bottom-1,"flow must be clipped below the actual header");
      assert.ok(bounds.height>100 && bounds.right<=bounds.width+1);
      assert.ok(bounds.buttonHeight>=44,"journal uses the shared touch target");
      for(const b of bounds.buttons) assert.ok(b.left>=0 && b.right<=bounds.width+1 && b.top>=0 && b.bottom<=bounds.bottom+1);
    };
    await assertLayout();
    // Content must follow a taller header without a fixed pixel offset.
    await page.locator(".journey-stream__header").evaluate(el=>el.style.paddingTop="42px");
    await assertLayout();
    await page.locator(".journey-stream__header").evaluate(el=>el.style.removeProperty("padding-top"));
    await page.setViewportSize({width:height,height:width});
    await assertLayout();
    await page.setViewportSize({width,height});
    await assertLayout();
    await page.screenshot({path:`${output}/stream-layout-${width}.png`});
    await page.evaluate(()=>{const chrome=document.createElement("div");chrome.id="qa-underlying-chrome";chrome.style.cssText="position:fixed;inset:0;z-index:200;background:red";document.querySelector(".living-atlas").append(chrome)});
    for(let cycle=0;cycle<3;cycle++) {
      await page.getByRole("button",{name:"每日手记",exact:true}).click();
      const panel=page.getByRole("dialog",{name:"每日手记",exact:true});
      await panel.getByRole("navigation").waitFor();
      assert.equal(await panel.evaluate(el=>el.contains(document.elementFromPoint(20,20))),true,"journal stays above underlying Atlas chrome");
      assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,"long prose must not overflow horizontally");
      await panel.getByRole("link").last().click();
      const second=panel.locator("article").last();
      assert.ok((await second.boundingBox()).y>=-1,"date navigation remains inside the journal scrollport");
      await panel.evaluate(el=>el.scrollTop=el.scrollHeight);
      const bottom=await panel.evaluate(el=>({top:el.scrollTop,max:el.scrollHeight-el.clientHeight,body:document.scrollingElement.scrollTop}));
      assert.ok(Math.abs(bottom.top-bottom.max)<=1 && bottom.body===0);
      await panel.evaluate(el=>el.scrollTop=0);
      if(cycle===0) await page.screenshot({path:`${output}/journal-layout-${width}.png`});
      await page.getByRole("button",{name:"返回 Stream",exact:true}).click();
      await assertLayout();
    }
    await context.close();
    console.log(`daily journal layout passed: ${width}x${height}`);
  }
} finally { await browser.close(); }
