import { PRESETS, FLOW_VERSION, validateOptions, validatePoint, clamp, finite } from './presets.js';
import { createNoiseAtlas } from './noise.js';
import { loadFlowImage } from './images.js';
import { createFiberMap } from './fiber.js';
import { WebGLBackend, ThreeBackend, CanvasBackend } from './backends.js';

/**
 * Framework-independent, reusable two-image transition player.
 * Coordinates are normalized, top-left origin, relative to the displayed stage.
 * Pass {THREE} to use Three.js, or omit it for the dependency-free WebGL2 backend.
 */
export class RevealFlow extends EventTarget {
  constructor(options = {}) {
    super();
    this.options=validateOptions(options);this.progress=0;this.playing=false;this.disposed=false;
    this.direction=1;this._intent=0;this._imageVersion=0;this._raf=0;this._fiberKey='';this._images=null;
    this.container=typeof options.container==='string'?document.querySelector(options.container):options.container;
    if(!(this.container instanceof HTMLElement)) throw new TypeError('container must be an HTMLElement or a valid selector.');
    this.canvas=this._makeCanvas();
    try {this.backend=options.THREE?new ThreeBackend(this.canvas,options.THREE):new WebGLBackend(this.canvas);}
    catch(error) {
      if(options.fallback===false){this.canvas.remove();throw error;}
      this.canvas.remove();this.canvas=this._makeCanvas();this.backend=new CanvasBackend(this.canvas);
      this.warning=`GPU 渲染不可用，已降级为普通淡入：${error.message}`;
    }
    this._onLost=e=>{e.preventDefault();this.pause();this._contextLost=true;this.emit('warning',{message:'图形上下文丢失，等待浏览器恢复。'});};
    this._onRestored=()=>{if(this.disposed)return;this._contextLost=false;this.backend.restore();this.render();this.emit('restored',{});};
    this.canvas.addEventListener('webglcontextlost',this._onLost);
    this.canvas.addEventListener('webglcontextrestored',this._onRestored);
    this._onHidden=()=>{if(document.hidden)this.pause();};document.addEventListener('visibilitychange',this._onHidden);
    this._media=window.matchMedia('(prefers-reduced-motion: reduce)');
    this._onReduced=()=>{if(this._media.matches&&this.options.respectReducedMotion&&this.playing){const end=this.direction>0?1:0;this.seek(end);this.emit('complete',{progress:end,reducedMotion:true});}};
    this._media.addEventListener('change',this._onReduced);
    this.backend.setTexture('uNoise',createNoiseAtlas(this.options.seed),true);
    this.backend.setTexture('uFiber',{data:new Uint8Array([0,0,0,255,255,255,0,255,0,0,0,255,255,255,0,255]),width:2,height:2});
    this._observer=new ResizeObserver(()=>{if(!this.disposed)this.resize();});this._observer.observe(this.container);
    this.resize();
    this.ready=Promise.resolve(this);
    if(options.from!=null&&options.to!=null)this.setImages(options.from,options.to);
  }
  _makeCanvas(){const c=document.createElement('canvas');c.style.cssText='display:block;width:100%;height:100%;';c.setAttribute('aria-hidden','true');this.container.append(c);return c;}
  _check(){if(this.disposed)throw new Error('This RevealFlow instance has been disposed.');}
  emit(name,detail){this.dispatchEvent(new CustomEvent(name,{detail}));}
  get backendName(){return this.backend.name;}
  get imageInfo(){return this._images?{from:{width:this._images[0].width,height:this._images[0].height},to:{width:this._images[1].width,height:this._images[1].height}}:null;}
  setImages(from,to){
    const job=this._loadImages(from,to);
    this.ready=job.then(()=>this);
    // Keep the public ready promise rejectable while avoiding an unobserved internal rejection.
    this.ready.catch(()=>{});
    return job;
  }
  async _loadImages(from,to){
    this._check();this.pause();this._imageAbort?.abort();this._imageAbort=new AbortController();
    const controller=this._imageAbort,version=++this._imageVersion;
    const max=Math.min(this.options.maxTextureSize,this.backend.maxTextureSize);
    this.emit('loading',{loading:true});
    try {
      const images=await Promise.all([loadFlowImage(from,max,controller.signal),loadFlowImage(to,max,controller.signal)]);
      if(this.disposed||version!==this._imageVersion)return false;
      this._images=images;
      this.backend.setTexture('uFrom',images[0].canvas);this.backend.setTexture('uTo',images[1].canvas);
      this.progress=0;this.render();this.emit('images',{...this.imageInfo});return true;
    }catch(error){controller.abort();if(error.name==='AbortError'||this.disposed||version!==this._imageVersion)return false;
      this.emit('error',{message:error.message,error});throw error;
    }finally{if(!this.disposed&&version===this._imageVersion)this.emit('loading',{loading:false});}
  }
  configure(changes = {}){
    this._check();const next=validateOptions(changes,this.options);this.pause();
    const seedChanged=next.seed!==this.options.seed;
    const fiberChanged=seedChanged||next.origin.some((v,i)=>v!==this.options.origin[i]);
    this.options=next;
    if(seedChanged)this.backend.setTexture('uNoise',createNoiseAtlas(next.seed),true);
    if(fiberChanged){this._fiberKey='';this._fiberAbort?.abort();}
    this.resize();this.render();this.emit('config',{config:this.toJSON()});return this;
  }
  setPreset(preset){if(!Object.hasOwn(PRESETS,preset))throw new RangeError(`Unknown flow: ${preset}`);return this.configure({...PRESETS[preset],preset});}
  setOrigin(point){return this.configure({origin:validatePoint(point,'origin')});}
  setPath(path){return this.configure({path});}
  async prepare(){
    this._check();
    if(this.options.preset!=='fiber-soak'||this.backend instanceof CanvasBackend)return;
    const aspect=this._aspect||1,key=[this.options.seed,...this.options.origin,aspect.toFixed(2)].join(':');
    if(this._fiberKey===key)return;
    if(this._pendingFiberKey===key&&this._fiberPromise)return this._fiberPromise;
    this._fiberAbort?.abort();const controller=new AbortController();this._fiberAbort=controller;this._pendingFiberKey=key;
    this.emit('preparing',{preparing:true});
    const task=(async()=>{
      const map=await createFiberMap({origin:this.options.origin,seed:this.options.seed,aspect,signal:controller.signal});
      if(this.disposed||controller.signal.aborted)return;
      this.backend.setTexture('uFiber',map);this._fiberKey=key;this.render();
    })();
    this._fiberPromise=task;
    try {await task;}finally{if(this._pendingFiberKey===key){this._pendingFiberKey='';this._fiberPromise=null;if(!this.disposed)this.emit('preparing',{preparing:false});}}
  }
  async play({origin,reverse=false,from}={}){
    this._check();this.pause();
    if(origin)this.setOrigin(origin);
    if(from!==undefined)this.progress=clamp(finite(from,'from'));
    const ticket=++this._intent;
    await this.ready;
    if(this.disposed||ticket!==this._intent)return;
    if(!this._images)throw new Error('Load a first and last image before playback.');
    try{await this.prepare();}catch(error){if(error.name==='AbortError')return;throw error;}
    if(this.disposed||ticket!==this._intent||this._contextLost)return;
    this.direction=reverse?-1:1;
    if(this.direction>0&&this.progress>=1)this.progress=0;
    if(this.direction<0&&this.progress<=0)this.progress=1;
    if(this.options.respectReducedMotion&&this._media.matches){this.progress=reverse?0:1;this.render();this.emit('complete',{progress:this.progress,reducedMotion:true});return;}
    this.playing=true;this._lastTime=performance.now();this.emit('play',{reverse});
    const tick=now=>{
      if(!this.playing||this.disposed||ticket!==this._intent)return;
      // Pausing/visibility resets the clock, so no hidden-tab catch-up is accumulated.
      const delta=now-this._lastTime;this._lastTime=now;
      this.progress=clamp(this.progress+this.direction*delta/this.options.duration);this.render();
      if(this.progress===0&&this.direction<0||this.progress===1&&this.direction>0){this.playing=false;this._raf=0;this.emit('complete',{progress:this.progress});}
      else this._raf=requestAnimationFrame(tick);
    };
    this._raf=requestAnimationFrame(tick);
  }
  pause(){
    if(this.disposed)return this;
    ++this._intent;cancelAnimationFrame(this._raf);this._raf=0;
    const active=this.playing;this.playing=false;if(active)this.emit('pause',{progress:this.progress});return this;
  }
  resume(){return this.play({reverse:this.direction<0});}
  reverse(){return this.play({reverse:true});}
  reset(){return this.seek(0);}
  seek(progress){this._check();this.pause();this.progress=clamp(finite(progress,'progress'));this.render();return this;}
  resize(){
    this._check();
    const rect=this.container.getBoundingClientRect(),w=Math.max(1,rect.width),h=Math.max(1,rect.height);this._aspect=w/h;
    const dpr=Math.min(window.devicePixelRatio||1,this.options.maxDpr,Math.sqrt(this.options.maxPixels/(w*h)));
    const width=Math.max(1,Math.round(w*dpr)),height=Math.max(1,Math.round(h*dpr));
    if(width!==this.canvas.width||height!==this.canvas.height)this.backend.resize(width,height);
    this.render();
  }
  _uniforms(){
    const o=this.options,path=new Float32Array(32),at=new Float32Array(16);let total=0;
    for(let i=0;i<o.path.length;i++){path[i*2]=o.path[i][0];path[i*2+1]=o.path[i][1];if(i>0)total+=Math.hypot((o.path[i][0]-o.path[i-1][0])*this._aspect,o.path[i][1]-o.path[i-1][1]);at[i]=total;}
    for(let i=0;i<at.length;i++)at[i]/=Math.max(total,.0001);
    const bg=o.background.match(/[a-fA-F0-9]{2}/g).map(v=>parseInt(v,16)/255);
    return {uProgress:this.progress,uAspect:this._aspect||1,uImageAspect:this._images.map(i=>i.aspect),uOrigin:o.origin,
      uStrength:o.strength,uFeather:o.feather,uDistortion:o.distortion,uAngle:o.angle,uSeed:o.seed%65536,
      uPreset:PRESETS[o.preset].index,uFit:o.fit==='contain'?0:1,uBackground:bg,uPath:path,uPathAt:at,uPathCount:o.path.length};
  }
  render(){if(this.disposed||!this._images||this._contextLost)return;this.backend.render(this._uniforms());this.emit('progress',{progress:this.progress,playing:this.playing});}
  toJSON(){
    const keys=['preset','duration','strength','feather','distortion','angle','origin','path','seed','fit','background','respectReducedMotion','maxDpr','maxPixels','maxTextureSize'];
    const out={schema:'startrips.reveal-flow/v1',version:FLOW_VERSION};
    for(const key of keys)out[key]=structuredClone(this.options[key]);return out;
  }
  applyConfig(config){if(!config||config.schema!=='startrips.reveal-flow/v1')throw new TypeError('Unsupported flow configuration schema.');return this.configure(config);}
  async snapshot(type='image/png',quality=.95){
    this._check();if(!this._images)throw new Error('Load two images before taking a snapshot.');this.render();
    return new Promise((resolve,reject)=>this.canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Unable to capture the canvas.')),type,quality));
  }
  dispose(){
    if(this.disposed)return;this.pause();this.disposed=true;this._imageVersion++;
    this._imageAbort?.abort();this._fiberAbort?.abort();this._observer.disconnect();
    document.removeEventListener('visibilitychange',this._onHidden);this._media.removeEventListener('change',this._onReduced);
    this.canvas.removeEventListener('webglcontextlost',this._onLost);this.canvas.removeEventListener('webglcontextrestored',this._onRestored);
    this.backend.dispose();this.canvas.remove();this._images=null;
  }
}
export { PRESETS, FLOW_VERSION } from './presets.js';
