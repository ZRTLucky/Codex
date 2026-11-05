import {importAccessKey,rememberedKey,rememberKey,forgetPageKeys} from './device-auth.mjs';
import {createPartsController} from './parts-controller.mjs';
// Shared by the generated STEP module, web controls and GLB animation compiler.
// Absolute world transforms: rotate about the CAD datum, then translate.
function createSequencePlayer(data) {
  const fail = message => { throw Error('sequence: ' + message); };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const vec = (v, label) => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) fail(label + ' requires 3 finite numbers');
    return [...v];
  };
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-8);
  if (data?.schemaVersion !== 1 || data.coordinateSystem !== 'CAD_WORLD_MM_Z_UP') fail('unsupported schema/coordinates');
  if (!/^[a-f0-9]{64}$/.test(data.sourceSha256)) fail('missing source identity');
  if (!Array.isArray(data.parts) || !data.parts.length || !Array.isArray(data.stages)) fail('parts/stages missing');
  const parts = new Map(), fixed = new Set(data.fixedPartIds || []);
  const targets = [...data.parts, ...(data.subTargets || [])];
  for (const part of targets) {
    if (typeof part.id !== 'string' || parts.has(part.id)) fail('duplicate/invalid part id');
    if (typeof part.localTarget !== 'string' || !/^#?o\d+(\.\d+)*$/.test(part.localTarget)) fail(part.id + ': occurrence target missing');
    parts.set(part.id, part);
  }
  for (const id of fixed) if (!parts.has(id)) fail('unknown fixed part ' + id);
  for (const target of data.subTargets || []) if (!data.parts.some(p => p.id === target.parentPartId)) fail('unknown subtarget parent ' + target.id);
  const stages = [], ids = new Map(), previous = new Map();
  for (const p of parts.values()) previous.set(p.id, { translationMm: [0, 0, 0], angleDeg: 0, axis: [0, 0, 1], originMm: [0, 0, 0] });
  let total = 0;
  for (const stage of data.stages) {
    if (typeof stage.id !== 'string' || ids.has(stage.id)) fail('duplicate/invalid stage id');
    if (!finite(stage.duration) || stage.duration <= 0) fail(stage.id + ': invalid duration');
    if (!['release', 'extract', 'park', 'hold'].includes(stage.kind)) fail(stage.id + ': unknown kind');
    if (!Array.isArray(stage.dependsOn) || !Array.isArray(stage.motions)) fail(stage.id + ': dependencies/motions missing');
    for (const id of stage.dependsOn) if (!ids.has(id)) fail(stage.id + ': missing/later dependency ' + id);
    const used = new Set();
    const motions = stage.motions.map(motion => {
      if (!Array.isArray(motion.partIds) || !motion.partIds.length) fail(stage.id + ': empty motion');
      const from = vec(motion.translationMm?.from, stage.id + '.from'), to = vec(motion.translationMm?.to, stage.id + '.to');
      let rotation = null;
      if (motion.rotation) {
        const r = motion.rotation, axis = vec(r.axis, stage.id + '.axis'), originMm = vec(r.originMm, stage.id + '.origin');
        const length = Math.hypot(...axis);
        if (length < 1e-12 || !finite(r.fromDeg) || !finite(r.toDeg)) fail(stage.id + ': invalid rotation');
        rotation = { axis: axis.map(v => v / length), originMm, fromDeg: r.fromDeg, toDeg: r.toDeg };
      }
      for (const id of motion.partIds) {
        if (!parts.has(id) || used.has(id) || fixed.has(id)) fail(stage.id + ': invalid/duplicate/fixed target ' + id);
        used.add(id);
        const p = previous.get(id);
        if (!same(p.translationMm, from)) fail(stage.id + ': discontinuous translation for ' + id);
        if (rotation) {
          if (Math.abs(p.angleDeg - rotation.fromDeg) > 1e-8) fail(stage.id + ': discontinuous angle for ' + id);
          if (p.angleDeg !== 0 && (!same(p.axis, rotation.axis) || !same(p.originMm, rotation.originMm))) fail(stage.id + ': changed rotation datum for ' + id);
        }
        previous.set(id, { translationMm: to, angleDeg: rotation?.toDeg ?? p.angleDeg, axis: rotation?.axis ?? p.axis, originMm: rotation?.originMm ?? p.originMm });
      }
      return { partIds: [...motion.partIds], from, to, rotation };
    });
    for (const id of used) if (parts.get(id)?.parentPartId && used.has(parts.get(id).parentPartId)) fail(stage.id + ': parent/child driven together ' + id);
    const parsed = { ...stage, start: total, end: total + stage.duration, motions };
    stages.push(parsed); ids.set(stage.id, parsed); total = parsed.end;
  }
  const blockingIssues = (data.unresolved || []).filter(issue => issue.blocking === true);
  const blockedStage = stages.find(stage => stage.blocked === true || stage.validation === 'blocked' || stage.motions.some(m => m.partIds.some(id => blockingIssues.some(issue => issue.partIds?.includes(id) || issue.partIds?.includes(parts.get(id)?.parentPartId) || issue.targetIds?.includes(id)))));
  const playableDuration = blockedStage ? blockedStage.start : total;
  const identity = () => ({ translationMm: [0, 0, 0], angleDeg: 0, axis: [0, 0, 1], originMm: [0, 0, 0] });
  function at(seconds) {
    if (!finite(seconds)) fail('time must be finite');
    const time = Math.min(playableDuration, Math.max(0, seconds)), states = {};
    for (const id of parts.keys()) states[id] = identity();
    for (const stage of stages) {
      if (time <= stage.start) break;
      const f = Math.min(1, (time - stage.start) / stage.duration);
      for (const m of stage.motions) for (const id of m.partIds) {
        const state = states[id];
        state.translationMm = m.from.map((v, i) => v + (m.to[i] - v) * f);
        if (m.rotation) {
          state.angleDeg = m.rotation.fromDeg + (m.rotation.toDeg - m.rotation.fromDeg) * f;
          state.axis = [...m.rotation.axis]; state.originMm = [...m.rotation.originMm];
        }
      }
    }
    const stageIndex = stages.length ? Math.min(stages.length - 1, stages.findIndex(s => time < s.end) < 0 ? stages.length - 1 : stages.findIndex(s => time < s.end)) : -1;
    return { time, total: playableDuration, stageIndex, stage: stages[stageIndex] || null, states, blocked: Boolean(blockedStage && time >= playableDuration) };
  }
  return { data, parts: data.parts, targets: [...parts.values()], stages, duration: playableDuration, candidateDuration: total, blockedStage: blockedStage || null, at };
}

