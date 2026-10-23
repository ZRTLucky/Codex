import {importAccessKey,rememberedKey,rememberKey,forgetPageKeys} from './device-auth.mjs';
import {createPartsController,EXPLODE} from './parts-controller.mjs';
const $=s=>document.querySelector(s),status=$('#status'),viewer=$('#viewer');
let key=null,catalog=null,base=null,epoch=0,selection=0,active=-1,controller=null;
const cache=new Map(),plainCache=new Map(),encoder=new TextEncoder();
let motionFrame=0,motionConfig=null,loadingIndex=-1,motionSequence=0;
let mechanismId=null,pendingMechanism=null,motionEnabled=false;
const pageIdentity=new URL('.',location.href).href,lockFlag='cad-preview-locked:'+pageIdentity;
const partsUI=createPartsController({viewer,partViewer:$('#part-viewer'),stopMotion,tell,onAutoPlay:playMotion,onChange:updateMotionUI});
const travelSeconds=()=>Number($('#motion-duration').value)||1;
function stopMotion(){cancelAnimationFrame(motionFrame);motionFrame=0;viewer.pause?.();$('#part-viewer').pause?.();$('#part-viewer').autoRotate=false;}
function updateMotionUI(){const target=partsUI.activeViewer(),explodeAuto=partsUI.presentation()==='autoplay'&&target.animationName===EXPLODE,ready=Boolean(target.duration&&(motionEnabled&&target.animationName===motionConfig?.animationName||explodeAuto)),hasPanel=Boolean(catalog?.ui?.mechanisms.some(g=>g.modelIndex===active));$('#motion').hidden=partsUI.isSingle()||partsUI.presentation()==='explode'||(!hasPanel&&!ready);$('#mechanism-picker').hidden=partsUI.isSingle()||!hasPanel;$('#motion-trigger').disabled=!ready;$('#motion-reset').disabled=!ready;$('.motion-settings').hidden=!ready;$('#motion-progress').hidden=!ready;$('#motion-status').hidden=!ready;$('label[for="motion-progress"]').hidden=!ready;}
function moveLinkageTo(fraction){stopMotion();const target=partsUI.activeViewer();if(!target.duration)return;const start=target.currentTime,end=Math.min(Math.max(0,target.duration-1e-6),target.duration*fraction),began=performance.now(),run=epoch,model=selection,ms=Math.max(1,travelSeconds()*1000*Math.abs(end-start)/target.duration);const frame=now=>{if(run!==epoch||model!==selection)return;const f=Math.min(1,(now-began)/ms);seekMotion(start+(end-start)*f);showMotionProgress();if(f<1)motionFrame=requestAnimationFrame(frame);};motionFrame=requestAnimationFrame(frame);}
function playMotion(){stopMotion();const target=partsUI.activeViewer();if(!target.duration)return;target.timeScale=target.duration/travelSeconds();target.play({repetitions:Infinity,pingpong:true});const run=epoch,frame=()=>{if(run!==epoch)return;showMotionProgress();if(!target.paused){if(target.animationName!==EXPLODE)partsUI.sync(target.currentTime);motionFrame=requestAnimationFrame(frame);}};motionFrame=requestAnimationFrame(frame);updateMotionUI();}
function seekMotion(time){
  // This installed viewer resets mixer time when seeking a stopped action.
  // Activate the documented animation API before seeking, then hold the pose.
  const target=partsUI.activeViewer();target.timeScale=1;target.play({repetitions:1,pingpong:false});target.currentTime=time;target.pause();if(target.animationName!==EXPLODE)partsUI.sync(time);
}
function showMotionProgress(){
  const target=partsUI.activeViewer(),fraction=target.duration>0?Math.max(0,Math.min(1,target.currentTime/target.duration)):0;
  $('#motion-progress').value=String(Math.round(fraction*1000));
  const motion=motionEnabled&&target.animationName!==EXPLODE?motionConfig:null;
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
  viewer.animationCrossfadeDuration=0;viewer.animationName=name;await viewer.updateComplete;if(run!==epoch||request!==selection||motionRequest!==motionSequence)return;viewer.play({repetitions:1});viewer.currentTime=0;viewer.pause();partsUI.setMotion(motionEnabled?name:null);
  for(const [i,b]of [...$('#motion-modes').children].entries())b.classList.toggle('active',i===index);
  $('label[for="motion-progress"]').textContent=motionConfig?.progressLabel||'运动进度';showMotionProgress();updateMotionUI();
}
function configureMotion(){
  stopMotion();const available=viewer.availableAnimations||[];$('#motion').hidden=true;if(!available.length){motionConfig=null;return;}
  $('#motion-modes').replaceChildren();$('#motion-modes').hidden=available.length<2;
  for(const [i,name]of available.entries()){const b=document.createElement('button');b.type='button';b.textContent=catalog.models[active].motions?.find(m=>m.animationName===name)?.label||name;b.onclick=()=>selectMotion(i);$('#motion-modes').append(b);}
  return selectMotion(0);
}
function renderMechanisms(){const box=$('#mechanisms');box.replaceChildren();const groups=catalog?.ui?.mechanisms||[];$('#mechanism-picker').hidden=!groups.some(g=>g.modelIndex===active);for(const g of groups){const b=document.createElement('button');b.type='button';b.textContent=g.label;b.dataset.mechanism=g.id;b.setAttribute('aria-pressed',String(g.id===mechanismId));b.onclick=async()=>{pendingMechanism=g;motionEnabled=false;stopMotion();if(active===g.modelIndex&&document.documentElement.dataset.loaded===String(active))await applyMechanism(g);else await selectModel(g.modelIndex);};box.append(b);}const current=groups.find(g=>g.id===mechanismId);$('#mechanism-current').textContent=current?.label||'请选择联动';$('#linkage-note').textContent=current&&!motionEnabled?'此联动尚未配置动画。':'';}
async function applyMechanism(g){pendingMechanism=null;stopMotion();mechanismId=g?.id||null;motionEnabled=Boolean(g?.enabled!==false&&g?.animationName&&viewer.availableAnimations.includes(g.animationName));partsUI.setScope(null,g?.label);if(motionEnabled)await selectMotion(viewer.availableAnimations.indexOf(g.animationName));else partsUI.setMotion(null);renderMechanisms();updateMotionUI();if(g)tell(motionEnabled?g.label+'已激活，点击联动或复位':g.label+'已选择，动画待配置');}
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
function prepareViewer(){
  if(!viewerReady){window.ModelViewerElement={meshoptDecoderLocation:new URL('./meshopt_decoder.js',import.meta.url).href};viewerReady=import('./model-viewer.min.js').then(()=>customElements.whenDefined('model-viewer'));}
  return viewerReady;
}
function clearState(){
  stopMotion();partsUI.reset(true);plainCache.clear();$('#motion').hidden=true;
  epoch++;selection++;controller?.abort();controller=null;key=null;catalog=null;base=null;active=-1;loadingIndex=-1;motionConfig=null;mechanismId=null;pendingMechanism=null;motionEnabled=false;
  viewer.removeAttribute('src');for(const url of cache.values())URL.revokeObjectURL(url);cache.clear();
  $('#preview').hidden=true;$('#gate').hidden=false;$('#access-key').value='';$('#title').textContent='模型预览';$('#note').textContent='输入单独收到的访问密钥，解锁本次预览。';
  $('#mechanisms').replaceChildren();for(const d of document.querySelectorAll('details'))d.open=false;
  delete document.documentElement.dataset.loaded;delete document.documentElement.dataset.error;
}
async function selectModel(index){
  if(index===loadingIndex)return;
  if(index===active&&document.documentElement.dataset.loaded===String(index)&&viewer.src===cache.get(index)){
    updateMotionUI();tell(catalog.models[index].label+'已加载，可旋转查看');return;
  }
  const run=epoch,request=++selection,entry=catalog.models[index],k=key,parent=base,signal=controller.signal;active=index;
  loadingIndex=index;
  stopMotion();partsUI.reset();$('#motion').hidden=true;viewer.removeAttribute('src');
  delete document.documentElement.dataset.loaded;delete document.documentElement.dataset.error;
  tell('正在加载'+entry.label+'…');
  try{
    await prepareViewer();await viewer.updateComplete;if(run!==epoch||request!==selection)return;
    let objectUrl=cache.get(index);
    if(!objectUrl){
      const data=await decrypt(entry,entry.aad,k,parent,signal,n=>{if(run===epoch&&request===selection)tell('正在下载'+entry.label+'：'+(n/1048576).toFixed(2)+' MB');});
      assert(data.byteLength===entry.plainBytes&&hex(await crypto.subtle.digest('SHA-256',data))===entry.plainSha256);
      assert(new DataView(data).getUint32(0,true)===0x46546c67);
      if(run!==epoch||request!==selection)return;
      plainCache.set(index,data);objectUrl=URL.createObjectURL(new Blob([data],{type:'model/gltf-binary'}));cache.set(index,objectUrl);
    }
    if(run!==epoch||request!==selection)return;tell('解密完成，正在显示'+entry.label+'…');viewer.src=objectUrl;
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
    for(const [i,m]of unlocked.models.entries()){descriptor(m);assert(typeof m.label==='string'&&m.aad==='rp1:'+manifest.packageId+':model:'+i&&/^[a-f0-9]{64}$/.test(m.plainSha256)&&Number.isSafeInteger(m.plainBytes)&&m.plainBytes>=20&&m.plainBytes<=64*1024*1024);}
    if(run!==epoch)return;key=candidate;catalog=unlocked;base=manifestUrl;
    $('#title').textContent=catalog.title;$('#note').textContent=catalog.note;
    renderMechanisms();
    $('#gate').hidden=true;$('#preview').hidden=false;
    if(save)try{await rememberKey(pkg.scope,pageIdentity,candidate);$('#forget-device').hidden=false;$('#device-status').textContent='已记住此设备；下次打开本页会自动解锁。';}catch{$('#device-status').textContent='此浏览器无法保存登录，本次仍可正常预览。';}
    try{sessionStorage.removeItem(lockFlag);}catch{}
    if(run===epoch)await selectModel(0);
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
$('#reset').addEventListener('click',()=>partsUI.resetCamera());
$('#motion-trigger').addEventListener('click',()=>moveLinkageTo(1));$('#motion-reset').addEventListener('click',()=>moveLinkageTo(0));
$('#motion-progress').addEventListener('input',()=>{stopMotion();const target=partsUI.activeViewer();seekMotion(Math.min(Math.max(0,target.duration-1e-6),target.duration*Number($('#motion-progress').value)/1000));showMotionProgress();});
$('#motion-duration').addEventListener('change',()=>{const target=partsUI.activeViewer();target.timeScale=target.duration/travelSeconds();});
viewer.addEventListener('load',async()=>{const run=epoch,request=selection;if(catalog&&cache.get(active)===viewer.src){viewer.cameraTarget='auto auto auto';viewer.cameraOrbit='35deg 65deg 100%';viewer.jumpCameraToGoal();partsUI.configure(catalog.models[active],plainCache.get(active));await configureMotion();if(run!==epoch||request!==selection||!catalog)return;await applyMechanism(pendingMechanism);loadingIndex=-1;tell(catalog.models[active].label+'已加载，可旋转查看');document.documentElement.dataset.loaded=String(active);}});
viewer.addEventListener('error',()=>{if(catalog){loadingIndex=-1;tell('模型显示失败，点击模型按钮可重试',true);document.documentElement.dataset.error='true';}});
window.addEventListener('pagehide',clearState);
async function restoreDevice(){
  $('#unlock').disabled=true;
  try{const pkg=await getPackage(),saved=await rememberedKey(pkg.scope);if(saved){$('#forget-device').hidden=false;$('#remember-device').checked=true;$('#device-status').textContent='此设备已保存登录记录。';let locked=false;try{locked=sessionStorage.getItem(lockFlag)==='1';}catch{}if(!locked)await unlock(saved,false,true);}}
  catch{}finally{$('#unlock').disabled=false;document.documentElement.dataset.authReady='true';}
}
restoreDevice();
