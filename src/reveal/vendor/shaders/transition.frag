precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform sampler2D uNoise;
uniform sampler2D uFiber;
uniform float uProgress;
uniform float uAspect;
uniform vec2 uImageAspect;
uniform vec2 uOrigin;
uniform float uStrength;
uniform float uFeather;
uniform float uDistortion;
uniform float uAngle;
uniform float uSeed;
uniform int uPreset;
uniform int uFit;
uniform vec3 uBackground;
uniform vec2 uPath[16];
uniform float uPathAt[16];
uniform int uPathCount;

vec3 linearize(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
vec3 encode(vec3 c) {
  c=max(c,vec3(0.));
  return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(0.0031308),c));
}
vec2 imageUV(vec2 p,float aspect) {
  vec2 ratio=vec2(uAspect/aspect,aspect/uAspect);
  vec2 scale=uFit==0?max(ratio,vec2(1.)):min(ratio,vec2(1.));
  return (p-.5)*scale+.5;
}
vec3 imageColor(sampler2D tex,vec2 p,float aspect) {
  vec2 q=imageUV(p,aspect);
  if(uFit==0&&(q.x<0.||q.y<0.||q.x>1.||q.y>1.))return linearize(uBackground);
  vec4 c=texture(tex,clamp(q,0.,1.));
  return mix(linearize(uBackground),linearize(c.rgb),c.a);
}
float noise(vec2 p){return texture(uNoise,p/64.).r;}
vec2 noise2(vec2 p){return texture(uNoise,p/64.).gb;}
float fbm(vec2 p){
  float f=0.;
  f+=.5333*noise(p);p=mat2(.8,.6,-.6,.8)*p*2.03+11.7;
  f+=.2667*noise(p);p=p*2.01+17.2;
  f+=.1333*noise(p);p=p*2.04-8.1;
  f+=.0667*noise(p);
  return f;
}
float coverage(float arrival,float t,float width) {return 1.-smoothstep(t-width,t+width,arrival);}
vec2 world(vec2 uv){return uv*vec2(uAspect,1.);}
float furthest(vec2 o){return length(max(o,1.-o)*vec2(uAspect,1.));}
float bloom(vec2 p,float t){
  vec2 q=world(p-uOrigin);
  float d0=length(q);
  vec2 warp=(noise2(q*5.+uSeed*.03)-.5)*.26*uStrength;
  warp+=(noise2(q*15.+32.)-.5)*.075*uStrength;
  q+=warp*smoothstep(.012,.15,d0);
  float d=length(q)/max(furthest(uOrigin),.1);
  float grain=fbm(world(p)*37.+uSeed*.013);
  float lobe=(fbm(world(p)*6.+7.)-.5)*.13*uStrength;
  float arrival=d*.91+lobe+(grain-.5)*.041*uStrength;
  return coverage(arrival,t,uFeather);
}
float ribbon(vec2 p,float t){
  vec2 q=world(p);
  q+=(noise2(q*7.+uSeed*.015)-.5)*.075*uStrength;
  float best=100.,along=0.;
  for(int i=0;i<15;i++){
    if(i>=uPathCount-1)break;
    vec2 a=world(uPath[i]),b=world(uPath[i+1]),ab=b-a;
    float s=clamp(dot(q-a,ab)/max(dot(ab,ab),.00001),0.,1.);
    float d=length(q-a-ab*s);
    if(d<best){best=d;along=mix(uPathAt[i],uPathAt[i+1],s);}
  }
  float pathDelay=along*.36;
  float distanceDelay=pow(best/max(length(vec2(uAspect,1.))*.64,.1),.73)*.75;
  float textureDelay=(fbm(q*28.)-.5)*.065*uStrength;
  return coverage(pathDelay+distanceDelay+textureDelay,t,uFeather);
}
float brush(vec2 p,float t){
  vec2 q=world(p-.5);float a=radians(uAngle);
  q=mat2(cos(a),-sin(a),sin(a),cos(a))*q;
  float span=abs(cos(a))*uAspect+abs(sin(a));
  float rise=abs(sin(a))*uAspect+abs(cos(a));
  q=q/vec2(span,rise)+.5;
  float result=0.;
  for(int i=0;i<8;i++){
    float row=float(i),start=row*.083;
    float sweep=clamp((t-start)/.29,0.,1.);
    float x=mod(row,2.)<.5?q.x:1.-q.x;
    float curve=.03*sin(x*4.4+row*2.1)+.016*sin(x*11.+row);
    float center=(row+.5)/8.+curve;
    float crossDistance=abs(q.y-center);
    float width=.09+.015*sin(x*6.+row);
    float strand=texture(uNoise,vec2(x*3.,q.y*560.+row*17.)/64.).g;
    float torn=(fbm(vec2(x*60.,q.y*16.)+row)-.5)*.025*uStrength;
    float bristleEdge=crossDistance+torn+(strand-.5)*.022*uStrength;
    float strokeBody=1.-smoothstep(width-.012,width+.007,bristleEdge);
    float head=1.-smoothstep(sweep-.017,sweep+.014,x+(strand-.5)*.06*uStrength);
    float onset=smoothstep(0.,.027,t-start);
    float gaps=smoothstep(.055,.2,strand+.28*smoothstep(.3,.83,t));
    result=max(result,strokeBody*head*onset*gaps);
  }
  // A final drying/absorption phase fills remaining bristle gaps without an endpoint pop.
  float finish=coverage(fbm(world(p)*17.)*.15+.86,t,.045);
  return max(result,finish);
}
float fiber(vec2 p,float t){
  vec4 f=texture(uFiber,p);
  float arrival=(f.r*65280.+f.g*255.)/65535.;
  float capillary=(fbm(world(p)*83.)-.5)*.025*uStrength;
  return coverage(arrival+capillary,t,uFeather*.72);
}
float mist(vec2 p,float t){
  vec2 q=world(p);
  vec2 drift=vec2(t*.32,-t*.12)*uStrength;
  vec2 warp=(noise2(q*2.6+drift)-.5)*1.35*uStrength;
  float cloud=fbm(q*3.4+warp+drift);
  float silk=fbm(vec2(q.x*2.2,q.y*9.)+warp*.6-drift*.5);
  float directional=p.x*.19-p.y*.1;
  float arrival=.13+cloud*.63+silk*.2+directional;
  return coverage(arrival,t,max(uFeather,.09));
}
void main(){
  vec3 initial=imageColor(uFrom,vUv,uImageAspect.x);
  // Exact endpoints bypass every mask, pigment and displacement operation.
  if(uProgress<=0.){outColor=vec4(encode(initial),1.);return;}
  if(uProgress>=1.){outColor=vec4(encode(imageColor(uTo,vUv,uImageAspect.y)),1.);return;}
  float p=uProgress;
  float eased=p*p*(3.-2.*p);
  float t=mix(-.16,1.19,eased);
  float m;
  if(uPreset==0)m=bloom(vUv,t);
  else if(uPreset==1)m=ribbon(vUv,t);
  else if(uPreset==2)m=brush(vUv,t);
  else if(uPreset==3)m=fiber(vUv,t);
  else m=mist(vUv,t);
  // End guards guarantee continuous entrance/exit for arbitrary seeds and aspect ratios.
  m*=smoothstep(0.,.06,p);
  m=mix(m,1.,smoothstep(.91,1.,p));
  float edge=4.*m*(1.-m);
  vec2 displacement=(noise2(world(vUv)*9.+p*.25)-.5)*.009*uDistortion*edge;
  vec3 finalColor=imageColor(uTo,vUv+displacement,uImageAspect.y);
  vec3 color=mix(initial,finalColor,m);
  if(uPreset!=4){
    float pigment=(.025+.05*fbm(world(vUv)*45.))*uStrength*edge;
    color*=1.-pigment;
  }
  outColor=vec4(encode(color),1.);
}