function stateMatrix(state, glb = false) {
  const convert = v => glb ? [v[0], v[2], -v[1]] : [...v];
  const [x, y, z] = convert(state.axis), angle = state.angleDeg * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle), q = 1 - c;
  const r = [x*x*q+c, y*x*q+z*s, z*x*q-y*s, 0, x*y*q-z*s, y*y*q+c, z*y*q+x*s, 0, x*z*q+y*s, y*z*q-x*s, z*z*q+c, 0, 0, 0, 0, 1];
  const o = convert(state.originMm), t = convert(state.translationMm), scale = glb ? .001 : 1;
  for (let i=0;i<3;i++) r[12+i] = scale*(t[i]+o[i]-r[i]*o[0]-r[4+i]*o[1]-r[8+i]*o[2]);
  return r;
}

function applyCadFrame(player, time, model) {
  const frame = player.at(time);
  for (const part of player.targets) {
    const s = frame.states[part.id], handle = model.get(part.localTarget.startsWith('#') ? part.localTarget : '#'+part.localTarget);
    // Resolve every target at t=0 as well; the Viewer validates targets at load.
    if (s.angleDeg) handle.rotate(s.axis, s.angleDeg, s.originMm);
    if (s.translationMm.some(v => v !== 0)) handle.translate(s.translationMm);
  }
  return frame;
}

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
  updateSequence270();
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
  $('#motion').hidden=!partsUI.isAssembly()||!groups.length;$('#motion-controls').hidden=!ready||g?.id==='sequence270'; updateSequence270();
  $('#mechanism-note').textContent=g?.note||'';
}
async function selectMechanism(index){
  const run=epoch,request=++mechanismSequence,g=mechanisms()[index];if(!g)return;
  const wasSequence=isSequence270();mechanismIndex=index;stopMotion();
  const clip=viewer.availableAnimations.indexOf(g.animationName);
  // Every clip contains rest transforms for unused targets, so seeking its start resets the complete assembly.
  if(viewer.availableAnimations.length)await selectMotion(clip<0?0:clip);
  if(run!==epoch||request!==mechanismSequence)return;
  await partsUI.setScope(g.partIds);if(run!==epoch||request!==mechanismSequence)return;
  for(const [i,b]of [...$('#motion-modes').children].entries()){b.classList.toggle('active',i===index);b.setAttribute('aria-pressed',String(i===index));}
  updateMotionUI();document.documentElement.dataset.mechanism=g.id;
  if(g.id==='sequence270'&&!wasSequence){sequence270Camera={orbit:viewer.cameraOrbit,target:viewer.cameraTarget};fitSequence270(true);}
  else if(wasSequence&&g.id!=='sequence270'&&sequence270Camera){viewer.cameraOrbit=sequence270Camera.orbit;viewer.cameraTarget=sequence270Camera.target;viewer.jumpCameraToGoal();sequence270Camera=null;}
  updateSequence270();
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
  clearSequence270();stopMotion();partsUI.reset(true);plainCache.clear();assetCache.clear();pendingModels.clear();$('#motion').hidden=true;
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
    setupSequence270();await configureMotion();if(run!==epoch||request!==selection||!catalog)return;
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
// Reuses model-viewer's public animation API; clips are compiled by the same
// pure evaluator used by the STEP render module. No scene-symbol mutation.
let sequence270=null,sequence270Camera=null;
function isSequence270(){return mechanisms()[mechanismIndex]?.id==='sequence270';}
function setupSequence270(){
 sequence270=null;sequence270Camera=null;
 const buffer=plainCache.get(active);if(!buffer)return;
 const size=new DataView(buffer).getUint32(12,true),j=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,size)));
 if(j.extras?.sequence270)sequence270=createSequencePlayer(j.extras.sequence270.data);
 $('#sequence270-boundary-list').replaceChildren(...(sequence270?.data.unresolved||[]).map(issue=>{const li=document.createElement('li');li.textContent=issue.problem;return li;}));
}
function clearSequence270(){sequence270=null;sequence270Camera=null;$('#sequence270').hidden=true;for(const id of ['sequence270-stage','sequence270-note','sequence270-blocked','sequence270-boundary-list'])$('#'+id).replaceChildren();}
function updateSequence270(){
 const panel=$('#sequence270');if(!sequence270){panel.hidden=true;return;}
 panel.hidden=!partsUI.isAssembly()||!isSequence270();
 if(panel.hidden)return;
 const p=sequence270,clock=viewer.currentTime||0,state=p.at(Math.abs(clock-p.duration)<1e-5?p.duration:clock),stage=state.stage;
 $('#sequence270-progress').value=String(Math.round(state.time/p.duration*1000));
 $('#sequence270-stage').textContent=`${state.stageIndex+1}/${p.stages.length} · ${state.blocked?'已停在阻塞前：':''}${stage?.label||'269零位'} · ${state.time.toFixed(2)} / ${p.duration.toFixed(2)} s`;
 $('#sequence270-note').textContent=(stage?.kind==='park'?'此段为脱离后的展示排布。 ':'')+(stage?.note||'')+' '+(p.data.status?.startsWith('SAFE_PREFIX')?'本次只包含局部拆卸前缀。':'当前为拆装候选。')+'未验证部分不代表机械可拆通过。';
 const held=(p.data.heldPartIds||[]).map(id=>p.parts.find(part=>part.id===id)?.name||id);
 $('#sequence270-blocked').textContent=p.data.unresolved?.some(v=>v.blocking)?(p.blockedStage?'当前候选只播放至阻塞前。':'仅播放当前已给出的阶段，其余零件保持原位。')+p.data.unresolved.filter(v=>v.blocking).map(v=>v.problem).join(' '):(held.length?'连接尚未定义，原位保留：'+held.join('、')+'。':'');
 document.documentElement.dataset.sequence270Time=String(state.time);
}
function fitSequence270(allStages=false,reviewAngle=false){
 if(!sequence270)return;
 const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],points=[],p=sequence270;
 // Playback fits the full path once. The explicit fit button frames the current
 // pose, so the final three columns do not shrink to the transfer corridor.
 for(const time of (allStages?[0,...p.stages.map(s=>Math.min(s.end,p.duration))]:[viewer.currentTime||0])){
  const frame=p.at(time);
  for(const part of p.targets){if(!part.boundsMm)continue;const m=stateMatrix(frame.states[part.id],true);
   for(let i=0;i<8;i++){const a=part.boundsMm[(i>>0)&1][0],b=part.boundsMm[(i>>1)&1][1],c=part.boundsMm[(i>>2)&1][2],v=[a*.001,c*.001,-b*.001],q=[0,1,2].map(k=>m[k]*v[0]+m[4+k]*v[1]+m[8+k]*v[2]+m[12+k]);if(reviewAngle)points.push(q);for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],q[k]);hi[k]=Math.max(hi[k],q[k]);}}
  }
 }
 const center=lo.map((v,k)=>(v+hi[k])/2),radius=Math.hypot(...lo.map((v,k)=>(hi[k]-v)/2)),orbit=viewer.getCameraOrbit(),fov=viewer.getFieldOfView()*Math.PI/180,aspect=Math.max(.2,viewer.clientWidth/viewer.clientHeight),vertical=Math.min(fov,2*Math.atan(Math.tan(fov/2)*aspect));
 let theta=orbit.theta,phi=orbit.phi,distance=1.15*radius/Math.sin(vertical/2);
 if(reviewAngle){
  theta=50*Math.PI/180;phi=55*Math.PI/180;
  const direction=[Math.sin(phi)*Math.sin(theta),Math.cos(phi),Math.sin(phi)*Math.cos(theta)],right=[Math.cos(theta),0,-Math.sin(theta)],up=[-Math.cos(phi)*Math.sin(theta),Math.sin(phi),-Math.cos(phi)*Math.cos(theta)],dot=(a,b)=>a.reduce((n,v,k)=>n+v*b[k],0),projected=points.map(q=>{const v=q.map((x,k)=>x-center[k]);return[dot(v,right),dot(v,up)];});
  const dx=(Math.min(...projected.map(v=>v[0]))+Math.max(...projected.map(v=>v[0])))/2,dy=(Math.min(...projected.map(v=>v[1]))+Math.max(...projected.map(v=>v[1])))/2;for(let k=0;k<3;k++)center[k]+=dx*right[k]+dy*up[k];
  distance=Math.max(.02,...points.map(q=>{const v=q.map((x,k)=>x-center[k]);return dot(v,direction)+Math.max(Math.abs(dot(v,up))/(.72*Math.tan(fov/2)),Math.abs(dot(v,right))/(.85*Math.tan(fov/2)*aspect));}));
 }
 viewer.cameraTarget=center.map(v=>v+'m').join(' ');viewer.cameraOrbit=`${theta}rad ${phi}rad ${distance}m`;viewer.jumpCameraToGoal();
}
function sequence270Seek(time){if(!sequence270)return;stopMotion();seekMotion(Math.min(sequence270.duration,Math.max(0,time)));showMotionProgress();}
function sequence270Step(direction){const t=viewer.currentTime||0,p=sequence270;if(!p)return;const ends=[0,...p.stages.map(s=>s.end).filter(t=>t<=p.duration)],target=direction>0?ends.find(v=>v>t+1e-5):ends.filter(v=>v<t-1e-5).at(-1);sequence270Seek(target??(direction>0?p.duration:0));}
function sequence270Play(direction){
 if(!sequence270||!isSequence270())return;stopMotion();const run=epoch,p=sequence270;let time=viewer.currentTime||0,last=performance.now();if((direction>0&&time>=p.duration-1e-5)||(direction<0&&time<=1e-5))return;
 seekMotion(time);fitSequence270(true);
 const frame=now=>{if(run!==epoch||!isSequence270()||!partsUI.isAssembly())return;time=Math.min(p.duration,Math.max(0,time+(now-last)/1000*direction));last=now;seekMotion(time);showMotionProgress();if(direction>0?time<p.duration:time>0)motionFrame=requestAnimationFrame(frame);else motionFrame=0;};motionFrame=requestAnimationFrame(frame);
}
$('#sequence270-forward').onclick=()=>sequence270Play(1);$('#sequence270-reverse').onclick=()=>sequence270Play(-1);$('#sequence270-pause').onclick=stopMotion;$('#sequence270-prev').onclick=()=>sequence270Step(-1);$('#sequence270-next').onclick=()=>sequence270Step(1);$('#sequence270-fit').onclick=()=>fitSequence270(false,true);
$('#sequence270-progress').oninput=()=>sequence270Seek(sequence270.duration*Number($('#sequence270-progress').value)/1000);

restoreDevice();
