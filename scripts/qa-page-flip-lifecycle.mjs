import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { launchQaBrowser } from "./qa-browser.mjs";
const require=createRequire(import.meta.url);
const out="artifacts/story-repair/page-flip-lifecycle";
await fs.mkdir(out,{recursive:true});
const browser=await launchQaBrowser();
const page=await browser.newPage({viewport:{width:390,height:844}});
try {
 await page.setContent('<main><div id="host"></div></main>');
 await page.addScriptTag({path:require.resolve("page-flip")});
 const result=await page.evaluate(async()=>{
  const frames=async count=>{for(let i=0;i<count;i++)await new Promise(requestAnimationFrame);};
  const records=[];
  for(const duringFrame of [false,true]) {
   const host=document.createElement('div');host.style.cssText='width:300px;height:400px';document.body.appendChild(host);
   const pages=Array.from({length:4},(_,i)=>{const p=document.createElement('section');p.textContent=`Chapter ${i}`;host.appendChild(p);return p;});
   const book=new window.St.PageFlip(host,{width:150,height:200,useMouseEvents:false});book.loadFromHTML(pages);
   const renderer=book.getRender();const render=renderer.render.bind(renderer);let total=0;let afterDestroy=0;let destroyed=false;
   renderer.render=time=>{total++;if(destroyed)afterDestroy++;render(time);if(duringFrame&&!destroyed){destroyed=true;book.destroy();}};
   await frames(6);
   if(!destroyed){destroyed=true;book.destroy();}
   const atDestroy=total;await frames(12);
   records.push({duringFrame,total,atDestroy,afterDestroy,detached:!host.isConnected});
  }
  return records;
 });
 const suffix=process.argv.includes('--baseline')?'baseline':'fixed';
 await fs.writeFile(`${out}/${suffix}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 assert.ok(result.every(r=>r.total>0&&r.detached),'actual PageFlip lifecycle did not execute');
 assert.ok(result.every(r=>r.afterDestroy===0),'destroyed PageFlip still renders on every frame');
} finally {await browser.close();}
