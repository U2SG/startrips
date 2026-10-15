import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const ROOT = ".story-media-organizer";
const STICKY = ".story-media-organizer__destinations";
const output = "artifacts/story-media/organizer-scroll-edges";

/** Render the production organizer with deterministic input, not a lookalike.
 * The production CSS supplies every dimension, sticky rule and cue color. */
export async function assertOrganizerScrollEdges(browser, origin) {
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/harness.tsx`, `import React from "react";
import {createRoot} from "react-dom/client";
import {StoryMediaOrganizer} from "/src/journey/StoryMediaOrganizer";
import {JourneyStory} from "/src/journey/JourneyStory";
import "/src/styles/tokens.css";
import "/src/styles/controls.css";
import "/src/app.css";
import "/src/styles/living-atlas.css";
const count = Number(new URLSearchParams(location.search).get("count"));
const media = Array.from({length:count}, (_,i)=>({id:"edge-"+i, journeyId:"qa",routePointId:"point-a",
 fileName:"clip-"+i+".webm",mimeType:"video/webm",bytes:1,sortOrder:i,createdAt:"2026-10-15"}));
const routePoints = ["a","b","c"].map((id,i)=>({id:"point-"+id,journeyId:"qa",sortOrder:i,
 latitude:22+i,longitude:114,label:"Stop "+id,isStop:true,note:null,occurredAt:null,createdAt:"2026-10-15"}));
const story = new URLSearchParams(location.search).get("host") === "story";
const journey = {id:"qa",atlasId:"qa-atlas",title:"Sticky scroll regression",note:"",startedOn:"2026-10-15",
 endedOn:null,lightColor:"#74e7d0",revision:1,createdByUserId:"qa",createdAt:"2026-10-15",updatedAt:"2026-10-15",routePoints,media};
createRoot(document.getElementById("root")).render(<main className="living-atlas">{story ? <JourneyStory
 journeys={[journey]} journeyId="qa" onClose={()=>{}} onEdit={()=>{}} /> : <StoryMediaOrganizer
 media={media} allMedia={media} routePoints={routePoints} reads={{}} currentId={null} coverId={null}
 selectedIds={new Set(media.slice(0,1).map(a=>a.id))} selecting={true} disabled={false}
 onToggleSelect={()=>{}} onSelect={()=>{}} onRequestRead={()=>{}} onReorder={()=>{}} onMove={async()=>false}/>}</main>);`);
  const results = [];
  const cases = [{width:1280,height:800}, {width:320,height:740}, {width:390,height:844},
    {width:430,height:932}, {width:844,height:390}].flatMap(viewport=>[48,0].map(count=>({viewport,count,host:"component"})));
  // This MUST enter the real desktop Story: its later background shorthand
  // previously erased the sticky gradient although isolated component QA passed.
  cases.push({viewport:{width:1280,height:800},count:48,host:"story"});
  for (const {viewport,count,host} of cases) {
      const name = `organizer-scroll-${host}-${count}-${viewport.width}x${viewport.height}`;
      const page = await browser.newPage({viewport,deviceScaleFactor:1,reducedMotion:"reduce",
        isMobile:viewport.width!==1280,hasTouch:viewport.width!==1280});
      const errors = [];
      page.on("pageerror", (error)=>errors.push(error.message));
      try {
        await page.route("**/__organizer_scroll_edges?*", route=>route.fulfill({contentType:"text/html",body:
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/${output}/harness.tsx"></script>`}));
        await page.route("**/api/auth/get-session", route=>route.fulfill({json:null}));
        await page.route("**/api/uploads/assets/*/read-url", route=>route.fulfill({json:{
          url:`${origin}/demo-media/east-star-orbit.webm`,expiresAt:"2099-01-01T00:00:00.000Z"}}));
        await page.goto(`${origin}/__organizer_scroll_edges?count=${count}&host=${host}`,{waitUntil:"domcontentloaded"});
        if (host === "story") {
          await page.locator('.journey-story[data-story-layout="desktop"]').waitFor({state:"visible",timeout:3_000});
          await page.getByRole("button",{name:"编辑故事",exact:true}).click();
        }
        const root = page.locator(ROOT), sticky = page.locator(STICKY);
        await root.waitFor({state:"visible",timeout:3_000});
        const check = async (before, after, phase, forced = false) => {
          await page.waitForFunction(({selector,sticky,before,after,forced})=>{
            const node=document.querySelector(selector), header=document.querySelector(sticky);
            if (!node || !header || node.dataset.scrollBefore!==String(before) || node.dataset.scrollAfter!==String(after)
              || matchMedia("(forced-colors: active)").matches!==forced) return false;
            const style=getComputedStyle(node), ink=getComputedStyle(header);
            return !forced || (style.borderTopWidth==="0px" && style.borderBottomWidth===(after ? "1px" : "0px")
              && ink.borderTopWidth===(before ? "2px" : "0px"));
          },{selector:ROOT,sticky:STICKY,before,after,forced},{polling:"raf",timeout:3_000});
          const geometry = await root.evaluate(node=>({top:node.getBoundingClientRect().top+node.clientTop,
            maximum:node.scrollHeight-node.clientHeight,scrollTop:node.scrollTop}));
          const paint = await sticky.evaluate(node=>{
            const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
            const x=Math.ceil(rect.left+rect.width/2),y=Math.ceil(rect.top);
            const hit=document.elementFromPoint(x+1,y+.5);
            return {x,y,top:rect.top,position:style.position,background:style.backgroundColor,
              image:style.backgroundImage,ink:style.getPropertyValue("--scroll-edge-before").trim(),
              forced:matchMedia("(forced-colors: active)").matches,borderWidth:style.borderTopWidth,
              hit:hit===node || node.contains(hit)};
          });
          assert.equal(paint.position,"sticky",`${name}/${phase}: test the real sticky destinations`);
          if (before) assert.ok(Math.abs(paint.top-geometry.top)<=1,`${name}/${phase}: the header must cover the root's top edge`);
          assert.equal(paint.hit,true,`${name}/${phase}: another layer covers the cue`);
          const path=`${output}/${name}-${phase}.png`;
          assert.equal(paint.forced,forced,`${name}/${phase}: verify the requested color mode`);
          if (forced) assert.equal(paint.borderWidth,before ? "2px" : "0px");
          const buffer=await page.screenshot({path,clip:{x:paint.x,y:paint.y,width:3,height:3}});
          const {data,info}=await sharp(buffer).removeAlpha().raw().toBuffer({resolveWithObject:true});
          // Compare against the actual composited padding pixel, not raw rgba
          // components: production desktop sticky backgrounds are translucent.
          // The fourth pixel row can antialias the first button when top is
          // fractional. Row two is beyond the 2px cue and inside 4px padding.
          const reference=(2*info.width+1)*info.channels;
          const base=[...data.subarray(reference,reference+3)];
          const pixel=[...data.subarray(info.channels,info.channels+3)];
          const difference=pixel.reduce((sum,value,i)=>sum+Math.abs(value-base[i]),0);
          assert.ok(before ? difference>=20 : difference<=3,
            `${name}/${phase}: sticky cue pixels ${pixel} vs opaque background ${base}, difference=${difference}`);
          return {phase,before,after,geometry,paint,pixel,difference};
        };
        const states=[await check(false,count>0,"initial")];
        assert.ok(count>0 ? states[0].geometry.maximum>=128 : states[0].geometry.maximum<=1,
          `${name}: fixture must ${count>0 ? "overflow" : "fit"}, not skip its checks`);
        if (count>0) {
          await root.evaluate(node=>node.scrollTo({top:(node.scrollHeight-node.clientHeight)/2,behavior:"instant"}));
          states.push(await check(true,true,"middle-sticky"));
          await root.evaluate(node=>node.scrollTo({top:node.scrollHeight,behavior:"instant"}));
          states.push(await check(true,false,"bottom-sticky"));
          await page.emulateMedia({forcedColors:"active"});
          states.push(await check(true,false,"forced-bottom-visible",true));
          await root.evaluate(node=>node.scrollTo({top:0,behavior:"instant"}));
          states.push(await check(false,true,"forced-top-invisible",true));
          await root.evaluate(node=>node.scrollTo({top:(node.scrollHeight-node.clientHeight)/2,behavior:"instant"}));
          states.push(await check(true,true,"forced-middle-visible",true));
          await root.evaluate(node=>node.scrollTo({top:0,behavior:"instant"}));
          await page.emulateMedia({forcedColors:"none"});
          states.push(await check(false,true,"return-top"));
        } else {
          await root.evaluate(node=>node.scrollTo({top:node.scrollHeight,behavior:"instant"}));
          states.push(await check(false,false,"fits-after-scroll"));
          await page.emulateMedia({forcedColors:"active"});
          states.push(await check(false,false,"forced-fits-invisible",true));
        }
        assert.deepEqual(errors,[],`${name}: browser exceptions`);
        results.push({name,states,failed:false});
      } catch(error) {
        results.push({name,error:String(error),stack:error?.stack,failed:true});
      } finally {await page.close();}
  }
  await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
  return results;
}
