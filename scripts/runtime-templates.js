"use strict";

function sharedFiles() {
  return {
    "src/shared/error-codes.js": `"use strict";
const ErrorCodes = Object.freeze({
  E_INPUT:"E_INPUT", E_SCHEMA:"E_SCHEMA", E_PATH:"E_PATH", E_SYMLINK:"E_SYMLINK",
  E_PERMISSION:"E_PERMISSION", E_APPROVAL:"E_APPROVAL", E_TIMEOUT:"E_TIMEOUT",
  E_CANCELED:"E_CANCELED", E_NETWORK:"E_NETWORK", E_AUTH:"E_AUTH",
  E_RATE_LIMIT:"E_RATE_LIMIT", E_UPSTREAM:"E_UPSTREAM", E_CONFLICT:"E_CONFLICT",
  E_CORRUPT:"E_CORRUPT", E_OUTPUT_LIMIT:"E_OUTPUT_LIMIT", E_INDETERMINATE:"E_INDETERMINATE",
  E_UNSUPPORTED:"E_UNSUPPORTED", E_UNKNOWN:"E_UNKNOWN"
});
class WahooError extends Error { constructor(code,message,details){ super(message); this.name="WahooError"; this.code=code; this.details=details; } }
module.exports={ErrorCodes,WahooError};
`,
    "src/shared/result-envelope.js": `"use strict";
const {ErrorCodes}=require("./error-codes");
function ok(data,meta={}){return{ok:true,data,meta};}
function fail(code,message,details={},retryable=false){return{ok:false,error:{code:code||ErrorCodes.E_UNKNOWN,message:String(message||"Bilinmeyen hata"),details,retryable}};}
function fromError(err){return fail(err?.code||ErrorCodes.E_UNKNOWN,err?.message||String(err),err?.details||{},!!err?.retryable);}
module.exports={ok,fail,fromError};
`,
    "src/shared/hash-utils.js": `"use strict";
const crypto=require("node:crypto"); const fs=require("node:fs");
function sha256(data){return crypto.createHash("sha256").update(data).digest("hex");}
async function hashFile(file){const h=crypto.createHash("sha256");await new Promise((resolve,reject)=>{const s=fs.createReadStream(file);s.on("data",d=>h.update(d));s.on("end",resolve);s.on("error",reject);});return h.digest("hex");}
module.exports={sha256,hashFile};
`,
    "src/shared/text-utils.js": `"use strict";
function tokensRough(s){return Math.ceil(String(s||"").length/4);}
function lineColumn(src,index){const before=String(src).slice(0,index);const lines=before.split(/\\r?\\n/);return{line:lines.length,column:(lines.at(-1)||"").length+1};}
function truncate(s,n=2048){s=String(s||"");return s.length>n?s.slice(0,n)+"…":s;}
function words(s){return[...new Set(String(s||"").toLowerCase().split(/[^\\p{L}\\p{N}_-]+/u).filter(Boolean))];}
module.exports={tokensRough,lineColumn,truncate,words};
`,
    "src/shared/ignore-rules.js": `"use strict";
const DEFAULT=[".git","node_modules","dist","build","release","coverage",".cache",".next",".nuxt","vendor","__pycache__",".venv","venv"];
function normalizeRules(lines=[]){return lines.map(x=>String(x).trim()).filter(x=>x&&!x.startsWith("#"));}
function shouldIgnore(rel,rules=DEFAULT){const p=String(rel).replace(/\\\\/g,"/");return rules.some(r=>{r=String(r).replace(/^\\/+|\\/$/g,"");return p===r||p.startsWith(r+"/")||p.split("/").includes(r);});}
module.exports={DEFAULT,normalizeRules,shouldIgnore};
`,
    "src/shared/schema-validator.js": `"use strict";
function validate(schema,value,path="$",errors=[]){if(!schema||typeof schema!=="object")return errors;const t=schema.type;if(t==="object"){if(!value||typeof value!=="object"||Array.isArray(value)){errors.push({path,message:"object bekleniyor"});return errors;}for(const r of schema.required||[])if(!(r in value))errors.push({path:path+"."+r,message:"zorunlu"});for(const[k,v]of Object.entries(value))if(schema.properties?.[k])validate(schema.properties[k],v,path+"."+k,errors);else if(schema.additionalProperties===false)errors.push({path:path+"."+k,message:"bilinmeyen alan"});}else if(t==="array"){if(!Array.isArray(value))errors.push({path,message:"array bekleniyor"});else value.forEach((v,i)=>validate(schema.items,v,path+"["+i+"]",errors));}else if(t&&typeof value!==t)errors.push({path,message:t+" bekleniyor"});if(schema.enum&&!schema.enum.includes(value))errors.push({path,message:"enum dışında"});return errors;}
module.exports={validate};
`,
    "src/shared/workspace-path.js": `"use strict";
const fs=require("node:fs");const path=require("node:path");const {WahooError,ErrorCodes}=require("./error-codes");
function norm(p){const r=path.resolve(p);return process.platform==="win32"?r.toLowerCase():r;}
function canonicalRoot(root){if(!root)throw new WahooError(ErrorCodes.E_PATH,"Workspace kökü eksik");return fs.realpathSync.native?fs.realpathSync.native(path.resolve(root)):fs.realpathSync(path.resolve(root));}
function nearestExisting(p){let cur=path.resolve(p);while(!fs.existsSync(cur)){const parent=path.dirname(cur);if(parent===cur)break;cur=parent;}return cur;}
function inside(root,target){const r=norm(root),t=norm(target),rel=path.relative(r,t);return rel===""||(!rel.startsWith(".."+path.sep)&&rel!==".."&&!path.isAbsolute(rel));}
function resolveInside(root,input,{allowMissing=true}={}){const realRoot=canonicalRoot(root);const candidate=path.resolve(realRoot,String(input||"."));if(!inside(realRoot,candidate))throw new WahooError(ErrorCodes.E_PATH,"Workspace dışına çıkış engellendi",{input});const existing=nearestExisting(candidate);const realParent=fs.realpathSync.native?fs.realpathSync.native(existing):fs.realpathSync(existing);if(!inside(realRoot,realParent))throw new WahooError(ErrorCodes.E_SYMLINK,"Symlink/reparse kaçışı engellendi",{input,realParent});if(!allowMissing&&!fs.existsSync(candidate))throw new WahooError(ErrorCodes.E_PATH,"Hedef bulunamadı",{input});if(fs.existsSync(candidate)){const realTarget=fs.realpathSync.native?fs.realpathSync.native(candidate):fs.realpathSync(candidate);if(!inside(realRoot,realTarget))throw new WahooError(ErrorCodes.E_SYMLINK,"Gerçek hedef workspace dışında",{input});return realTarget;}return candidate;}
module.exports={canonicalRoot,resolveInside,inside,nearestExisting};
`,
    "src/shared/file-scanner.js": `"use strict";
const fs=require("node:fs");const path=require("node:path");const {DEFAULT,normalizeRules,shouldIgnore}=require("./ignore-rules");const {resolveInside}=require("./workspace-path");
function readRules(root){const out=[...DEFAULT];for(const name of[".gitignore",".wahooignore"]){try{out.push(...normalizeRules(fs.readFileSync(path.join(root,name),"utf8").split(/\\r?\\n/)));}catch{}}return out;}
function isBinary(buf){const n=Math.min(buf.length,4096);for(let i=0;i<n;i++)if(buf[i]===0)return true;return false;}
function scan(root,{maxFiles=10000,maxBytes=2*1024*1024,signal,rules=readRules(root)}={}){const base=resolveInside(root,".",{allowMissing:false});const out=[];const stack=[base];while(stack.length&&out.length<maxFiles){if(signal?.aborted)throw signal.reason||new Error("aborted");const dir=stack.pop();for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const abs=path.join(dir,ent.name);const rel=path.relative(base,abs).replace(/\\\\/g,"/");if(shouldIgnore(rel,rules))continue;if(ent.isSymbolicLink())continue;if(ent.isDirectory()){stack.push(abs);continue;}if(!ent.isFile())continue;const st=fs.statSync(abs);let binary=false;if(st.size<=maxBytes){try{const fd=fs.openSync(abs,"r"),b=Buffer.alloc(Math.min(st.size,4096));fs.readSync(fd,b,0,b.length,0);fs.closeSync(fd);binary=isBinary(b);}catch{binary=true;}}else binary=true;out.push({path:rel,absolute:abs,size:st.size,mtimeMs:st.mtimeMs,ext:path.extname(ent.name).toLowerCase(),binary});if(out.length>=maxFiles)break;}}
return out;}
module.exports={scan,isBinary,readRules};
`,
    "src/shared/secret-redaction.js": `"use strict";
const crypto=require("node:crypto");const {lineColumn}=require("./text-utils");
const RULES=[
 {kind:"private-key",re:/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\\s\\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g},
 {kind:"url-credential",re:/\\b(?:https?|postgres|mysql|mongodb(?:\\+srv)?|redis):\\/\\/[^\\s:@/]+:[^\\s@/]+@[^\\s]+/gi},
 {kind:"jwt",re:/\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b/g},
 {kind:"bearer",re:/\\bBearer\\s+[A-Za-z0-9._~-]{12,}/gi},
 {kind:"google-api-key",re:/\\bAIza[0-9A-Za-z_-]{20,}\\b/g},
 {kind:"github-token",re:/\\bgh[pousr]_[A-Za-z0-9]{20,}\\b/g},
 {kind:"aws-access-key",re:/\\bAKIA[0-9A-Z]{16}\\b/g},
 {kind:"generic-api-key",re:/\\bsk-(?:ant-)?[A-Za-z0-9_-]{18,}\\b/g},
 {kind:"env-secret",re:/^(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\\s*=\\s*[^\\s#]{8,}/gmi}
];
function fingerprint(s){return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0,12);}
function scanSecrets(input){const src=String(input||"");const findings=[];for(const rule of RULES){rule.re.lastIndex=0;let m;while((m=rule.re.exec(src))){const pos=lineColumn(src,m.index);findings.push({kind:rule.kind,...pos,fingerprint:fingerprint(m[0]),length:m[0].length});if(m[0].length===0)rule.re.lastIndex++;}}return findings;}
function redact(input){let text=String(input||"");for(const rule of RULES){rule.re.lastIndex=0;text=text.replace(rule.re,m=>"[REDACTED:"+rule.kind+":"+fingerprint(m)+"]");}return{text,findings:scanSecrets(input)};}
module.exports={RULES,scanSecrets,redact,fingerprint};
`,
    "src/shared/plugin-algorithms.js": `"use strict";
module.exports=require("./plugin-algorithms/index");
`
  };
}

