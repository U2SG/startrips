import { randomGenerator } from './noise.js';
/**
 * Stochastic anisotropic first-arrival model, not a fluid or paper-physics simulation.
 * A small Dijkstra field is prepared only when origin/seed/aspect changes.
 * The async loop yields to the UI and supports cancellation.
 */
export async function createFiberMap({origin,seed,aspect,signal}) {
  const h=160,w=Math.max(96,Math.min(280,Math.round(h*aspect))),n=w*h;
  const rand=randomGenerator(seed^0x71fa3d),cost=new Float32Array(n),axis=new Float32Array(n),arrival=new Float32Array(n).fill(Infinity);
  const lattice=Float32Array.from({length:32*32},rand);
  const noise=(x,y)=>{x=(x%31+31)%31;y=(y%31+31)%31;const i=x|0,j=y|0,fx=x-i,fy=y-j;
    return (lattice[j*32+i]*(1-fx)+lattice[j*32+i+1]*fx)*(1-fy)+(lattice[(j+1)*32+i]*(1-fx)+lattice[(j+1)*32+i+1]*fx)*fy;};
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {const i=y*w+x;
    const coarse=noise(x/18,y/18),fine=noise(x/3.7+11,y/3.7+7);
    const bend=noise(x/29+5,y/29+13);
    const veins=Math.pow(Math.abs(Math.sin(x*0.37+y*0.13+coarse*11)),0.4);
    cost[i]=0.08+2.7*Math.pow(coarse,2.7)+0.65*fine+veins*0.85;
    axis[i]=(bend*2-1)*Math.PI*1.6;
  }
  const heapIds=[],heapValues=[];
  const push=(id,value)=>{let i=heapIds.length;heapIds.push(id);heapValues.push(value);
    while(i>0){const p=(i-1)>>1;if(heapValues[p]<=value)break;heapIds[i]=heapIds[p];heapValues[i]=heapValues[p];i=p;}heapIds[i]=id;heapValues[i]=value;};
  const pop=()=>{const out=[heapIds[0],heapValues[0]],id=heapIds.pop(),v=heapValues.pop();
    if(heapIds.length){let i=0;while(true){let c=i*2+1;if(c>=heapIds.length)break;if(c+1<heapIds.length&&heapValues[c+1]<heapValues[c])c++;if(heapValues[c]>=v)break;heapIds[i]=heapIds[c];heapValues[i]=heapValues[c];i=c;}heapIds[i]=id;heapValues[i]=v;}return out;};
  const start=Math.min(h-1,Math.floor(origin[1]*h))*w+Math.min(w-1,Math.floor(origin[0]*w));
  arrival[start]=0;push(start,0);
  const steps=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
  let iterations=0,max=0;
  while(heapIds.length) {
    if(signal?.aborted) throw new DOMException('Fibre preparation cancelled.','AbortError');
    const [i,t]=pop();if(t!==arrival[i] && Math.abs(t-arrival[i])>0.0001)continue;
    const x=i%w,y=(i/w)|0;
    for(const [dx,dy] of steps){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;
      const j=yy*w+xx,theta=Math.atan2(dy,dx),dir=(axis[i]+axis[j])*.5;
      const anisotropy=.17+Math.pow(Math.sin(theta-dir),2)*2.8;
      const dt=(cost[i]+cost[j])*.5*anisotropy*Math.hypot(dx,dy);
      const next=Math.fround(t+dt);
      if(next<arrival[j]){arrival[j]=next;push(j,next);}
    }
    if(++iterations%3500===0) await new Promise(r=>setTimeout(r,0));
  }
  for(let i=0;i<n;i++)max=Math.max(max,arrival[i]);
  const data=new Uint8Array(n*4);
  for(let i=0;i<n;i++) {const v=Math.round(Math.pow(arrival[i]/Math.max(max,1),.86)*65535);
    data[i*4]=v>>8;data[i*4+1]=v&255;data[i*4+2]=Math.min(255,Math.round(cost[i]*80));data[i*4+3]=255;}
  return {data,width:w,height:h};
}
