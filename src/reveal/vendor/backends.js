import { FRAGMENT_SHADER, VERTEX_SHADER, THREE_VERTEX_SHADER } from './shaders.js';

const textureKeys=['uFrom','uTo','uNoise','uFiber'];
const scalarFloatKeys=['uProgress','uAspect','uStrength','uFeather','uDistortion','uAngle','uSeed'];
const scalarIntKeys=['uPreset','uFit','uPathCount'];

export class WebGLBackend {
  constructor(canvas) {
    this.canvas=canvas;this.name='WebGL 2 · GPU';
    this.gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
    if(!this.gl)throw new Error('WebGL 2 is unavailable.');
    this.maxTextureSize=this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    this.textures=new Map();this.inputs=new Map();this.initialize();
  }
  initialize(){
    const gl=this.gl;
    const compile=(type,source)=>{const sh=gl.createShader(type);gl.shaderSource(sh,source);gl.compileShader(sh);
      if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(sh);gl.deleteShader(sh);throw new Error(error);}return sh;};
    const vs=compile(gl.VERTEX_SHADER,'#version 300 es\n'+VERTEX_SHADER),fs=compile(gl.FRAGMENT_SHADER,'#version 300 es\n'+FRAGMENT_SHADER);
    this.program=gl.createProgram();gl.attachShader(this.program,vs);gl.attachShader(this.program,fs);gl.linkProgram(this.program);gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(this.program));
    this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
    this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(this.program,'aPosition');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    this.locations=new Map();
    for(const key of [...textureKeys,...scalarFloatKeys,...scalarIntKeys,'uImageAspect','uOrigin','uBackground','uPath[0]','uPathAt[0]'])this.locations.set(key,gl.getUniformLocation(this.program,key));
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    // Input is decoded into an sRGB canvas; conversion is explicit in the shared shader.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
  }
  setTexture(name,input,repeat=false){
    const gl=this.gl;this.inputs.set(name,{input,repeat});
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,repeat?gl.REPEAT:gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,repeat?gl.REPEAT:gl.CLAMP_TO_EDGE);
    if(input.data)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,input.width,input.height,0,gl.RGBA,gl.UNSIGNED_BYTE,input.data);
    else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,input);
    const old=this.textures.get(name);this.textures.set(name,texture);if(old)gl.deleteTexture(old);
  }
  resize(width,height){this.canvas.width=width;this.canvas.height=height;this.gl.viewport(0,0,width,height);}
  render(u){
    const gl=this.gl;if(gl.isContextLost())return;
    gl.useProgram(this.program);gl.bindVertexArray(this.vao);
    for(let i=0;i<textureKeys.length;i++){const key=textureKeys[i];gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,this.textures.get(key));gl.uniform1i(this.locations.get(key),i);}
    for(const key of scalarFloatKeys)gl.uniform1f(this.locations.get(key),u[key]);
    for(const key of scalarIntKeys)gl.uniform1i(this.locations.get(key),u[key]);
    gl.uniform2fv(this.locations.get('uImageAspect'),u.uImageAspect);gl.uniform2fv(this.locations.get('uOrigin'),u.uOrigin);
    gl.uniform3fv(this.locations.get('uBackground'),u.uBackground);
    gl.uniform2fv(this.locations.get('uPath[0]'),u.uPath);gl.uniform1fv(this.locations.get('uPathAt[0]'),u.uPathAt);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  restore(){this.textures.clear();this.initialize();for(const [k,{input,repeat}] of this.inputs)this.setTexture(k,input,repeat);}
  dispose(){const gl=this.gl;for(const t of this.textures.values())gl.deleteTexture(t);gl.deleteBuffer(this.buffer);gl.deleteVertexArray(this.vao);gl.deleteProgram(this.program);this.inputs.clear();this.textures.clear();}
}

/**
 * Pass your application's THREE namespace. No duplicate Three.js bundle is required.
 * RawShaderMaterial has explicit sRGB decode/encode so it uses NoColorSpace input textures.
 */
