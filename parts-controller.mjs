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
export function createPartsController({viewer,partViewer,stopMotion,tell}){
 let current=null,data=null,single=false,singleUrl=null,partRequest=0;const visibility=new Map(),originals=new Map();
 function applyVisibility(){if(!current)return;let count=0;for(const p of current.parts){const shown=!visibility.get(current.plainSha256)?.has(p.id);if(shown)count++;
  for(const name of p.materialNames){const material=viewer.model?.getMaterialByName(name);if(!material)continue;let saved=originals.get(name);if(!saved){saved={rgba:[...material.pbrMetallicRoughness.baseColorFactor],mode:material.getAlphaMode(),cutoff:material.getAlphaCutoff()};originals.set(name,saved);}
   material.setAlphaMode(shown?saved.mode:'MASK');if(shown){if(saved.cutoff!==undefined)material.setAlphaCutoff(saved.cutoff);material.pbrMetallicRoughness.setBaseColorFactor(saved.rgba);}else{material.setAlphaCutoff(.5);material.pbrMetallicRoughness.setBaseColorFactor([...saved.rgba.slice(0,3),0]);}
  }
 }$('#part-count').textContent=count+' / '+current.parts.length+' 显示';}
 function showSingle(){if(!current?.parts.length||!data)return;const part=current.parts.find(p=>p.id===$('#part-select').value)||current.parts[0];const request=++partRequest;
  const old=singleUrl;singleUrl=partBlob(data,part);partViewer.removeAttribute('src');partViewer.cameraTarget='auto auto auto';partViewer.cameraOrbit='35deg 65deg auto';partViewer.alt=part.label+'独立零件';partViewer.src=singleUrl;
  if(old)URL.revokeObjectURL(old);tell('正在显示'+part.label+'…');partViewer.dataset.request=String(request);
 }
 function setMode(value){single=value==='single';if(single)stopMotion();$('#mode-assembly').classList.toggle('active',!single);$('#mode-single').classList.toggle('active',single);$('#mode-assembly').setAttribute('aria-pressed',String(!single));$('#mode-single').setAttribute('aria-pressed',String(single));
  viewer.hidden=single;partViewer.hidden=!single;$('#part-picker').hidden=!single;$('#part-visibility').hidden=single||!current?.parts.length;$('#motion').hidden=single||!viewer.availableAnimations?.length;
  if(single)showSingle();else if(current)tell(current.label+'已加载，可旋转查看');
 }
 $('#mode-assembly').onclick=()=>setMode('assembly');$('#mode-single').onclick=()=>setMode('single');$('#part-select').onchange=showSingle;
 partViewer.addEventListener('load',()=>{if(single&&current){const part=current.parts.find(p=>p.id===$('#part-select').value);tell((part?.label||'零件')+'已加载，可旋转查看');partViewer.dataset.loaded=$('#part-select').value;}});
 partViewer.addEventListener('error',()=>{if(single)tell('零件显示失败，请重新选择',true);});
 function reset(clearSaved=false){partRequest++;current=null;data=null;single=false;originals.clear();if(clearSaved)visibility.clear();if(singleUrl)URL.revokeObjectURL(singleUrl);singleUrl=null;partViewer.removeAttribute('src');partViewer.hidden=true;viewer.hidden=false;$('#view-modes').hidden=true;$('#part-picker').hidden=true;$('#part-visibility').hidden=true;$('#part-list').replaceChildren();$('#part-select').replaceChildren();delete partViewer.dataset.loaded;}
 function configure(entry,buffer){reset();if(!entry.parts?.length)return;current=entry;data=buffer;$('#view-modes').hidden=false;$('#part-visibility').hidden=false;
  const saved=visibility.get(entry.plainSha256)||new Set();visibility.set(entry.plainSha256,saved);
  for(const p of entry.parts){const option=document.createElement('option');option.value=p.id;option.textContent=p.label;$('#part-select').append(option);const label=document.createElement('label'),input=document.createElement('input'),span=document.createElement('span');label.className='part-row';input.type='checkbox';input.checked=!saved.has(p.id);input.dataset.part=p.id;span.textContent=p.label;
   input.onchange=()=>{if(input.checked)saved.delete(p.id);else saved.add(p.id);applyVisibility();};label.append(input,span);$('#part-list').append(label);
  }setMode('assembly');applyVisibility();
 }
 return {configure,reset,isSingle:()=>single,activeViewer:()=>single?partViewer:viewer};
}
