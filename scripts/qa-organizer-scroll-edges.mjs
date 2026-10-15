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
import "/src/styles/tokens.css";
import "/src/styles/controls.css";
import "/src/app.css";
import "/src/styles/living-atlas.css";
const count = Number(new URLSearchParams(location.search).get("count"));
const media = Array.from({length:count}, (_,i)=>({id:"edge-"+i, journeyId:"qa",routePointId:"point-a",
 fileName:"clip-"+i+".webm",mimeType:"video/webm",bytes:1,sortOrder:i,createdAt:"2026-10-15"}));
const routePoints = ["a","b","c"].map((id,i)=>({id:"point-"+id,journeyId:"qa",sortOrder:i,
 latitude:22+i,longitude:114,label:"Stop "+id,isStop:true,note:null,occurredAt:null,createdAt:"2026-10-15"}));
createRoot(document.getElementById("root")).render(<main className="living-atlas"><StoryMediaOrganizer
 media={media} allMedia={media} routePoints={routePoints} reads={{}} currentId={null} coverId={null}
 selectedIds={new Set(media.slice(0,1).map(a=>a.id))} selecting={true} disabled={false}
 onToggleSelect={()=>{}} onSelect={()=>{}} onRequestRead={()=>{}} onReorder={()=>{}} onMove={async()=>false}/></main>);`);
  const results = [];
  for (const viewport of [{width:1280,height:800}, {width:320,height:740}, {width:390,height:844},
    {width:430,height:932}, {width:844,height:390}]) {
    for (const count of [48, 0]) {
      const name = `organizer-scroll-${count}-${viewport.width}x${viewport.height}`;
      const page = await browser.newPage({viewport,deviceScaleFactor:1,reducedMotion:"reduce",
        isMobile:viewport.width!==1280,hasTouch:viewport.width!==1280});
      const errors = [];
      page.on("pageerror", (error)=>errors.push(error.message));
      try {
        await page.route("**/__organizer_scroll_edges?*", route=>route.fulfill({contentType:"text/html",body:
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/${output}/harness.tsx"></script>`}));
        await page.goto(`${origin}/__organizer_scroll_edges?count=${count}`,{waitUntil:"domcontentloaded"});
        const root = page.locator(ROOT), sticky = page.locator(STICKY);
        await root.waitFor({state:"visible",timeout:3_000});
        const check = async (before, after, phase) => {
          await page.waitForFunction(({selector,before,after})=>{
            const node=document.querySelector(selector);
            return node?.dataset.scrollBefore===String(before) && node.dataset.scrollAfter===String(after);
          },{selector:ROOT,before,after},{polling:"raf",timeout:3_000});
          const geometry = await root.evaluate(node=>({top:node.getBoundingClientRect().top+node.clientTop,
            maximum:node.scrollHeight-node.clientHeight,scrollTop:node.scrollTop}));
          const paint = await sticky.evaluate(node=>{
            const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
            const x=Math.ceil(rect.left+rect.width/2),y=Math.ceil(rect.top);
            const hit=document.elementFromPoint(x+1,y+.5);
            return {x,y,top:rect.top,position:style.position,background:style.backgroundColor,
              image:style.backgroundImage,ink:style.getPropertyValue("--scroll-edge-before").trim(),
              hit:hit===node || node.contains(hit)};
          });
          assert.equal(paint.position,"sticky",`${name}/${phase}: test the real sticky destinations`);
          if (before) assert.ok(Math.abs(paint.top-geometry.top)<=1,`${name}/${phase}: the header must cover the root's top edge`);
          assert.equal(paint.hit,true,`${name}/${phase}: another layer covers the cue`);
          const path=`${output}/${name}-${phase}.png`;
          const buffer=await page.screenshot({path,clip:{x:paint.x,y:paint.y,width:3,height:1}});
          const {data,info}=await sharp(buffer).removeAlpha().raw().toBuffer({resolveWithObject:true});
          const base=paint.background.match(/[\d.]+/g).slice(0,3).map(Number);
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
          const border=await sticky.evaluate(node=>({width:getComputedStyle(node).borderTopWidth,color:getComputedStyle(node).borderTopColor}));
          assert.equal(border.width,"2px");
          assert.notEqual(border.color,"rgba(0, 0, 0, 0)",`${name}: forced-colors cue must remain visible`);
          await root.evaluate(node=>node.scrollTo({top:0,behavior:"instant"}));
          await page.waitForFunction(selector=>document.querySelector(selector)?.dataset.scrollBefore==="false",ROOT,{polling:"raf",timeout:3_000});
          assert.equal(await sticky.evaluate(node=>getComputedStyle(node).borderTopColor),"rgba(0, 0, 0, 0)");
          await page.emulateMedia({forcedColors:"none"});
          states.push(await check(false,true,"return-top"));
        } else {
          await root.evaluate(node=>node.scrollTo({top:node.scrollHeight,behavior:"instant"}));
          states.push(await check(false,false,"fits-after-scroll"));
        }
        assert.deepEqual(errors,[],`${name}: browser exceptions`);
        results.push({name,states,failed:false});
      } catch(error) {
        results.push({name,error:String(error),stack:error?.stack,failed:true});
      } finally {await page.close();}
    }
  }
  await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
  return results;
}
