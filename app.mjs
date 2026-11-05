import {importAccessKey,rememberedKey,rememberKey,forgetPageKeys} from './device-auth.mjs';
import {createPartsController} from './parts-controller.mjs';
const $=s=>document.querySelector(s),status=$('#status'),viewer=$('#viewer'),revisionViewer=$('#revision-viewer');
let key=null,catalog=null,base=null,epoch=0,selection=0,active=-1,controller=null;
const cache=new Map(),plainCache=new Map(),pendingModels=new Map(),encoder=new TextEncoder();
let mainIndex=-1,revisionIndex=-1,revisionRequest=0,revisionLoading=-1;
let motionFrame=0,motionConfig=null,loadingIndex=-1,motionSequence=0,mechanismSequence=0,mechanismIndex=0;
const pageIdentity=new URL('.',location.href).href,lockFlag='cad-preview-locked:'+pageIdentity;
const partsUI=createPartsController({viewer,partViewer:$('#part-viewer'),revisionViewer,stopMotion,tell,onModeChange:mode=>{
  if(!catalog)return;
  if(mode==='revision')selectRevision(Number($('#revision-select').value));
  else if(mode==='assembly'&&document.documentElement.dataset.loaded!==String(mainIndex))selectModel(mainIndex);
  updateMotionUI();
}});
const travelSeconds=()=>Number($('#motion-duration').value)||1;
function stopMotion(){cancelAnimationFrame(motionFrame);motionFrame=0;viewer.pause?.();$('#motion-play').textContent='往返播放';}
function seekMotion(time){
  // This installed viewer resets mixer time when seeking a stopped action.
  // Activate the documented animation API before seeking, then hold the pose.
  viewer.timeScale=1;viewer.play({repetitions:1,pingpong:false});viewer.currentTime=time;viewer.pause();
}
function showMotionProgress(){
  const fraction=viewer.duration>0?Math.max(0,Math.min(1,viewer.currentTime/viewer.duration)):0;
  $('#motion-progress').value=String(Math.round(fraction*1000));
  const motion=motionConfig;
  if(motion?.samples){
    const angle=fraction*motion.angleMaxDeg,rows=motion.samples;let i=0;while(i+1<rows.length-1&&angle>rows[i+1].angleDeg)i++;
    const a=rows[i],b=rows[i+1],f=Math.max(0,Math.min(1,(angle-a.angleDeg)/(b.angleDeg-a.angleDeg)));
    const lift=a.pinionLiftMm+(b.pinionLiftMm-a.pinionLiftMm)*f;
    $('#motion-status').textContent=(motion.driveLabel||'驱动角度')+' '+angle.toFixed(1)+'° · '+(motion.drivenLabel||'联动位移')+' '+lift.toFixed(3)+' mm';
  }else $('#motion-status').textContent='进度 '+(fraction*100).toFixed(0)+'%';
}
async function selectMotion(index){
  const run=epoch,request=selection,motionRequest=++motionSequence,entry=catalog.models[active],names=viewer.availableAnimations;
  stopMotion();const name=names[index];motionConfig=entry.motions?.find(m=>m.animationName===name)||(index===0?entry.motion:null);
  viewer.animationCrossfadeDuration=0;viewer.animationName=name;await viewer.updateComplete;if(run!==epoch||request!==selection||motionRequest!==motionSequence)return;seekMotion(0);
  $('#motion-low').textContent=motionConfig?.startLabel||'起点';$('#motion-high').textContent=motionConfig?.endLabel||'终点';$('label[for="motion-progress"]').textContent=motionConfig?.progressLabel||'运动进度';showMotionProgress();
}
function mechanisms(){return catalog?.ui?.mechanisms?.filter(g=>g.modelIndex===active)||[];}
function updateMotionUI(){
  const groups=mechanisms(),g=groups[mechanismIndex],ready=Boolean(g?.animationName&&viewer.availableAnimations?.includes(g.animationName));
  $('#motion').hidden=!partsUI.isAssembly()||!groups.length;$('#motion-controls').hidden=!ready;
  $('#mechanism-note').textContent=g?.note||'';
}
async function selectMechanism(index){
  const run=epoch,request=++mechanismSequence,g=mechanisms()[index];if(!g)return;
  mechanismIndex=index;stopMotion();
  const clip=viewer.availableAnimations.indexOf(g.animationName);
  // Every clip contains rest transforms for unused targets, so seeking its start resets the complete assembly.
  if(viewer.availableAnimations.length)await selectMotion(clip<0?0:clip);
  if(run!==epoch||request!==mechanismSequence)return;
  await partsUI.setScope(g.partIds);if(run!==epoch||request!==mechanismSequence)return;
  for(const [i,b]of [...$('#motion-modes').children].entries()){b.classList.toggle('active',i===index);b.setAttribute('aria-pressed',String(i===index));}
  updateMotionUI();document.documentElement.dataset.mechanism=g.id;
}
function configureMotion(){
  stopMotion();mechanismIndex=0;$('#motion-modes').replaceChildren();$('#motion-modes').hidden=false;
  for(const [i,g]of mechanisms().entries()){const b=document.createElement('button');b.type='button';b.textContent=g.label;b.onclick=()=>selectMechanism(i).catch(e=>tell('联动切换失败：'+e.message,true));$('#motion-modes').append(b);}
  updateMotionUI();
}
function moveTo(fraction){
  if(!viewer.duration)return;stopMotion();const start=viewer.currentTime,target=Math.min(Math.max(0,viewer.duration-1e-6),viewer.duration*fraction),began=performance.now(),run=epoch;
  const travelMs=Math.max(1,travelSeconds()*1000*Math.abs(target-start)/viewer.duration);
  const frame=now=>{if(run!==epoch)return;const t=Math.min(1,(now-began)/travelMs);seekMotion(start+(target-start)*t);showMotionProgress();if(t<1)motionFrame=requestAnimationFrame(frame);};
  motionFrame=requestAnimationFrame(frame);
}
function tell(message,error=false){status.textContent=message;status.classList.toggle('error',error);}
function assert(ok){if(!ok)throw Error('预览包格式或完整性不正确');}
function urlAt(value,parent){
  const u=new URL(value,parent);
  const same=u.origin===location.origin,github=u.hostname==='raw.githubusercontent.com'||u.hostname.endsWith('.github.io');
  assert(!u.username&&!u.password&&!u.hash&&!u.search&&(same||(u.protocol==='https:'&&github)));
  assert(u.protocol==='https:'||(same&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)));
  return u;
}
function hex(buffer){return [...new Uint8Array(buffer)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function bytes(url,limit,signal,progress){
  const r=await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer',cache:url.pathname.endsWith('.enc')?'force-cache':'no-store'});
  if(!r.ok)throw Error('下载失败（HTTP '+r.status+'），请稍后重试');
  if(!r.body){const b=await r.arrayBuffer();assert(b.byteLength<=limit);return b;}
  const reader=r.body.getReader(),parts=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('预览包超过本页大小限制');}parts.push(value);progress?.(size);}
  const result=new Uint8Array(size);let offset=0;for(const p of parts){result.set(p,offset);offset+=p.length;}return result.buffer;
}
async function json(url,limit,signal){return JSON.parse(new TextDecoder().decode(await bytes(url,limit,signal)));}
function descriptor(d){assert(d&&/^data\/[a-f0-9]{64}\.enc$/.test(d.path)&&/^[a-f0-9]{64}$/.test(d.sha256)&&d.path==='data/'+d.sha256+'.enc'&&Number.isSafeInteger(d.bytes)&&d.bytes>=32&&d.bytes<=64*1024*1024+32);}
async function decrypt(d,aad,k,parent,signal,progress){
  descriptor(d);const b=await bytes(urlAt(d.path,parent),d.bytes,signal,progress);assert(b.byteLength===d.bytes&&hex(await crypto.subtle.digest('SHA-256',b))===d.sha256);
  const a=new Uint8Array(b);assert(new TextDecoder().decode(a.slice(0,4))==='RPV1');
  return crypto.subtle.decrypt({name:'AES-GCM',iv:a.slice(4,16),additionalData:encoder.encode(aad),tagLength:128},k,a.slice(16));
}
let viewerReady;
const assetCache=new Map();
async function segmentedGlb(entry,k,parent,signal,progress){
  let received=0;
  async function asset(d){
    if(assetCache.has(d.sha256))return assetCache.get(d.sha256);
    const data=await decrypt(d,d.aad,k,parent,signal);
    assert(data.byteLength===d.plainBytes&&hex(await crypto.subtle.digest('SHA-256',data))===d.plainSha256);
    if(signal.aborted)throw new DOMException('Preview locked or switched','AbortError');
    assetCache.set(d.sha256,data);received+=d.bytes;progress?.(received);return data;
  }
  const layout=await asset(entry.layout),segments=new Array(entry.segments.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,entry.segments.length)},async()=>{while(cursor<entry.segments.length){const i=cursor++;segments[i]=await asset(entry.segments[i]);}}));
  assert(!signal.aborted);const size=segments.reduce((n,b)=>n+b.byteLength,0),out=new Uint8Array(28+layout.byteLength+size),h=new DataView(out.buffer);
  h.setUint32(0,0x46546c67,true);h.setUint32(4,2,true);h.setUint32(8,out.length,true);h.setUint32(12,layout.byteLength,true);h.setUint32(16,0x4e4f534a,true);out.set(new Uint8Array(layout),20);
  h.setUint32(20+layout.byteLength,size,true);h.setUint32(24+layout.byteLength,0x004e4942,true);let offset=28+layout.byteLength;
  for(const b of segments){out.set(new Uint8Array(b),offset);offset+=b.byteLength;}return out.buffer;
}
function prepareViewer(){
  if(!viewerReady){window.ModelViewerElement={meshoptDecoderLocation:new URL('./meshopt_decoder.js',import.meta.url).href};viewerReady=import('./model-viewer.min.js').then(()=>customElements.whenDefined('model-viewer'));}
  return viewerReady;
}
function clearState(){
  stopMotion();partsUI.reset(true);plainCache.clear();assetCache.clear();pendingModels.clear();$('#motion').hidden=true;
  epoch++;selection++;controller?.abort();controller=null;key=null;catalog=null;base=null;active=-1;loadingIndex=-1;motionConfig=null;
  mainIndex=-1;revisionIndex=-1;revisionLoading=-1;revisionRequest++;revisionViewer.removeAttribute('src');delete revisionViewer.dataset.loaded;$('#revision-select').replaceChildren();$('#revision-retry').hidden=true;
  viewer.removeAttribute('src');for(const url of cache.values())URL.revokeObjectURL(url);cache.clear();
  $('#preview').hidden=true;$('#gate').hidden=false;$('#access-key').value='';$('#title').textContent='模型预览';$('#note').textContent='输入单独收到的访问密钥，解锁本次预览。';
  delete document.documentElement.dataset.loaded;delete document.documentElement.dataset.error;
}
async function modelUrl(index,run,progress){
  if(cache.has(index))return cache.get(index);
  if(pendingModels.has(index))return pendingModels.get(index);
  const entry=catalog.models[index],k=key,parent=base,signal=controller.signal;
  const task=(async()=>{
    const data=entry.transport==='segmented-glb-v2'?await segmentedGlb(entry,k,parent,signal,progress):await decrypt(entry,entry.aad,k,parent,signal,progress);
    assert(data.byteLength===entry.plainBytes&&hex(await crypto.subtle.digest('SHA-256',data))===entry.plainSha256);
    assert(new DataView(data).getUint32(0,true)===0x46546c67);
    if(run!==epoch)return null;
    plainCache.set(index,data);const url=URL.createObjectURL(new Blob([data],{type:'model/gltf-binary'}));cache.set(index,url);return url;
  })();
  pendingModels.set(index,task);
  try{return await task;}finally{if(pendingModels.get(index)===task)pendingModels.delete(index);}
}
async function selectRevision(index){
  if(!catalog?.ui.revisionModelIndices.includes(index))return;
  const entry=catalog.models[index];
  if(index===revisionLoading){if(partsUI.isRevision())tell('正在加载'+entry.label+'…');return;}
  if(index===revisionIndex&&revisionViewer.loaded&&revisionViewer.src===cache.get(index)){if(partsUI.isRevision())tell(entry.label+'已加载，可旋转查看');return;}
  const run=epoch,request=++revisionRequest;revisionIndex=index;revisionLoading=index;
  revisionViewer.removeAttribute('src');delete revisionViewer.dataset.loaded;$('#revision-retry').hidden=true;
  const report=message=>{if(run===epoch&&request===revisionRequest&&partsUI.isRevision())tell(message);};
  report('正在加载'+entry.label+'…');
  try{
    await prepareViewer();await revisionViewer.updateComplete;if(run!==epoch||request!==revisionRequest)return;
    const url=await modelUrl(index,run,n=>report('正在下载'+entry.label+'：'+(n/1048576).toFixed(2)+' MB'));
    if(run!==epoch||request!==revisionRequest)return;
    revisionViewer.cameraOrbit='35deg 65deg auto';revisionViewer.cameraTarget='auto auto auto';revisionViewer.alt=entry.label;revisionViewer.src=url;
    report('解密完成，正在显示'+entry.label+'…');
  }catch(e){if(run===epoch&&request===revisionRequest){revisionLoading=-1;$('#revision-retry').hidden=false;if(partsUI.isRevision())tell(e.name==='OperationError'?'修订模型解密失败，文件可能已损坏':e.message,true);}}
}
async function selectModel(index){
  if(index===loadingIndex)return;
  if(index===active&&document.documentElement.dataset.loaded===String(index)&&viewer.src===cache.get(index)){
    $('#motion').hidden=!partsUI.isAssembly()||!(viewer.availableAnimations?.length);if(partsUI.isAssembly())tell(catalog.models[index].label+'已加载，可旋转查看');return;
  }
  const run=epoch,request=++selection,entry=catalog.models[index];active=index;
  loadingIndex=index;
  stopMotion();partsUI.reset();$('#motion').hidden=true;viewer.removeAttribute('src');
  delete document.documentElement.dataset.loaded;delete document.documentElement.dataset.error;
  if(partsUI.isAssembly())tell('正在加载'+entry.label+'…');
  try{
    await prepareViewer();await viewer.updateComplete;if(run!==epoch||request!==selection)return;
    const objectUrl=await modelUrl(index,run,n=>{if(run===epoch&&request===selection&&partsUI.isAssembly())tell('正在下载'+entry.label+'：'+(n/1048576).toFixed(2)+' MB');});
    if(run!==epoch||request!==selection)return;if(partsUI.isAssembly())tell('解密完成，正在显示'+entry.label+'…');viewer.src=objectUrl;
  }catch(e){if(run===epoch&&request===selection){loadingIndex=-1;tell(e.name==='OperationError'?'模型解密失败，文件可能已损坏或密钥不匹配':e.message,true);document.documentElement.dataset.error='true';}}
}
async function getPackage(){
    const source=await json(new URL('./source.json',location.href),4096),manifestUrl=urlAt(source.manifest,location.href);
    const manifest=await json(manifestUrl,16384);assert(manifest.version===1&&/^[a-f0-9]{32}$/.test(manifest.packageId));
    return {manifest,manifestUrl,scope:manifestUrl.href+'#'+manifest.packageId};
}
async function openPackage(candidate,pkg,run,save){
    const {manifest,manifestUrl}=pkg,signal=controller.signal;
    const plain=await decrypt(manifest.catalog,'rp1:'+manifest.packageId+':catalog',candidate,manifestUrl,signal);
    const unlocked=JSON.parse(new TextDecoder().decode(plain));
    assert(unlocked.version===1&&unlocked.packageId===manifest.packageId&&typeof unlocked.title==='string'&&typeof unlocked.note==='string'&&Array.isArray(unlocked.models)&&unlocked.models.length>0&&unlocked.models.length<=20);
    for(const [i,m]of unlocked.models.entries()){
      assert(typeof m.label==='string'&&m.aad==='rp1:'+manifest.packageId+':model:'+i&&/^[a-f0-9]{64}$/.test(m.plainSha256)&&Number.isSafeInteger(m.plainBytes)&&m.plainBytes>=20&&m.plainBytes<=64*1024*1024);
      if(m.transport==='segmented-glb-v2'){
        assert(Array.isArray(m.segments)&&m.segments.length>0&&m.segments.length<=500);
        for(const d of [m.layout,...m.segments]){descriptor(d);assert(/^[a-f0-9]{64}$/.test(d.plainSha256)&&d.aad==='rp2:'+manifest.packageId+':asset:'+d.plainSha256&&Number.isSafeInteger(d.plainBytes)&&d.plainBytes>0&&d.bytes===d.plainBytes+32);}
        assert(m.layout.plainBytes%4===0&&28+m.layout.plainBytes+m.segments.reduce((n,d)=>n+d.plainBytes,0)===m.plainBytes);
      }else{assert(!m.transport);descriptor(m);}
    }
    const ui=unlocked.ui,indices=ui?.revisionModelIndices;
    assert(Number.isInteger(ui?.mainModelIndex)&&ui.mainModelIndex>=0&&ui.mainModelIndex<unlocked.models.length&&Array.isArray(indices)&&new Set(indices).size===indices.length&&indices.every(i=>Number.isInteger(i)&&i>=0&&i<unlocked.models.length&&i!==ui.mainModelIndex));
    assert(indices.length+1===unlocked.models.length);
    if(run!==epoch)return;key=candidate;catalog=unlocked;base=manifestUrl;mainIndex=ui.mainModelIndex;
    $('#title').textContent=catalog.title;$('#note').textContent=catalog.note;
    for(const i of indices){const option=document.createElement('option');option.value=String(i);option.textContent=catalog.models[i].label;$('#revision-select').append(option);}
    $('#mode-revision').disabled=!indices.length;$('#view-modes').hidden=false;
    $('#gate').hidden=true;$('#preview').hidden=false;
    if(save)try{await rememberKey(pkg.scope,pageIdentity,candidate);$('#forget-device').hidden=false;$('#device-status').textContent='已记住此设备；下次打开本页会自动解锁。';}catch{$('#device-status').textContent='此浏览器无法保存登录，本次仍可正常预览。';}
    try{sessionStorage.removeItem(lockFlag);}catch{}
    if(run===epoch)partsUI.setMode('assembly');
}
async function unlock(value,save,fromDevice=false){
  if(!globalThis.isSecureContext||!crypto.subtle){tell('请通过 HTTPS 或本机 localhost 打开预览',true);return;}
  clearState();const run=epoch;controller=new AbortController();$('#unlock').disabled=true;tell(fromDevice?'正在使用此设备的登录记录…':'正在验证访问密码…');
  try{const pkg=await getPackage(),candidate=fromDevice?value:await importAccessKey(value,pkg.manifest);await openPackage(candidate,pkg,run,save);}
  catch(e){if(run===epoch){clearState();tell(e.name==='OperationError'?'访问密码或密钥不正确，或预览包已被修改':e.message,true);document.documentElement.dataset.error='true';}}
  finally{$('#unlock').disabled=false;}
}
$('#unlock-form').addEventListener('submit',async e=>{
  e.preventDefault();if($('#unlock').disabled)return;const value=$('#access-key').value;$('#access-key').value='';if(!value)return;await unlock(value,$('#remember-device').checked);
});
$('#lock').addEventListener('click',()=>{try{sessionStorage.setItem(lockFlag,'1');}catch{}clearState();tell('预览已锁定');$('#access-key').focus();});
$('#forget-device').addEventListener('click',async()=>{
  $('#forget-device').disabled=true;try{await forgetPageKeys(pageIdentity);try{sessionStorage.setItem(lockFlag,'1');}catch{}clearState();$('#remember-device').checked=false;$('#forget-device').hidden=true;$('#device-status').textContent='';tell('已忘记此设备，下次需要重新输入访问密码。');}catch(e){tell(e.message,true);}finally{$('#forget-device').disabled=false;}
});
$('#reset').addEventListener('click',()=>{const target=partsUI.activeViewer();target.cameraOrbit='35deg 65deg auto';target.cameraTarget='auto auto auto';target.jumpCameraToGoal();});
$('#motion-low').addEventListener('click',()=>moveTo(0));$('#motion-high').addEventListener('click',()=>moveTo(1));
$('#motion-progress').addEventListener('input',()=>{stopMotion();seekMotion(Math.min(Math.max(0,viewer.duration-1e-6),viewer.duration*Number($('#motion-progress').value)/1000));showMotionProgress();});
$('#motion-play').addEventListener('click',()=>{
  if(!viewer.paused){stopMotion();return;}stopMotion();viewer.timeScale=viewer.duration/travelSeconds();viewer.play({repetitions:Infinity,pingpong:true});$('#motion-play').textContent='暂停';
  const run=epoch,frame=()=>{if(run!==epoch)return;showMotionProgress();if(!viewer.paused)motionFrame=requestAnimationFrame(frame);};motionFrame=requestAnimationFrame(frame);
});
$('#motion-duration').addEventListener('change',()=>{if(viewer.paused)stopMotion();viewer.timeScale=viewer.duration/travelSeconds();});
$('#revision-select').addEventListener('change',()=>selectRevision(Number($('#revision-select').value)));
$('#revision-retry').addEventListener('click',()=>selectRevision(Number($('#revision-select').value)));
revisionViewer.addEventListener('load',()=>{if(catalog&&cache.get(revisionIndex)===revisionViewer.src){revisionLoading=-1;revisionViewer.dataset.loaded=String(revisionIndex);if(partsUI.isRevision())tell(catalog.models[revisionIndex].label+'已加载，可旋转查看');}});
revisionViewer.addEventListener('error',()=>{if(catalog){revisionLoading=-1;$('#revision-retry').hidden=false;if(partsUI.isRevision())tell('修订模型显示失败，请重新加载',true);}});
viewer.addEventListener('load',async()=>{
  const run=epoch,request=selection;if(!catalog||cache.get(active)!==viewer.src)return;
  try{
    await configureMotion();if(run!==epoch||request!==selection||!catalog)return;
    await partsUI.configure(catalog.models[active],plainCache.get(active));if(run!==epoch||request!==selection||!catalog)return;
    await selectMechanism(0);if(run!==epoch||request!==selection||!catalog)return;
    loadingIndex=-1;if(partsUI.isAssembly())tell(catalog.models[active].label+'已加载，可旋转查看');document.documentElement.dataset.loaded=String(active);
  }catch(e){if(run===epoch&&request===selection){loadingIndex=-1;document.documentElement.dataset.error='true';if(partsUI.isAssembly())tell('装配显示初始化失败：'+e.message,true);}}
});
viewer.addEventListener('error',()=>{if(catalog){loadingIndex=-1;if(partsUI.isAssembly())tell('装配体显示失败，点击“装配体”可重试',true);document.documentElement.dataset.error='true';}});
window.addEventListener('pagehide',clearState);
async function restoreDevice(){
  $('#unlock').disabled=true;
  try{const pkg=await getPackage(),saved=await rememberedKey(pkg.scope);if(saved){$('#forget-device').hidden=false;$('#remember-device').checked=true;$('#device-status').textContent='此设备已保存登录记录。';let locked=false;try{locked=sessionStorage.getItem(lockFlag)==='1';}catch{}if(!locked)await unlock(saved,false,true);}}
  catch{}finally{$('#unlock').disabled=false;document.documentElement.dataset.authReady='true';}
}
restoreDevice();
