import { expect,it,vi,afterEach } from 'vitest';
import { requestIntentModelAnswer } from './intent-model-request';
import { ShareIntentError } from './create-share-intent';
const frame=(delta:object,finish_reason:unknown=null)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`;
const start=frame({tool_calls:[{index:0,type:'function',function:{name:'stage',arguments:'{"text":"'}}]});
const end=frame({tool_calls:[{index:0,function:{arguments:'"}'}}]},'tool_calls')+'data: [DONE]\n\n';
const request={systemPrompt:'test',userContent:'synthetic',schemaName:'test',schema:{},toolName:'stage',providerName:'mock',fail:(c:string,m:string,s?:number)=>new ShareIntentError(c,m,s)};
const encoder=new TextEncoder();
function run(chunks:string[],stream:Parameters<typeof requestIntentModelAnswer>[0]['stream']={},delay=0){
  let cancelled=false;
  const fetcher=vi.fn(async(_url:unknown,_init?:RequestInit)=>new Response(new ReadableStream({async start(c){for(const part of chunks){if(delay)await new Promise(r=>setTimeout(r,delay));if(cancelled)return;c.enqueue(encoder.encode(part));}if(!cancelled)c.close();},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  return {fetcher,result:requestIntentModelAnswer({baseUrl:'https://model.example.test/v1',model:'mock',apiKey:'test',timeoutMs:1,fetcher,stream},request)};
}
afterEach(()=>vi.useRealTimers());
it('consumes real fragmented tool arguments with progress before completion and no legacy total cutoff',async()=>{
  const progress=vi.fn();const {result,fetcher}=run([start,frame({tool_calls:[{index:0,function:{arguments:'虚构'}}]}),end],{onProgress:progress,idleTimeoutMs:100},10);
  await expect(result).resolves.toEqual({text:'虚构'});
  expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string).stream).toBe(true);
  expect(progress.mock.calls.map(c=>c[0].characters)).toEqual([0,9,11,13]);
});
it.each([['missing done',start+end.replace('data: [DONE]\n\n','')],['length',start+frame({},'length')],['second tool',frame({tool_calls:[{index:1,function:{name:'stage',arguments:'{}'}}]},'tool_calls')+'data: [DONE]\n\n'],['invalid JSON',start+'data: nope\n\n']])('rejects %s without returning a partial draft',async(_name,text)=>{await expect(run([text]).result).rejects.toMatchObject({code:'INTENT_STREAM_INVALID'});});
it('idle timeout interrupts a reader that never settles, comments do not extend it',async()=>{
 const fetcher=vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(': ping\n\n'));}}),{headers:{'content-type':'text/event-stream'}}));
 await expect(requestIntentModelAnswer({baseUrl:'https://model.example.test',model:'mock',apiKey:'test',timeoutMs:1,fetcher,stream:{idleTimeoutMs:10}},request)).rejects.toMatchObject({code:'INTENT_IDLE_TIMEOUT'});
});
it('classifies first byte timeout independently',async()=>{
 const fetcher=vi.fn(async()=>new Response(new ReadableStream(),{headers:{'content-type':'text/event-stream'}}));
 await expect(requestIntentModelAnswer({baseUrl:'https://model.example.test',model:'mock',apiKey:'test',timeoutMs:1,fetcher,stream:{firstByteTimeoutMs:10}},request)).rejects.toMatchObject({code:'INTENT_FIRST_BYTE_TIMEOUT'});
});
it('cancels and cleans a stalled body',async()=>{
 const cancel=vi.fn();const controller=new AbortController();
 const fetcher=vi.fn(async()=>new Response(new ReadableStream({cancel}),{headers:{'content-type':'text/event-stream'}}));
 const result=requestIntentModelAnswer({baseUrl:'https://model.example.test',model:'mock',apiKey:'test',timeoutMs:1,fetcher,stream:{signal:controller.signal}},request);
 await new Promise(r=>setTimeout(r,0));controller.abort();await expect(result).rejects.toMatchObject({code:'INTENT_CANCELLED'});expect(cancel).toHaveBeenCalledOnce();
});
it('bounds stalled connection even if an adapter ignores abort',async()=>{
 await expect(requestIntentModelAnswer({baseUrl:'https://model.example.test',model:'mock',apiKey:'test',timeoutMs:1,fetcher:()=>new Promise(()=>{}),stream:{connectTimeoutMs:10}},request)).rejects.toMatchObject({code:'INTENT_CONNECT_TIMEOUT'});
});
it('pre-cancelled work sends nothing',async()=>{
 const controller=new AbortController();controller.abort();const fetcher=vi.fn();
 await expect(requestIntentModelAnswer({baseUrl:'https://model.example.test',model:'mock',apiKey:'test',timeoutMs:1,fetcher,stream:{signal:controller.signal}},request)).rejects.toMatchObject({code:'INTENT_CANCELLED'});expect(fetcher).not.toHaveBeenCalled();
});
it('rejects changed tool-call identity even when its combined JSON is valid',async()=>{
 const first=frame({tool_calls:[{index:0,id:'call-a',function:{name:'stage',arguments:'{"ok":'}}]});
 const second=frame({tool_calls:[{index:0,id:'call-b',function:{arguments:'true}'}}]},'tool_calls');
 await expect(run([first,second,'data: [DONE]\n\n']).result).rejects.toMatchObject({code:'INTENT_STREAM_INVALID'});
});
