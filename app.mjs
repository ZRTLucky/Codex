const $=s=>document.querySelector(s),status=$('#status'),viewer=$('#viewer');
let key=null,catalog=null,base=null,epoch=0,selection=0,active=-1,controller=null;
const cache=new Map(),encoder=new TextEncoder();
let motionFrame=0;
function stopMotion(){cancelAnimationFrame(motionFrame);motionFrame=0;viewer.pause?.();$('#motion-play').textContent='往返播放';}
function seekMotion(time){
  // This installed viewer resets mixer time when seeking a stopped action.
  // Activate the documented animation API before seeking, then hold the pose.
  viewer.play({repetitions:1,pingpong:false});viewer.currentTime=time;viewer.pause();
}
function showMotionProgress(){
  const fraction=viewer.duration>0?Math.max(0,Math.min(1,viewer.currentTime/viewer.duration)):0;
  $('#motion-progress').value=String(Math.round(fraction*1000));
  const motion=catalog?.models[active]?.motion;
  if(motion){
    const angle=fraction*motion.angleMaxDeg,rows=motion.samples;let i=0;while(i+1<rows.length-1&&angle>rows[i+1].angleDeg)i++;
    const a=rows[i],b=rows[i+1],f=Math.max(0,Math.min(1,(angle-a.angleDeg)/(b.angleDeg-a.angleDeg)));
    const lift=a.pinionLiftMm+(b.pinionLiftMm-a.pinionLiftMm)*f;
    $('#motion-status').textContent='离合座顺时针 '+angle.toFixed(1)+'° · 小齿抬起 '+lift.toFixed(3)+' mm';
  }else $('#motion-status').textContent='进度 '+(fraction*100).toFixed(0)+'%';
}
function configureMotion(){
  stopMotion();const available=viewer.availableAnimations||[];$('#motion').hidden=!available.length;if(!available.length)return;
  viewer.animationCrossfadeDuration=0;viewer.animationName=available[0];seekMotion(0);
  const hasLift=Boolean(catalog?.models[active]?.motion);$('#motion-low').textContent=hasLift?'下降':'起点';$('#motion-high').textContent=hasLift?'抬起':'终点';showMotionProgress();
}
function moveTo(fraction){
  if(!viewer.duration)return;stopMotion();const start=viewer.currentTime,target=Math.min(Math.max(0,viewer.duration-1e-6),viewer.duration*fraction),began=performance.now(),run=epoch;
  const frame=now=>{if(run!==epoch)return;const t=Math.min(1,(now-began)/900);seekMotion(start+(target-start)*t);showMotionProgress();if(t<1)motionFrame=requestAnimationFrame(frame);};
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
function prepareViewer(){
  if(!viewerReady){window.ModelViewerElement={meshoptDecoderLocation:new URL('./meshopt_decoder.js',import.meta.url).href};viewerReady=import('./model-viewer.min.js').then(()=>customElements.whenDefined('model-viewer'));}
  return viewerReady;
}
function clearState(){
  stopMotion();$('#motion').hidden=true;
  epoch++;selection++;controller?.abort();controller=null;key=null;catalog=null;base=null;active=-1;
  viewer.removeAttribute('src');for(const url of cache.values())URL.revokeObjectURL(url);cache.clear();
  $('#models').replaceChildren();$('#preview').hidden=true;$('#gate').hidden=false;$('#access-key').value='';$('#title').textContent='模型预览';$('#note').textContent='输入单独收到的访问密钥，解锁本次预览。';
  delete document.documentElement.dataset.loaded;delete document.documentElement.dataset.error;
}
async function selectModel(index){
  const run=epoch,request=++selection,entry=catalog.models[index],k=key,parent=base,signal=controller.signal;active=index;
  stopMotion();$('#motion').hidden=true;viewer.removeAttribute('src');
  delete document.documentElement.dataset.loaded;delete document.documentElement.dataset.error;
  for(const [i,button]of [...$('#models').children].entries())button.classList.toggle('active',i===index);
  tell('正在加载'+entry.label+'…');
  try{
    await prepareViewer();if(run!==epoch||request!==selection)return;
    let objectUrl=cache.get(index);
    if(!objectUrl){
      const data=await decrypt(entry,entry.aad,k,parent,signal,n=>{if(run===epoch&&request===selection)tell('正在下载'+entry.label+'：'+(n/1048576).toFixed(2)+' MB');});
      assert(data.byteLength===entry.plainBytes&&hex(await crypto.subtle.digest('SHA-256',data))===entry.plainSha256);
      assert(new DataView(data).getUint32(0,true)===0x46546c67);
      if(run!==epoch||request!==selection)return;
      objectUrl=URL.createObjectURL(new Blob([data],{type:'model/gltf-binary'}));cache.set(index,objectUrl);
    }
    if(run!==epoch||request!==selection)return;tell('解密完成，正在显示'+entry.label+'…');viewer.src=objectUrl;
  }catch(e){if(run===epoch&&request===selection){tell(e.name==='OperationError'?'模型解密失败，文件可能已损坏或密钥不匹配':e.message,true);document.documentElement.dataset.error='true';}}
}
$('#unlock-form').addEventListener('submit',async e=>{
  e.preventDefault();if($('#unlock').disabled)return;
  const value=$('#access-key').value.trim();$('#access-key').value='';
  if(!/^RP1\.[A-Za-z0-9_-]{43}$/.test(value)){tell('请输入完整的 RP1. 访问密钥',true);return;}
  if(!globalThis.isSecureContext||!crypto.subtle){tell('请通过 HTTPS 或本机 localhost 打开预览',true);return;}
  clearState();const run=epoch;controller=new AbortController();const signal=controller.signal;$('#unlock').disabled=true;tell('正在验证访问密钥…');
  try{
    const raw=Uint8Array.from(atob(value.slice(4).replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));assert(raw.length===32);
    const candidate=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);raw.fill(0);
    const source=await json(new URL('./source.json',location.href),4096,signal),manifestUrl=urlAt(source.manifest,location.href);
    const manifest=await json(manifestUrl,16384,signal);assert(manifest.version===1&&/^[a-f0-9]{32}$/.test(manifest.packageId));
    const plain=await decrypt(manifest.catalog,'rp1:'+manifest.packageId+':catalog',candidate,manifestUrl,signal);
    const unlocked=JSON.parse(new TextDecoder().decode(plain));
    assert(unlocked.version===1&&unlocked.packageId===manifest.packageId&&typeof unlocked.title==='string'&&typeof unlocked.note==='string'&&Array.isArray(unlocked.models)&&unlocked.models.length>0&&unlocked.models.length<=20);
    for(const [i,m]of unlocked.models.entries()){descriptor(m);assert(typeof m.label==='string'&&m.aad==='rp1:'+manifest.packageId+':model:'+i&&/^[a-f0-9]{64}$/.test(m.plainSha256)&&Number.isSafeInteger(m.plainBytes)&&m.plainBytes>=20&&m.plainBytes<=64*1024*1024);}
    if(run!==epoch)return;key=candidate;catalog=unlocked;base=manifestUrl;
    $('#title').textContent=catalog.title;$('#note').textContent=catalog.note;
    for(const [i,m]of catalog.models.entries()){const button=document.createElement('button');button.type='button';button.textContent=m.label;button.addEventListener('click',()=>selectModel(i));$('#models').append(button);}
    $('#gate').hidden=true;$('#preview').hidden=false;await selectModel(0);
  }catch(e){if(run===epoch){clearState();tell(e.name==='OperationError'?'访问密钥不正确，或预览包已被修改':e.message,true);document.documentElement.dataset.error='true';}}
  finally{$('#unlock').disabled=false;}
});
$('#lock').addEventListener('click',()=>{clearState();tell('预览已锁定');$('#access-key').focus();});
$('#reset').addEventListener('click',()=>{viewer.cameraOrbit='35deg 65deg auto';viewer.cameraTarget='auto auto auto';viewer.jumpCameraToGoal();});
$('#motion-low').addEventListener('click',()=>moveTo(0));$('#motion-high').addEventListener('click',()=>moveTo(1));
$('#motion-progress').addEventListener('input',()=>{stopMotion();seekMotion(Math.min(Math.max(0,viewer.duration-1e-6),viewer.duration*Number($('#motion-progress').value)/1000));showMotionProgress();});
$('#motion-play').addEventListener('click',()=>{
  if(!viewer.paused){stopMotion();return;}stopMotion();viewer.play({repetitions:Infinity,pingpong:true});$('#motion-play').textContent='暂停';
  const run=epoch,frame=()=>{if(run!==epoch)return;showMotionProgress();if(!viewer.paused)motionFrame=requestAnimationFrame(frame);};motionFrame=requestAnimationFrame(frame);
});
viewer.addEventListener('load',()=>{if(catalog&&cache.get(active)===viewer.src){configureMotion();tell(catalog.models[active].label+'已加载，可旋转查看');document.documentElement.dataset.loaded=String(active);}});
viewer.addEventListener('error',()=>{if(catalog){tell('模型显示失败，点击模型按钮可重试',true);document.documentElement.dataset.error='true';}});
window.addEventListener('pagehide',clearState);
