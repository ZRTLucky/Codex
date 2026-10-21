const DB='cad-preview-device-keys',STORE='keys';
function database(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE,{keyPath:'scope'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('无法读取此设备的登录记录'));r.onblocked=()=>reject(Error('此设备的登录记录暂时不可用'));});}
async function transaction(mode,action){const db=await database();try{return await new Promise((resolve,reject)=>{const t=db.transaction(STORE,mode),r=action(t.objectStore(STORE));t.oncomplete=()=>resolve(r?.result);t.onabort=t.onerror=()=>reject(Error('无法保存此设备的登录记录'));});}finally{db.close();}}
export async function rememberedKey(scope){const r=await transaction('readonly',s=>s.get(scope));const k=r?.key;return k instanceof CryptoKey&&!k.extractable&&k.algorithm.name==='AES-GCM'&&k.algorithm.length===256&&k.usages.includes('decrypt')?k:null;}
export function rememberKey(scope,page,key){return transaction('readwrite',s=>s.put({scope,page,key,createdAt:Date.now()}));}
export async function forgetPageKeys(page){const records=await transaction('readonly',s=>s.getAll());return transaction('readwrite',s=>{for(const r of records)if(r.page===page)s.delete(r.scope);});}
const decode=s=>{if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s))throw Error('预览解锁配置不正确');return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));};
export async function importAccessKey(value,manifest){
  let raw;
  if(/^RP1\.[A-Za-z0-9_-]{43}$/.test(value))raw=decode(value.slice(4));
  else{
    const a=manifest.passwordUnlock;
    if(!a)throw Error('请输入完整的 RP1. 访问密钥');
    if(a.version!==1||a.kdf!=='PBKDF2-SHA256'||!Number.isInteger(a.iterations)||a.iterations<600000||a.iterations>2000000)throw Error('预览解锁配置不正确');
    const salt=decode(a.salt),blob=decode(a.wrappedKey);if(salt.length!==16||blob.length!==64||new TextDecoder().decode(blob.slice(0,4))!=='RPV1')throw Error('预览解锁配置不正确');
    const encoded=new TextEncoder().encode(value);const passwordKey=await crypto.subtle.importKey('raw',encoded,'PBKDF2',false,['deriveKey']);encoded.fill(0);
    const wrapping=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:a.iterations},passwordKey,{name:'AES-GCM',length:256},false,['decrypt']);
    raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:blob.slice(4,16),additionalData:new TextEncoder().encode('rp1:'+manifest.packageId+':access-key'),tagLength:128},wrapping,blob.slice(16)));
  }
  if(raw.length!==32)throw Error('访问密码或密钥不正确');
  try{return await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);}finally{raw.fill(0);}
}
