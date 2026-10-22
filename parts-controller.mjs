const $=s=>document.querySelector(s);
export const EXPLODE='装配分解展示';
function encodeGlb(j,bin){const text=new TextEncoder().encode(JSON.stringify(j)),size=Math.ceil(text.length/4)*4,pad=new Uint8Array(size);pad.fill(32);pad.set(text);const h=new ArrayBuffer(20),d=new DataView(h),b=new ArrayBuffer(8),t=new DataView(b);d.setUint32(0,0x46546c67,true);d.setUint32(4,2,true);d.setUint32(8,28+size+bin.length,true);d.setUint32(12,size,true);d.setUint32(16,0x4e4f534a,true);t.setUint32(0,bin.length,true);t.setUint32(4,0x004e4942,true);return new Blob([h,pad,b,bin],{type:'model/gltf-binary'});}
// Retain selected branches and ancestors without baking over animation targets.
export function relationBlob(data,parts,vectors={}){
 const view=new DataView(data),size=view.getUint32(12,true),bytes=new Uint8Array(data),j=JSON.parse(new TextDecoder().decode(bytes.subarray(20,20+size))),bin=bytes.slice(28+size,28+size+view.getUint32(20+size,true));
 const parents=new Map();j.nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parents.set(c,i)));const keep=new Set();
 function descend(i){if(keep.has(i))return;keep.add(i);for(const c of j.nodes[i].children||[])descend(c);}
 for(const p of parts){descend(p.nodeIndex);let n=p.nodeIndex;while(parents.has(n)){n=parents.get(n);keep.add(n);}}
 for(const n of j.nodes)if(n.children)n.children=n.children.filter(i=>keep.has(i));
 j.scenes=[{nodes:(j.scenes[j.scene||0].nodes||[]).filter(i=>keep.has(i))}];j.scene=0;
 j.animations=(j.animations||[]).map(a=>({...a,channels:a.channels.filter(c=>keep.has(c.target.node))})).filter(a=>a.channels.length);
 const floats=[0,1],tracks=[];
 for(const [i,p]of parts.entries()){
  const v=(vectors[p.id]||[0,(i-(parts.length-1)/2)*5,0]).map(x=>x/1000),wrapper=j.nodes.length;
  j.nodes.push({name:'display-separation-'+p.id,children:[p.nodeIndex]});
  const parent=parents.get(p.nodeIndex),list=parent===undefined?j.scenes[0].nodes:j.nodes[parent].children;list[list.indexOf(p.nodeIndex)]=wrapper;
  const offset=floats.length;floats.push(0,0,0,...v);tracks.push({node:wrapper,offset});
 }
 const extra=new Uint8Array(new Float32Array(floats).buffer),joined=new Uint8Array(bin.length+extra.length);joined.set(bin);joined.set(extra,bin.length);
 j.bufferViews||=[];j.accessors||=[];const vi=j.bufferViews.length;j.bufferViews.push({buffer:0,byteOffset:bin.length,byteLength:extra.length});const ti=j.accessors.length;j.accessors.push({bufferView:vi,byteOffset:0,componentType:5126,count:2,type:'SCALAR',min:[0],max:[1]});
 const animation={name:EXPLODE,samplers:[],channels:[]};for(const t of tracks){const output=j.accessors.length;j.accessors.push({bufferView:vi,byteOffset:t.offset*4,componentType:5126,count:2,type:'VEC3'});animation.samplers.push({input:ti,output,interpolation:'LINEAR'});animation.channels.push({sampler:animation.samplers.length-1,target:{node:t.node,path:'translation'}});}
 j.animations.push(animation);j.buffers[0].byteLength=joined.length;return encodeGlb(j,joined);
}
export function createPartsController({viewer,partViewer,stopMotion,tell,onAutoPlay,onChange}){
 let current=null,data=null,single=false,url=null,partId=null,relationId='',scope=null,scopeLabel='',presentation='assembly',linkedMotion=null,request=0;
 const visibility=new Map(),originals=new Map();
 const selected=()=>current?.parts.find(p=>p.id===partId);
 const relations=()=>current?.relations?.filter(r=>r.partIds.includes(partId))||[];
 function selectedParts(){if(!current)return[];let ids=single?(relations().find(r=>r.id===relationId)?.partIds||[partId]):current.parts.map(p=>p.id);return current.parts.filter(p=>ids.includes(p.id)&&(!scope||scope.has(p.id))&&(single||!visibility.get(current.plainSha256)?.has(p.id)));}
 function usesDerived(){return single||presentation!=='assembly';}
 function activeViewer(){return usesDerived()?partViewer:viewer;}
 function applyVisibility(){if(!current)return;let count=0;for(const p of current.parts){const shown=(!scope||scope.has(p.id))&&!visibility.get(current.plainSha256)?.has(p.id);if(shown)count++;for(const name of p.materialNames){const m=viewer.model?.getMaterialByName(name);if(!m)continue;let s=originals.get(name);if(!s){s={rgba:[...m.pbrMetallicRoughness.baseColorFactor],mode:m.getAlphaMode(),cutoff:m.getAlphaCutoff()};originals.set(name,s);}m.setAlphaMode(shown?s.mode:'MASK');if(shown){if(s.cutoff!==undefined)m.setAlphaCutoff(s.cutoff);m.pbrMetallicRoughness.setBaseColorFactor(s.rgba);}else{m.setAlphaCutoff(.5);m.pbrMetallicRoughness.setBaseColorFactor([...s.rgba.slice(0,3),0]);}}}$('#part-count').textContent=count+' / '+current.parts.length+' 显示';for(const label of $('#part-list').children)label.hidden=Boolean(scope&&!scope.has(label.dataset.part));}
 function button(text,value,active,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.dataset.value=value;b.setAttribute('aria-pressed',String(active));b.onclick=fn;return b;}
 function renderRelations(){const box=$('#relation-options');box.replaceChildren(button('仅选中零件','',!relationId,()=>{stopMotion();relationId='';renderRelations();render();}));for(const r of relations())box.append(button(r.label,r.id,r.id===relationId,()=>{stopMotion();relationId=r.id;renderRelations();render();}));$('#relation-current').textContent=relations().find(r=>r.id===relationId)?.label||'仅选中零件';}
 function choosePart(id){stopMotion();partId=id;relationId=relations().find(r=>!scope||r.partIds.every(p=>scope.has(p)))?.id||relations()[0]?.id||'';renderChoices();renderRelations();render();}
 function renderChoices(){const box=$('#part-select');box.replaceChildren();if(!current)return;const available=current.parts.filter(p=>!scope||scope.has(p.id)),seen=new Set();
  for(const r of current.relations||[]){const members=available.filter(p=>r.partIds.includes(p.id)&&!seen.has(p.id));if(!members.length)continue;const h=document.createElement('p');h.className='choice-group';h.textContent=r.label;box.append(h);for(const p of members){seen.add(p.id);const b=button(p.label,p.id,p.id===partId,()=>choosePart(p.id));b.dataset.part=p.id;box.append(b);}}
  for(const p of available.filter(p=>!seen.has(p.id))){const b=button(p.label,p.id,p.id===partId,()=>choosePart(p.id));b.dataset.part=p.id;box.append(b);}$('#part-current').textContent=selected()?.label||'请选择';}
 function setPresentation(value){stopMotion();presentation=value;render();}
 function render(){if(!current)return;const parts=selectedParts();if(!parts.length){tell('请先显示至少一个零件');return;}partViewer.autoRotate=false;viewer.hidden=usesDerived();partViewer.hidden=!usesDerived();$('#part-picker').hidden=!single;$('#part-visibility').hidden=single;$('#display-picker').hidden=false;
  $('#mode-assembly').classList.toggle('active',!single);$('#mode-single').classList.toggle('active',single);$('#mode-assembly').setAttribute('aria-pressed',String(!single));$('#mode-single').setAttribute('aria-pressed',String(single));
  $('#display-current').textContent={assembly:'装配',explode:'分解',autoplay:'自动播放'}[presentation];for(const b of document.querySelectorAll('[data-presentation]')){b.setAttribute('aria-pressed',String(b.dataset.presentation===presentation));b.disabled=b.dataset.presentation==='explode'&&parts.length<2;}
  if(!usesDerived()){partViewer.pause?.();onChange?.();return;}
 const old=url;url=URL.createObjectURL(relationBlob(data,parts,current.explode));partViewer.removeAttribute('src');partViewer.cameraTarget='auto auto auto';partViewer.cameraOrbit='35deg 65deg auto';partViewer.src=url;partViewer.dataset.request=String(++request);if(old)URL.revokeObjectURL(old);onChange?.();
 }
 function setMode(mode){stopMotion();single=mode==='single';render();}
 function setScope(ids,label){stopMotion();scope=ids?.length?new Set(ids):null;scopeLabel=label||'';if(scope&&!scope.has(partId))partId=current?.parts.find(p=>scope.has(p.id))?.id;relationId=relations()[0]?.id||'';presentation='assembly';renderChoices();renderRelations();applyVisibility();render();}
 function setMotion(name){linkedMotion=name;}
 function resetCamera(){const t=activeViewer();t.cameraTarget='auto auto auto';t.cameraOrbit='35deg 65deg auto';t.jumpCameraToGoal();if(t!==partViewer||!(presentation==='explode'||presentation==='autoplay'&&t.animationName===EXPLODE))return;const orbit=t.getCameraOrbit(),target=t.getCameraTarget(),dim=t.getDimensions(),parts=selectedParts(),vectors=parts.map((p,i)=>(current.explode?.[p.id]||[0,(i-(parts.length-1)/2)*5,0]).map(x=>x/1000)),extra=Math.max(...vectors.map(v=>Math.hypot(...v))),factor=1+2*extra/Math.max(dim.x,dim.y,dim.z,.001);t.cameraOrbit=orbit.theta+'rad '+orbit.phi+'rad '+(orbit.radius*factor)+'m';const shift=[0,1,2].map(i=>(Math.min(...vectors.map(v=>v[i]))+Math.max(...vectors.map(v=>v[i])))/2);t.cameraTarget=[target.x+shift[0],target.y+shift[1],target.z+shift[2]].map(x=>x+'m').join(' ');t.jumpCameraToGoal();}
 function sync(time){const target=activeViewer(),other=target===viewer?partViewer:viewer;if(linkedMotion&&other.availableAnimations?.includes(linkedMotion)){other.animationName=linkedMotion;other.play({repetitions:1});other.currentTime=time;other.pause();}}
 partViewer.addEventListener('load',async()=>{if(!current||!usesDerived())return;const r=request;partViewer.animationCrossfadeDuration=0;partViewer.autoRotate=false;
  partViewer.animationName=presentation==='explode'?EXPLODE:(linkedMotion&&partViewer.availableAnimations.includes(linkedMotion)?linkedMotion:EXPLODE);await partViewer.updateComplete;if(r!==request)return;
  partViewer.play({repetitions:1});partViewer.currentTime=presentation==='explode'?Math.max(0,partViewer.duration-1e-6):(partViewer.animationName===linkedMotion?viewer.currentTime:0);partViewer.pause();
  resetCamera();
  if(presentation==='autoplay'){if(linkedMotion&&partViewer.availableAnimations.includes(linkedMotion)){partViewer.animationName=linkedMotion;await partViewer.updateComplete;onAutoPlay?.();}else if(selectedParts().length>1){partViewer.animationName=EXPLODE;await partViewer.updateComplete;onAutoPlay?.();}else partViewer.autoRotate=true;}
  tell((single?(relations().find(r=>r.id===relationId)?.label||selected()?.label):scopeLabel||current.label)+' · '+$('#display-current').textContent);partViewer.dataset.loaded=partId||'assembly';onChange?.();
 });
 partViewer.addEventListener('error',()=>{if(usesDerived())tell('零件关系显示失败，请重新选择',true);});
 $('#mode-assembly').onclick=()=>setMode('assembly');$('#mode-single').onclick=()=>setMode('single');for(const b of document.querySelectorAll('[data-presentation]'))b.onclick=()=>setPresentation(b.dataset.presentation);
 function reset(clearSaved=false){stopMotion();request++;current=null;data=null;single=false;scope=null;partId=null;relationId='';presentation='assembly';linkedMotion=null;originals.clear();if(clearSaved)visibility.clear();if(url)URL.revokeObjectURL(url);url=null;partViewer.autoRotate=false;partViewer.removeAttribute('src');partViewer.hidden=true;viewer.hidden=false;for(const id of ['view-modes','part-picker','part-visibility','display-picker'])$('#'+id).hidden=true;for(const id of ['part-list','part-select','relation-options'])$('#'+id).replaceChildren();delete partViewer.dataset.loaded;}
 function configure(entry,buffer){reset();if(!entry.parts?.length)return;current=entry;data=buffer;partId=entry.parts[0].id;relationId=relations()[0]?.id||'';$('#view-modes').hidden=false;const saved=visibility.get(entry.plainSha256)||new Set();visibility.set(entry.plainSha256,saved);for(const p of entry.parts){const label=document.createElement('label'),input=document.createElement('input'),span=document.createElement('span');label.className='part-row';label.dataset.part=p.id;input.type='checkbox';input.checked=!saved.has(p.id);input.dataset.part=p.id;span.textContent=p.label;input.onchange=()=>{if(input.checked)saved.delete(p.id);else saved.add(p.id);applyVisibility();if(usesDerived())render();};label.append(input,span);$('#part-list').append(label);}renderChoices();renderRelations();applyVisibility();render();}
 return {configure,reset,isSingle:()=>single,activeViewer,setScope,setMotion,sync,resetCamera,presentation:()=>presentation,selectPresentation:setPresentation,hasParts:()=>Boolean(current),isReady:()=>activeViewer()===viewer||partViewer.loaded};
}