export class ThreeBackend {
  constructor(canvas,THREE){
    this.canvas=canvas;this.THREE=THREE;this.name='Three.js · GPU';this.inputs=new Map();this.textures=new Map();
    this.renderer=new THREE.WebGLRenderer({canvas,alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
    this.renderer.debug.onShaderError=(gl,program,vertex,fragment)=>{
      throw new Error(['Three.js reveal shader failed:',gl.getProgramInfoLog(program),gl.getShaderInfoLog(vertex),gl.getShaderInfoLog(fragment)].filter(Boolean).join('\n'));
    };
    this.renderer.setPixelRatio(1);this.renderer.toneMapping=THREE.NoToneMapping;
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.maxTextureSize=this.renderer.capabilities.maxTextureSize;
    this.uniforms={};for(const key of [...textureKeys,...scalarFloatKeys,...scalarIntKeys])this.uniforms[key]={value:0};
    this.uniforms.uImageAspect={value:new THREE.Vector2(1,1)};this.uniforms.uOrigin={value:new THREE.Vector2(.5,.5)};
    this.uniforms.uBackground={value:new THREE.Vector3(0,0,0)};
    this.uniforms.uPath={value:Array.from({length:16},()=>new THREE.Vector2())};this.uniforms.uPathAt={value:new Float32Array(16)};
    this.material=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,uniforms:this.uniforms,
      vertexShader:THREE_VERTEX_SHADER,fragmentShader:FRAGMENT_SHADER,depthTest:false,depthWrite:false,toneMapped:false});
    this.geometry=new THREE.PlaneGeometry(2,2);this.mesh=new THREE.Mesh(this.geometry,this.material);this.mesh.frustumCulled=false;
    this.scene=new THREE.Scene();this.scene.add(this.mesh);this.camera=new THREE.Camera();
  }
  setTexture(name,input,repeat=false){
    const T=this.THREE,texture=input.data?new T.DataTexture(input.data,input.width,input.height,T.RGBAFormat,T.UnsignedByteType):new T.Texture(input);
    texture.colorSpace=T.NoColorSpace;texture.flipY=false;texture.generateMipmaps=false;
    texture.minFilter=texture.magFilter=T.LinearFilter;texture.wrapS=texture.wrapT=repeat?T.RepeatWrapping:T.ClampToEdgeWrapping;
    texture.needsUpdate=true;
    const old=this.textures.get(name);this.textures.set(name,texture);this.inputs.set(name,{input,repeat});this.uniforms[name].value=texture;old?.dispose();
  }
  resize(width,height){this.renderer.setSize(width,height,false);}
  render(u){
    for(const key of [...scalarFloatKeys,...scalarIntKeys])this.uniforms[key].value=u[key];
    this.uniforms.uImageAspect.value.fromArray(u.uImageAspect);this.uniforms.uOrigin.value.fromArray(u.uOrigin);this.uniforms.uBackground.value.fromArray(u.uBackground);
    for(let i=0;i<16;i++)this.uniforms.uPath.value[i].fromArray(u.uPath,i*2);this.uniforms.uPathAt.value.set(u.uPathAt);
    this.renderer.render(this.scene,this.camera);
  }
  restore(){for(const texture of this.textures.values())texture.needsUpdate=true;}
  dispose(){for(const t of this.textures.values())t.dispose();this.material.dispose();this.geometry.dispose();this.renderer.dispose();this.inputs.clear();this.textures.clear();}
}

/** Explicit fallback, not falsely advertised as the selected shader effect. */
export class CanvasBackend {
  constructor(canvas){this.canvas=canvas;this.name='Canvas 2D · 淡入降级';this.maxTextureSize=2048;this.ctx=canvas.getContext('2d',{alpha:false});this.layer=document.createElement('canvas');this.layerCtx=this.layer.getContext('2d',{alpha:false});this.inputs=new Map();if(!this.ctx)throw new Error('Canvas is unavailable.');}
  setTexture(name,input){this.inputs.set(name,input);}
  resize(w,h){this.canvas.width=w;this.canvas.height=h;}
  render(u){
    const c=this.ctx,w=this.canvas.width,h=this.canvas.height;
    const bg=`rgb(${u.uBackground.map(v=>Math.round(v*255)).join(',')})`;
    const paint=(ctx,image)=>{ctx.globalAlpha=1;ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);if(!image)return;
      const factor=u.uFit===0?Math.min(w/image.width,h/image.height):Math.max(w/image.width,h/image.height);
      const iw=image.width*factor,ih=image.height*factor;ctx.drawImage(image,(w-iw)/2,(h-ih)/2,iw,ih);};
    paint(c,this.inputs.get('uFrom'));
    if(this.layer.width!==w||this.layer.height!==h){this.layer.width=w;this.layer.height=h;}
    paint(this.layerCtx,this.inputs.get('uTo'));
    c.globalAlpha=u.uProgress;c.drawImage(this.layer,0,0);c.globalAlpha=1;
  }
  restore(){}
  dispose(){this.inputs.clear();}
}
