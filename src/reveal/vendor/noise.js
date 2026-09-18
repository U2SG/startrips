/** Seeded, tileable noise atlas. It is generated once, not fetched or AI-generated. */
export function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t=state; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
}
export function createNoiseAtlas(seed, size = 256) {
  const rand = randomGenerator(seed), gridSize = 64, grids = [];
  for(let c=0;c<3;c++) grids.push(Float32Array.from({length:gridSize*gridSize},rand));
  const data = new Uint8Array(size*size*4);
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const gx=x/size*gridSize,gy=y/size*gridSize,ix=Math.floor(gx),iy=Math.floor(gy);
    const tx=gx-ix,ty=gy-iy,fx=tx*tx*(3-2*tx),fy=ty*ty*(3-2*ty);
    for(let c=0;c<3;c++) { const g=grids[c],at=(xx,yy)=>g[((yy+gridSize)%gridSize)*gridSize+(xx+gridSize)%gridSize];
      const a=at(ix,iy)*(1-fx)+at(ix+1,iy)*fx,b=at(ix,iy+1)*(1-fx)+at(ix+1,iy+1)*fx;
      data[(y*size+x)*4+c]=Math.round((a*(1-fy)+b*fy)*255);
    }
    data[(y*size+x)*4+3]=255;
  }
  return {data,width:size,height:size};
}