function featureFiles() {
  const files={};
  files["src/features/provider-router.js"]=`"use strict";
function choose(req={},providers=[],health={}){const scored=providers.map(p=>{let score=0,reasons=[];if(req.explicit===p.id){score+=1000;reasons.push("explicit");}if(req.localOnly&&p.id!=="local-openai-compatible")score-=10000;if(req.capabilities)for(const c of req.capabilities)p.capabilities?.[c]?(score+=20,reasons.push("cap:"+c)):score-=100;if(health[p.id]?.ok===false)score-=200;if(p.local)score+=req.preferLocal?50:0;if(req.budget?.blocked?.includes(p.id))score-=1000;return{provider:p,score,reasons};}).sort((a,b)=>b.score-a.score);const winner=scored[0];return{chosen:winner?.provider?.id||null,reasons:winner?.reasons||[],candidates:scored.map(x=>({id:x.provider.id,score:x.score,reasons:x.reasons}))};}
module.exports={choose};
`;
  files["src/features/stream-normalizer.js"]=`"use strict";
function create(runId){let seq=0,terminal=false;const seen=new Set();function emit(type,payload={},externalId){if(terminal)throw new Error("terminal sonrası event");if(externalId&&seen.has(externalId))return null;if(externalId)seen.add(externalId);const e={runId,sequence:seq++,type,payload,externalId,at:Date.now()};if(["completed","error","canceled"].includes(type))terminal=true;return e;}return{delta:(x,id)=>emit("delta",{text:x},id),reasoning:(x,id)=>emit("reasoning_delta",{text:x},id),tool:(x,id)=>emit("tool_delta",x,id),usage:(x,id)=>emit("usage",x,id),complete:(x,id)=>emit("completed",x,id),error:(x,id)=>emit("error",x,id),cancel:(x,id)=>emit("canceled",x,id),state:()=>({sequence:seq,terminal})};}
module.exports={create};
`;
  files["src/features/retry-circuit-breaker.js"]=`"use strict";
const RETRYABLE=new Set([408,429,500,502,503,504,"E_NETWORK","E_TIMEOUT"]);function sleep(ms,signal){return new Promise((r,j)=>{const t=setTimeout(r,ms);signal?.addEventListener("abort",()=>{clearTimeout(t);j(signal.reason||new Error("aborted"));},{once:true});});}
async function withRetry(fn,o={}){const started=Date.now(),max=o.retries??3;let last;for(let i=0;i<=max;i++){if(o.signal?.aborted)throw o.signal.reason;try{last=await fn(i);}catch(e){last={ok:false,error:{code:e.code||"E_NETWORK",message:e.message}};}if(last?.ok)return last;const code=last?.status||last?.error?.status||last?.error?.code;if(!RETRYABLE.has(code)||o.idempotent===false||Date.now()-started>(o.maxElapsedMs??30000))return last;const ra=Number(last?.retryAfterMs||0);const jitter=(o.random||Math.random)()*(o.jitterMs??100);await sleep(Math.max(ra,Math.min(o.capMs??4000,(o.baseMs??250)*2**i)+jitter),o.signal);}return last;}
function circuit({threshold=5,cooldownMs=30000,clock=Date.now}={}){let failures=0,openedAt=0,half=false;return{allow(){if(failures<threshold)return true;if(clock()-openedAt>=cooldownMs&&!half){half=true;return true;}return false;},success(){failures=0;half=false;},failure(){failures++;if(failures>=threshold)openedAt=clock();half=false;},state(){return failures<threshold?"closed":(clock()-openedAt>=cooldownMs?"half-open":"open");}};}
module.exports={withRetry,circuit,RETRYABLE};
`;
  files["src/features/context-budgeter.js"]=`"use strict";
function allocate(total,parts,{minResponse=512}={}){const result={};let remaining=Math.max(0,total-minResponse);const sorted=[...parts].sort((a,b)=>(b.priority||0)-(a.priority||0));const reductions=[];for(const p of sorted){const want=Math.max(0,p.requested||0),give=Math.min(want,remaining);result[p.id]=give;remaining-=give;if(give<want)reductions.push({id:p.id,wanted:want,given:give,reason:"budget"});}result.response=Math.min(total,minResponse+remaining);return{total,allocation:result,reductions,used:Object.values(result).reduce((a,b)=>a+b,0)};}
module.exports={allocate};
`;
  files["src/features/tool-policy-engine.js"]=`"use strict";
function decide(rules=[],ctx={}){const matches=rules.filter(r=>(!r.tool||r.tool===ctx.tool)&&(!r.workspace||r.workspace===ctx.workspace)&&(!r.pathPrefix||String(ctx.path||"").startsWith(r.pathPrefix)));const deny=matches.find(r=>r.decision==="deny");if(deny)return{decision:"deny",rule:deny};const ask=matches.find(r=>r.decision==="ask");if(ask)return{decision:"ask",rule:ask};const allow=matches.find(r=>r.decision==="allow");return{decision:allow?"allow":"ask",rule:allow||null};}
module.exports={decide};
`;
  files["src/features/approval-gate.js"]=`"use strict";
class Gate{constructor({clock=Date.now}={}){this.clock=clock;this.items=[];}grant(g){if(!["once","run","workspace","pattern","deny"].includes(g.scope))throw new Error("scope");let regex=null;if(g.pattern){if(g.pattern.length>200)throw new Error("pattern uzun");regex=new RegExp(g.pattern);}this.items.push({...g,regex,expiresAt:g.ttlMs?this.clock()+g.ttlMs:null});}check(c){this.items=this.items.filter(x=>!x.expiresAt||x.expiresAt>this.clock());const m=this.items.filter(x=>x.tool===c.tool&&(!x.workspaceId||x.workspaceId===c.workspaceId)&&(!x.runId||x.runId===c.runId)&&(!x.regex||x.regex.test(String(c.value||""))));if(m.some(x=>x.scope==="deny"))return{decision:"deny"};const g=m[0];return{decision:g?"allow":"ask",grant:g||null};}consume(g,success=true){if(success&&g?.scope==="once")this.items=this.items.filter(x=>x!==g);}}
module.exports={Gate};
`;
  files["src/features/task-state-machine.js"]=`"use strict";
const S=["created","queued","running","awaiting_approval","paused","canceling","completed","failed","canceled","indeterminate"];const T={created:["queued","canceled"],queued:["running","canceled"],running:["awaiting_approval","paused","canceling","completed","failed","indeterminate"],awaiting_approval:["running","canceling","canceled","failed"],paused:["running","canceling","canceled"],canceling:["canceled","failed","indeterminate"],completed:[],failed:[],canceled:[],indeterminate:[]};function transition(a,b){if(!S.includes(a)||!T[a].includes(b))throw new Error("geçersiz geçiş "+a+"->"+b);return b;}module.exports={STATES:S,TRANSITIONS:T,transition};
`;
  files["src/features/checkpoint-manager.js"]=`"use strict";
const fs=require("node:fs");const path=require("node:path");const {sha256}=require("../shared/hash-utils");class Checkpoints{constructor(dir=null){this.dir=dir;this.items=[];if(dir)fs.mkdirSync(path.join(dir,"blobs"),{recursive:true});}add(label,data){const buf=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data));const hash=sha256(buf);if(this.dir){const p=path.join(this.dir,"blobs",hash);if(!fs.existsSync(p))fs.writeFileSync(p,buf);this._save([...this.items,{label,hash,size:buf.length,at:Date.now()}]);}else this.items.push({label,hash,size:buf.length,at:Date.now(),data:buf});return{label,hash};}_save(items){const tmp=path.join(this.dir,"manifest.tmp");fs.writeFileSync(tmp,JSON.stringify(items,null,2));fs.renameSync(tmp,path.join(this.dir,"manifest.json"));this.items=items;}load(){if(!this.dir)return this.items;try{const x=JSON.parse(fs.readFileSync(path.join(this.dir,"manifest.json"),"utf8"));if(!Array.isArray(x))throw new Error();this.items=x;return x;}catch(e){throw Object.assign(new Error("corrupt manifest"),{code:"E_CORRUPT"});}}restore(hash){const b=this.dir?fs.readFileSync(path.join(this.dir,"blobs",hash)):this.items.find(x=>x.hash===hash)?.data;if(!b||sha256(b)!==hash)throw Object.assign(new Error("restore hash"),{code:"E_CORRUPT"});return b;}}
module.exports={Checkpoints};
`;
  files["src/features/audit-ledger.js"]=`"use strict";
class Ledger{constructor(){this.items=[];}append(e){const x=Object.freeze({at:Date.now(),...e});this.items.push(x);return x;}list(filter={}){return this.items.filter(x=>Object.entries(filter).every(([k,v])=>x[k]===v));}}
module.exports={Ledger};
`;
  files["src/features/run-replay.js"]=`"use strict";
function replay(events){const byRun=new Map();for(const e of events){if(!byRun.has(e.runId))byRun.set(e.runId,[]);byRun.get(e.runId).push(e);}const runs={};for(const[id,list]of byRun){const seen=new Set(),ordered=[],gaps=[],orphans=[];let expected=0,terminal=false;for(const e of list.sort((a,b)=>a.sequence-b.sequence)){if(seen.has(e.sequence))continue;seen.add(e.sequence);while(expected<e.sequence)gaps.push(expected++);if(terminal)orphans.push(e);else{ordered.push(e);if(["completed","error","canceled"].includes(e.type))terminal=true;}expected=e.sequence+1;}runs[id]={events:ordered,gaps,orphans};}return{runs};}
module.exports={replay};
`;
  files["src/features/extension-registry.js"]=`"use strict";
class Registry{constructor(hostApi="2.0.0"){this.hostApi=hostApi;this.items=new Map();}register(m){if(!m?.id||!m?.version||!m?.entry)throw new Error("manifest eksik");if(this.items.has(m.id))throw new Error("duplicate plugin");this.items.set(m.id,{...m,health:{ok:true},enabled:true});}setHealth(id,h){const x=this.items.get(id);if(x)x.health={...h,at:Date.now()};}list(){return[...this.items.values()].map(x=>({...x}));}}
module.exports={Registry};
`;
  files["src/features/latest-request-guard.js"]=`"use strict";
function create(){let gen=0;return{issue(){return++gen;},isLatest(x){return x===gen;},assert(x){if(x!==gen)throw Object.assign(new Error("stale"),{code:"E_CONFLICT"});}};}module.exports={create};
`;
  files["src/features/cancellation-controller.js"]=`"use strict";
function combine(signals=[],timeoutMs=0){const ac=new AbortController();const abort=s=>!ac.signal.aborted&&ac.abort(s?.reason||new Error("aborted"));for(const s of signals.filter(Boolean)){if(s.aborted)abort(s);else s.addEventListener("abort",()=>abort(s),{once:true});}let timer=null;if(timeoutMs>0)timer=setTimeout(()=>ac.abort(Object.assign(new Error("timeout"),{code:"E_TIMEOUT"})),timeoutMs);ac.signal.addEventListener("abort",()=>timer&&clearTimeout(timer),{once:true});return ac;}
module.exports={combine};
`;
  files["src/features/workspace-path-guard.js"]=`"use strict";module.exports=require("../shared/workspace-path");
`;
  files["src/features/atomic-file-writer.js"]=`"use strict";
const fs=require("node:fs");const path=require("node:path");const crypto=require("node:crypto");const {resolveInside}=require("../shared/workspace-path");const {sha256}=require("../shared/hash-utils");async function write(root,rel,data,{expectedHash}={}){const target=resolveInside(root,rel);fs.mkdirSync(path.dirname(target),{recursive:true});const before=fs.existsSync(target)?fs.readFileSync(target):null;if(expectedHash&&sha256(before||Buffer.alloc(0))!==expectedHash)throw Object.assign(new Error("base hash"),{code:"E_CONFLICT"});const mode=fs.existsSync(target)?fs.statSync(target).mode:null;const tmp=path.join(path.dirname(target),"."+path.basename(target)+"."+process.pid+"."+crypto.randomBytes(4).toString("hex")+".tmp");const backup=target+"." +Date.now()+".rev";let replaced=false;try{const h=await fs.promises.open(tmp,"wx",mode||0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}if(expectedHash&&sha256(fs.existsSync(target)?fs.readFileSync(target):Buffer.alloc(0))!==expectedHash)throw Object.assign(new Error("stale before replace"),{code:"E_CONFLICT"});if(before)await fs.promises.copyFile(target,backup);try{await fs.promises.rename(tmp,target);}catch(e){if(process.platform==="win32"&&fs.existsSync(target)){await fs.promises.unlink(target);await fs.promises.rename(tmp,target);}else throw e;}replaced=true;if(mode)await fs.promises.chmod(target,mode);return{ok:true,path:target,hash:sha256(Buffer.from(data)),backup:before?backup:null};}catch(e){try{if(replaced&&before)await fs.promises.copyFile(backup,target);}catch{return{ok:false,error:{code:"E_INDETERMINATE",message:e.message}};}throw e;}finally{try{if(fs.existsSync(tmp))await fs.promises.unlink(tmp);}catch{}}}
module.exports={write};
`;
  files["src/features/permission-boundary.js"]=`"use strict";
const fs=require("node:fs");const {resolveInside}=require("../shared/workspace-path");const atomic=require("./atomic-file-writer");function capabilities({root,permissions=[],spawn}){const has=p=>permissions.includes(p);return{readText:async rel=>{if(!has("workspace.read"))throw Object.assign(new Error("read denied"),{code:"E_PERMISSION"});return fs.promises.readFile(resolveInside(root,rel,{allowMissing:false}),"utf8");},list:async rel=>{if(!has("workspace.read"))throw Object.assign(new Error("list denied"),{code:"E_PERMISSION"});return fs.promises.readdir(resolveInside(root,rel,{allowMissing:false}));},writeText:async(rel,data,o)=>{if(!has("workspace.write"))throw Object.assign(new Error("write denied"),{code:"E_PERMISSION"});return atomic.write(root,rel,data,o);},run:async(argv,o)=>{if(!has("process.run")||!spawn)throw Object.assign(new Error("run denied"),{code:"E_PERMISSION"});if(!Array.isArray(argv)||!argv.length)throw new Error("argv");return spawn(argv,o);}};}
module.exports={capabilities};
`;
  files["src/features/secret-redaction.js"]=`"use strict";module.exports=require("../shared/secret-redaction");
`;
  files["src/features/health-monitor.js"]=`"use strict";
class Health{constructor(size=100){this.size=size;this.map=new Map();}record(id,x){const a=this.map.get(id)||[];a.push({...x,at:Date.now()});if(a.length>this.size)a.splice(0,a.length-this.size);this.map.set(id,a);}stats(id){const a=this.map.get(id)||[],d=a.map(x=>x.durationMs||0).sort((x,y)=>x-y),fails=a.filter(x=>!x.ok);let consecutive=0;for(let i=a.length-1;i>=0&&!a[i].ok;i--)consecutive++;const pct=p=>d.length?d[Math.min(d.length-1,Math.floor((d.length-1)*p))]:0;return{id,count:a.length,p50:pct(.5),p95:pct(.95),failureRate:a.length?fails.length/a.length:0,consecutiveFailures:consecutive,lastSuccess:[...a].reverse().find(x=>x.ok)?.at||null,lastFailure:[...a].reverse().find(x=>!x.ok)?.at||null,degraded:consecutive>=3};}}
module.exports={Health};
`;
  files["src/features/feature-flags.js"]=`"use strict";
const STATES=["disabled","experimental","enabled","degraded","blocked"];class Flags{constructor(){this.version=0;this.map=new Map();this.audit=[];}set(name,state,reason=""){if(!STATES.includes(state))throw new Error("state");const prev=this.map.get(name)?.state||"disabled";const x=Object.freeze({state,reason,updatedAt:Date.now(),version:++this.version});this.map.set(name,x);this.audit.push(Object.freeze({name,from:prev,to:state,reason,version:this.version}));return x;}get(n){return this.map.get(n)||{state:"disabled"};}snapshot(){return{version:this.version,flags:Object.fromEntries(this.map),audit:[...this.audit]};}}
module.exports={Flags,STATES};
`;
  files["src/features/evidence-recorder.js"]=`"use strict";
const {sha256}=require("../shared/hash-utils");const {redact}=require("../shared/secret-redaction");class Evidence{constructor(){this.items=[];}record(x){const out=redact(x.stdout||"").text,err=redact(x.stderr||"").text;const e={testId:x.testId||null,argv:x.argv||[],cwd:x.cwd||null,exitCode:x.exitCode,durationMs:x.durationMs||0,stdoutHash:sha256(out),stderrHash:sha256(err),artifacts:(x.artifacts||[]).map(a=>({path:a.path,hash:a.hash})),at:Date.now()};this.items.push(Object.freeze(e));return e;}list(){return[...this.items];}}
module.exports={Evidence};
`;
  files["src/features/bounded-concurrency-pool.js"]=`"use strict";
class Pool{constructor(max=4){this.max=max;this.active=0;this.q=[];}run(fn,{signal,timeoutMs=0}={}){return new Promise((resolve,reject)=>{this.q.push({fn,resolve,reject,signal,timeoutMs});this._drain();});}_drain(){while(this.active<this.max&&this.q.length){const t=this.q.shift();if(t.signal?.aborted){t.reject(t.signal.reason);continue;}this.active++;let timer;Promise.resolve().then(t.fn).then(t.resolve,t.reject).finally(()=>{clearTimeout(timer);this.active--;this._drain();});if(t.timeoutMs)timer=setTimeout(()=>t.reject(Object.assign(new Error("timeout"),{code:"E_TIMEOUT"})),t.timeoutMs);}}}
module.exports={Pool};
`;
  files["src/features/persistent-run-store.js"]=`"use strict";
const fs=require("node:fs");class RunStore{constructor(file){this.file=file;}append(e){fs.appendFileSync(this.file,JSON.stringify(e)+"\\n","utf8");}read(){let s="";try{s=fs.readFileSync(this.file,"utf8");}catch{return[];}const out=[];for(const line of s.split(/\\r?\\n/)){if(!line)continue;try{out.push(JSON.parse(line));}catch{break;}}return out;}compact(items){const tmp=this.file+".tmp";fs.writeFileSync(tmp,items.map(JSON.stringify).join("\\n")+"\\n");fs.renameSync(tmp,this.file);}}
module.exports={RunStore};
`;
  files["src/features/cache-invalidation.js"]=`"use strict";
function key(x){return[x.workspaceGeneration,x.path,x.revision,...(x.dependencies||[])].join("|");}class Cache{constructor(){this.map=new Map();}get(x){return this.map.get(key(x));}set(x,v){this.map.set(key(x),v);}invalidateGeneration(g){for(const k of this.map.keys())if(k.startsWith(g+"|"))this.map.delete(k);}}
module.exports={Cache,key};
`;
  files["src/features/structured-logger.js"]=`"use strict";
const fs=require("node:fs");const {redact}=require("../shared/secret-redaction");class Logger{constructor(file,{maxBytes=2e6}={}){this.file=file;this.maxBytes=maxBytes;}log(level,component,message,meta={}){const e={at:new Date().toISOString(),level,component,message:redact(message).text,meta:JSON.parse(redact(JSON.stringify(meta)).text)};if(fs.existsSync(this.file)&&fs.statSync(this.file).size>this.maxBytes)fs.renameSync(this.file,this.file+".1");fs.appendFileSync(this.file,JSON.stringify(e)+"\\n");return e;}}
module.exports={Logger};
`;
  files["src/features/local-metrics.js"]=`"use strict";
class Metrics{constructor(){this.c=new Map();this.h=new Map();}inc(n,v=1){this.c.set(n,(this.c.get(n)||0)+v);}observe(n,v){const a=this.h.get(n)||[];a.push(v);this.h.set(n,a);}snapshot(){return{counters:Object.fromEntries(this.c),histograms:Object.fromEntries([...this.h].map(([k,a])=>[k,{count:a.length,min:Math.min(...a),max:Math.max(...a),avg:a.reduce((x,y)=>x+y,0)/a.length}]))};}}
module.exports={Metrics};
`;
  files["src/features/schema-migration-registry.js"]=`"use strict";
const {sha256}=require("../shared/hash-utils");class Migrations{constructor(){this.items=[];}add(v,up,down){this.items.push({v,up,down,checksum:sha256(String(up))});this.items.sort((a,b)=>a.v-b.v);}async apply(state,target,journal=[]){for(const m of this.items.filter(x=>x.v>state.version&&x.v<=target)){journal.push({v:m.v,status:"started",checksum:m.checksum});state=await m.up(state);state.version=m.v;journal.at(-1).status="done";}return{state,journal};}}
module.exports={Migrations};
`;
  files["src/features/content-addressed-blob-store.js"]=`"use strict";
const fs=require("node:fs");const path=require("node:path");const {sha256}=require("../shared/hash-utils");class Blobs{constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true});this.refs=new Map();}put(data){const b=Buffer.from(data),h=sha256(b),p=path.join(this.dir,h);if(!fs.existsSync(p)){const t=p+".tmp";fs.writeFileSync(t,b);fs.renameSync(t,p);}this.refs.set(h,(this.refs.get(h)||0)+1);return{hash:h,size:b.length};}release(h){this.refs.set(h,Math.max(0,(this.refs.get(h)||0)-1));}gc({dryRun=true}={}){const orphan=fs.readdirSync(this.dir).filter(x=>!x.endsWith(".tmp")&&(this.refs.get(x)||0)===0);if(!dryRun)orphan.forEach(x=>fs.unlinkSync(path.join(this.dir,x)));return orphan;}}
module.exports={Blobs};
`;
  files["src/features/process-supervisor.js"]=`"use strict";
const cp=require("node:child_process");function run(argv,{cwd,allow=[],timeoutMs=60000,maxOutput=1e6,signal}={}){if(!Array.isArray(argv)||!argv.length)throw new Error("argv");if(allow.length&&!allow.includes(argv[0]))throw Object.assign(new Error("command denied"),{code:"E_PERMISSION"});return new Promise((resolve,reject)=>{const p=cp.spawn(argv[0],argv.slice(1),{cwd,shell:false,windowsHide:true});let out="",err="",killed=false;const add=(k,d)=>{const s=d.toString();if(k==="o")out=(out+s).slice(-maxOutput);else err=(err+s).slice(-maxOutput);};p.stdout.on("data",d=>add("o",d));p.stderr.on("data",d=>add("e",d));const kill=()=>{killed=true;try{process.platform==="win32"?cp.spawn("taskkill",["/pid",String(p.pid),"/t","/f"],{shell:false}):p.kill("SIGTERM");}catch{}};const timer=setTimeout(kill,timeoutMs);signal?.addEventListener("abort",kill,{once:true});p.on("error",reject);p.on("close",code=>{clearTimeout(timer);resolve({exitCode:code,stdout:out,stderr:err,killed});});});}
module.exports={run};
`;
  files["src/features/plugin-compatibility-resolver.js"]=`"use strict";
function major(v){return Number(String(v||"0").split(".")[0]);}function resolve(manifest,host){const reasons=[];if(major(manifest.hostApi)!==major(host.api))reasons.push("hostApi major");if(manifest.os&&!manifest.os.includes(host.os))reasons.push("os");if(manifest.nodeMajor&&manifest.nodeMajor!==host.nodeMajor)reasons.push("node");for(const c of manifest.capabilities||[])if(!host.capabilities?.includes(c))reasons.push("cap:"+c);return{compatible:reasons.length===0,reasons};}
module.exports={resolve};
`;
  files["src/features/rate-limit-governor.js"]=`"use strict";
class Governor{constructor(){this.map=new Map();}configure(id,{capacity=10,refillPerSec=1,concurrency=2}={}){this.map.set(id,{tokens:capacity,capacity,refillPerSec,concurrency,active:0,last:Date.now(),blockedUntil:0});}reserve(id,cost=1){const x=this.map.get(id);if(!x)return{ok:true};const now=Date.now();x.tokens=Math.min(x.capacity,x.tokens+(now-x.last)/1000*x.refillPerSec);x.last=now;if(now<x.blockedUntil||x.active>=x.concurrency||x.tokens<cost)return{ok:false,retryAfterMs:Math.max(1,x.blockedUntil-now)};x.tokens-=cost;x.active++;return{ok:true,release:()=>x.active--};}retryAfter(id,ms){const x=this.map.get(id);if(x)x.blockedUntil=Date.now()+ms;}}
module.exports={Governor};
`;
  files["src/features/config-resolver.js"]=`"use strict";
function resolve({defaults={},file={},env={},explicit={},secretKeys=[]}={}){const value={...defaults,...file,...env,...explicit},provenance={};for(const k of Object.keys(value))provenance[k]=k in explicit?"explicit":k in env?"env":k in file?"file":"default";const safe=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,secretKeys.includes(k)?(v?"[SET]":"[MISSING]"):v]));return{value,provenance,safe};}
module.exports={resolve};
`;
  files["src/features/deterministic-runtime.js"]=`"use strict";
function create({now=()=>Date.now(),random=()=>Math.random(),uuid}={}){let n=0;return{now,random,uuid:uuid||(()=>"det-"+now()+"-"+(n++))};}
module.exports={create};
`;
  return files;
}

