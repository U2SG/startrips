/** Decode locally, cap texture size, and validate canvas/CORS accessibility before upload. */
export async function loadFlowImage(source, maxSize = 2048, signal) {
  if (signal?.aborted) throw new DOMException('Image load cancelled.','AbortError');
  let image, temporaryURL;
  if (source instanceof HTMLCanvasElement || (typeof ImageBitmap!=='undefined' && source instanceof ImageBitmap)) image=source;
  else {
    let url = source;
    if (source instanceof Blob) {
      if (source.size > 50*1024*1024) throw new RangeError('The image must be smaller than 50 MB.');
      temporaryURL=URL.createObjectURL(source); url=temporaryURL;
    }
    if (source instanceof HTMLImageElement) image=source;
    else {
      if (typeof url !== 'string' || !url) throw new TypeError('An image URL, File, Blob, canvas, ImageBitmap or image element is required.');
      image = new Image(); image.crossOrigin='anonymous'; image.decoding='async';
    }
    try {
      await new Promise((resolve,reject)=>{
        const clean=()=>{image.removeEventListener('load',ok);image.removeEventListener('error',fail);signal?.removeEventListener('abort',abort);};
        const ok=()=>{clean();resolve();};
        const fail=()=>{clean();reject(new Error('图片读取失败。请使用浏览器可解码的 JPG / PNG / WebP / AVIF，远程 URL 需要允许跨域读取。'));};
        const abort=()=>{clean();reject(new DOMException('Image load cancelled.','AbortError'));};
        image.addEventListener('load',ok);image.addEventListener('error',fail);signal?.addEventListener('abort',abort,{once:true});
        if (!(source instanceof HTMLImageElement)) image.src=url;
        if(image.complete && image.naturalWidth) ok();
        else if (source instanceof HTMLImageElement && image.complete) fail();
      });
      if (typeof image.decode==='function') await image.decode();
    } finally { if(temporaryURL) URL.revokeObjectURL(temporaryURL); }
  }
  if(signal?.aborted) throw new DOMException('Image load cancelled.','AbortError');
  const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
  if(!width||!height) throw new Error('The decoded image has no dimensions.');
  const scale=Math.min(1,maxSize/Math.max(width,height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
  const ctx=canvas.getContext('2d',{willReadFrequently:false});
  if(!ctx) throw new Error('Canvas 2D is unavailable for decoding.');
  ctx.drawImage(image,0,0,canvas.width,canvas.height);
  try {ctx.getImageData(0,0,1,1);} catch {throw new Error('远程图片没有允许 CORS，无法上传到 GPU。请先下载并通过本地文件选择器载入。');}
  return {canvas,width,height,aspect:width/height};
}
