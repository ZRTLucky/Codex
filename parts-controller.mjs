const $=s=>document.querySelector(s);
function partBlob(data,part){
 const view=new DataView(data),jsonSize=view.getUint32(12,true),original=new Uint8Array(data),j=JSON.parse(new TextDecoder().decode(original.subarray(20,20+jsonSize)));
 const bin=original.subarray(28+jsonSize,28+jsonSize+view.getUint32(20+jsonSize,true)),node=j.nodes[part.nodeIndex];if(!node)throw Error('零件节点不存在');
 node.matrix=part.worldMatrix;delete node.translation;delete node.rotation;delete node.scale;
 j.scenes=[{nodes:[part.nodeIndex]}];j.scene=0;delete j.animations;
 const text=new TextEncoder().encode(JSON.stringify(j)),size=Math.ceil(text.length/4)*4,header=new ArrayBuffer(20),h=new DataView(header),tail=new ArrayBuffer(8),t=new DataView(tail),padded=new Uint8Array(size);padded.fill(32);padded.set(text);
 h.setUint32(0,0x46546c67,true);h.setUint32(4,2,true);h.setUint32(8,28+size+bin.length,true);h.setUint32(12,size,true);h.setUint32(16,0x4e4f534a,true);t.setUint32(0,bin.length,true);t.setUint32(4,0x004e4942,true);
 return URL.createObjectURL(new Blob([header,padded,tail,bin],{type:'model/gltf-binary'}));
}
export function createPartsController({viewer,partViewer,revisionViewer,stopMotion,tell,onModeChange}){
 let current=null,data=null,mode='assembly',singleUrl=null,partRequest=0,visibilityRequest=0;const visibility=new Map(),originals=new Map();
 async function applyVisibility(){if(!current)return;const entry=current,request=++visibilityRequest;let count=0;for(const p of entry.parts){const shown=!visibility.get(entry.plainSha256)?.has(p.id);if(shown)count++;
  for(const name of p.materialNames){const material=viewer.model?.getMaterialByName(name);if(!material)continue;
   await material.ensureLoaded();if(current!==entry||request!==visibilityRequest)return;
   let saved=originals.get(name);if(!saved){saved={rgba:[...material.pbrMetallicRoughness.baseColorFactor],mode:material.getAlphaMode(),cutoff:material.getAlphaCutoff()};originals.set(name,saved);}
   material.setAlphaMode(shown?saved.mode:'MASK');if(shown){if(saved.cutoff!==undefined)material.setAlphaCutoff(saved.cutoff);material.pbrMetallicRoughness.setBaseColorFactor(saved.rgba);}else{material.setAlphaCutoff(.5);material.pbrMetallicRoughness.setBaseColorFactor([...saved.rgba.slice(0,3),0]);}
  }
 }$('#part-count').textContent=count+' / '+current.parts.length+' 显示';}
 function showSingle(){if(!current?.parts.length||!data)return;const part=current.parts.find(p=>p.id===$('#part-select').value)||current.parts[0];const request=++partRequest;
  const old=singleUrl;singleUrl=partBlob(data,part);partViewer.removeAttribute('src');partViewer.cameraTarget='auto auto auto';partViewer.cameraOrbit='35deg 65deg auto';partViewer.alt=part.label+'独立零件';partViewer.src=singleUrl;
  if(old)URL.revokeObjectURL(old);tell('正在显示'+part.label+'…');partViewer.dataset.request=String(request);
 }
 function setMode(value){if(value==='single'&&!current?.parts.length)return;mode=value;if(mode!=='assembly')stopMotion();
  for(const name of ['assembly','single','revision']){const button=$('#mode-'+name);button.classList.toggle('active',mode===name);button.setAttribute('aria-pressed',String(mode===name));}
  viewer.hidden=mode!=='assembly';partViewer.hidden=mode!=='single';revisionViewer.hidden=mode!=='revision';$('#part-picker').hidden=mode!=='single';$('#revision-picker').hidden=mode!=='revision';$('#part-visibility').hidden=mode!=='assembly'||!current?.parts.length;$('#motion').hidden=mode!=='assembly'||!viewer.availableAnimations?.length;
  if(mode==='single'){if(!singleUrl)showSingle();else tell('独立零件已加载，可旋转查看');}else if(mode==='assembly'&&current)tell(current.label+'已加载，可旋转查看');
  onModeChange?.(mode);
 }
 for(const name of ['assembly','single','revision'])$('#mode-'+name).onclick=()=>setMode(name);$('#part-select').onchange=showSingle;
 partViewer.addEventListener('load',()=>{if(mode==='single'&&current){const part=current.parts.find(p=>p.id===$('#part-select').value);tell((part?.label||'零件')+'已加载，可旋转查看');partViewer.dataset.loaded=$('#part-select').value;}});
 partViewer.addEventListener('error',()=>{if(mode==='single')tell('零件显示失败，请重新选择',true);});
 function reset(clearSaved=false){partRequest++;visibilityRequest++;current=null;data=null;originals.clear();if(clearSaved){visibility.clear();mode='assembly';$('#view-modes').hidden=true;revisionViewer.hidden=true;$('#revision-picker').hidden=true;viewer.hidden=false;}if(singleUrl)URL.revokeObjectURL(singleUrl);singleUrl=null;partViewer.removeAttribute('src');partViewer.hidden=true;$('#mode-single').disabled=true;$('#part-picker').hidden=true;$('#part-visibility').hidden=true;$('#part-list').replaceChildren();$('#part-select').replaceChildren();delete partViewer.dataset.loaded;}
 async function configure(entry,buffer){reset();current=entry;data=buffer;$('#view-modes').hidden=false;$('#mode-single').disabled=!entry.parts?.length;
  if(!entry.parts?.length){setMode(mode==='single'?'assembly':mode);return;}
  const saved=visibility.get(entry.plainSha256)||new Set();visibility.set(entry.plainSha256,saved);
  for(const p of entry.parts){const option=document.createElement('option');option.value=p.id;option.textContent=p.label;$('#part-select').append(option);const label=document.createElement('label'),input=document.createElement('input'),span=document.createElement('span');label.className='part-row';input.type='checkbox';input.checked=!saved.has(p.id);input.dataset.part=p.id;span.textContent=p.label;
   input.onchange=()=>{if(input.checked)saved.delete(p.id);else saved.add(p.id);applyVisibility().catch(e=>tell('零件显示切换失败：'+e.message,true));};label.append(input,span);$('#part-list').append(label);
  }setMode(mode);await applyVisibility();
 }
 return {configure,reset,setMode,isAssembly:()=>mode==='assembly',isRevision:()=>mode==='revision',activeViewer:()=>mode==='revision'?revisionViewer:mode==='single'?partViewer:viewer};
}