function hostFiles(){return{
  "src/host/plugin-validator.js":`"use strict";const {validate}=require("../shared/schema-validator");function manifest(m){const missing=["id","name","version","entry","permissions","inputSchema","outputSchema"].filter(k=>!m?.[k]);return{ok:!missing.length,missing};}module.exports={manifest,validateInput:validate};\n`,
  "src/host/plugin-loader.js":`"use strict";const fs=require("node:fs"),path=require("node:path");const {manifest}=require("./plugin-validator");function load(dir){const m=JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8"));const v=manifest(m);if(!v.ok)throw new Error("manifest:"+v.missing.join(","));const mod=require(path.join(dir,m.entry));if(typeof mod.run!=="function")throw new Error("run yok");return{manifest:m,module:mod};}module.exports={load};\n`,
  "src/host/plugin-registry.js":`"use strict";module.exports=require("../features/extension-registry");\n`,
  "src/host/plugin-runner.js":`"use strict";const {fromError}=require("../shared/result-envelope");async function run(plugin,input,ctx){const started=Date.now();try{const r=await plugin.module.run(input,ctx);return{...r,meta:{...(r.meta||{}),durationMs:Date.now()-started}};}catch(e){return fromError(e);}}module.exports={run};\n`,
  "src/host/plugin-error-normalizer.js":`"use strict";const {fromError}=require("../shared/result-envelope");module.exports={normalize:fromError};\n`,
  "src/host/plugin-host.js":`"use strict";const path=require("node:path"),fs=require("node:fs");const {load}=require("./plugin-loader"),runner=require("./plugin-runner");class Host{constructor(root){this.root=root;this.plugins=new Map();}discover(){for(const e of fs.readdirSync(this.root,{withFileTypes:true}))if(e.isDirectory()){const p=load(path.join(this.root,e.name));this.plugins.set(p.manifest.id,p);}return[...this.plugins.keys()];}run(id,input,ctx){const p=this.plugins.get(id);if(!p)throw new Error("plugin yok");return runner.run(p,input,ctx);}}module.exports={Host};\n`
};}

function providerFiles(){
  const common=`"use strict";
const {ok,fail}=require("../shared/result-envelope");const {redact}=require("../shared/secret-redaction");const {combine}=require("../features/cancellation-controller");
async function jsonRequest(url,{headers={},body,signal,timeoutMs=60000,fetchImpl=global.fetch,maxBytes=5e6}={}){const ac=combine([signal],timeoutMs);let res;try{res=await fetchImpl(url,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),signal:ac.signal});}catch(e){return fail(/abort|timeout/i.test(e.message)?"E_TIMEOUT":"E_NETWORK",e.message);}const requestId=res.headers?.get?.("x-request-id")||res.headers?.get?.("request-id")||null;const ct=res.headers?.get?.("content-type")||"";const text=await res.text();if(Buffer.byteLength(text)>maxBytes)return fail("E_OUTPUT_LIMIT","Yanıt çok büyük",{requestId});if(!res.ok){const code=res.status===401||res.status===403?"E_AUTH":res.status===429?"E_RATE_LIMIT":res.status>=500?"E_UPSTREAM":"E_UNKNOWN";return fail(code,"HTTP "+res.status,{requestId,body:redact(text.slice(0,2048)).text,status:res.status,retryAfter:res.headers?.get?.("retry-after")});}if(!ct.includes("json"))return fail("E_SCHEMA","JSON content-type bekleniyor",{requestId,ct});try{return ok(JSON.parse(text),{requestId});}catch{return fail("E_SCHEMA","Bozuk JSON",{requestId});}}
module.exports={jsonRequest};
`;
  const openai=`"use strict";const {jsonRequest}=require("./_common");const {ok,fail}=require("../shared/result-envelope");async function completion(o={}){const key=process.env.OPENAI_API_KEY;if(!key)return fail("E_AUTH","OPENAI_API_KEY eksik");const base=(o.baseUrl||process.env.OPENAI_BASE_URL||"https://api.openai.com/v1").replace(/\\/$/,"");if(base!=="https://api.openai.com/v1"&&o.compatibleChat){const r=await jsonRequest(base+"/chat/completions",{headers:{authorization:"Bearer "+key},body:{model:o.model||process.env.OPENAI_MODEL,messages:o.messages,max_tokens:o.maxTokens},signal:o.signal,fetchImpl:o.fetchImpl});if(!r.ok)return r;return ok({text:r.data.choices?.[0]?.message?.content||"",usage:r.data.usage,model:r.data.model});}const input=(o.messages||[]).map(m=>({role:m.role,content:String(m.content||"")}));const r=await jsonRequest(base+"/responses",{headers:{authorization:"Bearer "+key},body:{model:o.model||process.env.OPENAI_MODEL||"gpt-5",input,tools:o.tools,stream:false},signal:o.signal,fetchImpl:o.fetchImpl});if(!r.ok)return r;const text=(r.data.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==="output_text").map(x=>x.text).join("");return ok({text,usage:r.data.usage,model:r.data.model,toolCalls:(r.data.output||[]).filter(x=>x.type==="function_call")});}module.exports={id:"openai",capabilities:{chat:true,tools:true,streaming:true},healthCheck:async()=>({ok:!!process.env.OPENAI_API_KEY,mode:"config"}),completion};\n`;
  const gemini=`"use strict";const {jsonRequest}=require("./_common");const {ok,fail}=require("../shared/result-envelope");async function completion(o={}){const key=process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY;if(!key)return fail("E_AUTH","GEMINI_API_KEY/GOOGLE_API_KEY eksik");const base=(o.baseUrl||"https://generativelanguage.googleapis.com/v1beta").replace(/\\/$/,"");const model=o.model||process.env.GEMINI_MODEL||"gemini-3.5-flash";if(!o.legacy){const r=await jsonRequest(base+"/interactions",{headers:{"x-goog-api-key":key},body:{model,input:(o.messages||[]).map(m=>({role:m.role,content:String(m.content||"")})),store:false,tools:o.tools},signal:o.signal,fetchImpl:o.fetchImpl});if(r.ok)return ok({text:r.data.output_text||"",usage:r.data.usage,model:r.data.model||model,steps:r.data.steps||[]});if(!o.allowLegacyFallback)return r;}const r=await jsonRequest(base+"/models/"+encodeURIComponent(model)+":generateContent",{headers:{"x-goog-api-key":key},body:{contents:(o.messages||[]).filter(m=>m.role!=="system").map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:String(m.content||"")}]})),system_instruction:{parts:(o.messages||[]).filter(m=>m.role==="system").map(m=>({text:String(m.content||"")}))}},signal:o.signal,fetchImpl:o.fetchImpl});if(!r.ok)return r;return ok({text:(r.data.candidates?.[0]?.content?.parts||[]).map(x=>x.text||"").join(""),usage:r.data.usageMetadata,model});}module.exports={id:"gemini",capabilities:{chat:true,tools:true,streaming:true,vision:true},healthCheck:async()=>({ok:!!(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY),mode:"config"}),completion};\n`;
  const anthropic=`"use strict";const {jsonRequest}=require("./_common");const {ok,fail}=require("../shared/result-envelope");async function completion(o={}){const key=process.env.ANTHROPIC_API_KEY;if(!key)return fail("E_AUTH","ANTHROPIC_API_KEY eksik");const msgs=(o.messages||[]).filter(m=>m.role!=="system").map(m=>({role:m.role==="assistant"?"assistant":"user",content:m.content}));const r=await jsonRequest((o.baseUrl||"https://api.anthropic.com/v1")+"/messages",{headers:{"x-api-key":key,"anthropic-version":"2023-06-01"},body:{model:o.model||process.env.ANTHROPIC_MODEL||"claude-sonnet-4-5",system:(o.messages||[]).filter(m=>m.role==="system").map(m=>m.content).join("\\n"),messages:msgs,max_tokens:o.maxTokens||2048,tools:o.tools},signal:o.signal,fetchImpl:o.fetchImpl});if(!r.ok)return r;return ok({text:(r.data.content||[]).filter(x=>x.type==="text").map(x=>x.text).join(""),toolCalls:(r.data.content||[]).filter(x=>x.type==="tool_use"),usage:r.data.usage,model:r.data.model});}module.exports={id:"anthropic",capabilities:{chat:true,tools:true,streaming:true},healthCheck:async()=>({ok:!!process.env.ANTHROPIC_API_KEY,mode:"config"}),completion};\n`;
  function compatible(id,keyNames,baseEnv,modelEnv,defaultBase,defaultModel,extra=""){return `"use strict";const {jsonRequest}=require("./_common");const {ok,fail}=require("../shared/result-envelope");async function completion(o={}){const key=${keyNames.map(k=>`process.env.${k}`).join("||")};if(!key)return fail("E_AUTH","API anahtarı eksik");const model=o.model||process.env.${modelEnv}||"${defaultModel}";const warning=${id==="deepseek"?`["deepseek-chat","deepseek-reasoner"].includes(model)?"legacy model adı kullanım dışı kalıyor":null`:"null"};const r=await jsonRequest(((o.baseUrl||process.env.${baseEnv}||"${defaultBase}").replace(/\\/$/,""))+"/chat/completions",{headers:{authorization:"Bearer "+key},body:{model,messages:o.messages,tools:o.tools,response_format:o.jsonMode?{type:"json_object"}:undefined,max_tokens:o.maxTokens${extra}},signal:o.signal,fetchImpl:o.fetchImpl});if(!r.ok)return r;const m=r.data.choices?.[0]?.message||{};return ok({text:m.content||"",reasoning:m.reasoning_content||null,toolCalls:m.tool_calls||[],usage:r.data.usage,model:r.data.model||model,warning});}module.exports={id:"${id}",capabilities:{chat:true,tools:true,streaming:true},healthCheck:async()=>({ok:!!(${keyNames.map(k=>`process.env.${k}`).join("||")}),mode:"config"}),completion};\n`;}
  const local=`"use strict";const {jsonRequest}=require("./_common");const {ok,fail}=require("../shared/result-envelope");function allowed(url){const u=new URL(url);return["localhost","127.0.0.1","::1","[::1]"].includes(u.hostname)||process.env.LOCAL_LLM_ALLOW_REMOTE==="1";}async function completion(o={}){const base=(o.baseUrl||process.env.LOCAL_LLM_BASE_URL||"http://127.0.0.1:1234/v1").replace(/\\/$/,"");if(!allowed(base))return fail("E_PERMISSION","Uzak local endpoint için opt-in gerekli");const headers={};if(process.env.LOCAL_LLM_API_KEY)headers.authorization="Bearer "+process.env.LOCAL_LLM_API_KEY;const r=await jsonRequest(base+"/chat/completions",{headers,body:{model:o.model||process.env.LOCAL_LLM_MODEL||"local-model",messages:o.messages,max_tokens:o.maxTokens},signal:o.signal,fetchImpl:o.fetchImpl});if(!r.ok)return r;return ok({text:r.data.choices?.[0]?.message?.content||"",usage:r.data.usage,model:r.data.model});}module.exports={id:"local-openai-compatible",local:true,capabilities:{chat:true,tools:true},healthCheck:async()=>({ok:true,mode:"config"}),completion};\n`;
  return{"src/providers/_common.js":common,"src/providers/openai.js":openai,"src/providers/gemini.js":gemini,"src/providers/anthropic.js":anthropic,"src/providers/deepseek.js":compatible("deepseek",["DEEPSEEK_API_KEY"],"DEEPSEEK_BASE_URL","DEEPSEEK_MODEL","https://api.deepseek.com","deepseek-v4-flash",`,thinking:o.thinking,reasoning_effort:o.reasoningEffort`),"src/providers/kimi.js":compatible("kimi",["KIMI_API_KEY","MOONSHOT_API_KEY"],"KIMI_BASE_URL","KIMI_MODEL","https://api.moonshot.ai/v1","kimi-k2.5"),"src/providers/local-openai-compatible.js":local,"src/providers/provider-contract.js":`"use strict";module.exports={required:["id","capabilities","healthCheck","completion"]};\n`,"src/providers/provider-router.js":`"use strict";module.exports=require("../features/provider-router");\n`};
}

module.exports={sharedFiles,featureFiles,hostFiles,providerFiles};
