"use strict";

function algorithmFiles() {
  const index = String.raw`"use strict";
module.exports = Object.assign(
  {},
  require("./repository"),
  require("./quality"),
  require("./architecture"),
  require("./release")
);
`;

  const repository = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scan } = require("../file-scanner");
const { words, tokensRough, lineColumn } = require("../text-utils");
const { scanSecrets } = require("../secret-redaction");

function read(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > (maxBytes || 2_000_000)) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
function safeFiles(input) {
  if (Array.isArray(input.files)) return input.files;
  if (!input.root) return [];
  return scan(input.root, { maxFiles: input.maxFiles || 10_000, signal: input.signal }).filter((item) => !item.binary);
}
function escapeRegex(value) {
  return String(value).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}
async function repositoryMap(input) {
  const files = safeFiles(input);
  const byExt = {};
  const byLanguage = {};
  const manifests = [];
  const language = { ".js":"JavaScript", ".ts":"TypeScript", ".tsx":"TSX", ".py":"Python", ".cs":"C#", ".java":"Java", ".go":"Go", ".rs":"Rust", ".json":"JSON", ".md":"Markdown" };
  let totalBytes = 0;
  for (const item of files) {
    byExt[item.ext || "none"] = (byExt[item.ext || "none"] || 0) + 1;
    const lang = language[item.ext] || "Other";
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
    totalBytes += item.size || 0;
    if (["package.json","pyproject.toml","Cargo.toml","go.mod","pom.xml","build.gradle","requirements.txt"].includes(path.basename(item.path))) manifests.push(item.path);
  }
  return { fileCount: files.length, totalBytes, byExt, byLanguage, manifests, largest: files.slice().sort((a,b)=>(b.size||0)-(a.size||0)).slice(0,20).map((item)=>({path:item.path,size:item.size})) };
}
async function contextBuilder(input) {
  const taskWords = words(input.task || "");
  const active = new Set(input.activeFiles || []);
  const dirty = new Set(input.dirtyFiles || []);
  const budget = input.tokenBudget || 6000;
  const scored = [];
  for (const item of safeFiles(input)) {
    const filePath = item.absolute || (input.root ? path.join(input.root, item.path) : item.path);
    const text = read(filePath, input.maxFileBytes || 500_000);
    if (!text) continue;
    let score = 0;
    const reasons = [];
    if (active.has(item.path)) { score += 30; reasons.push("active"); }
    if (dirty.has(item.path)) { score += 20; reasons.push("dirty"); }
    for (const word of taskWords) {
      if (item.path.toLowerCase().includes(word)) { score += 8; reasons.push("path:" + word); }
      const matches = text.toLowerCase().match(new RegExp(escapeRegex(word), "g")) || [];
      if (matches.length) { score += Math.min(10, matches.length); reasons.push("content:" + word); }
    }
    scored.push({ path:item.path, score, reasons, tokens:tokensRough(text) });
  }
  scored.sort((a,b)=>b.score-a.score);
  const picked = [];
  let usedTokens = 0;
  for (const item of scored) {
    if (usedTokens + item.tokens > budget) continue;
    picked.push(item);
    usedTokens += item.tokens;
    if (picked.length >= (input.maxContextFiles || 30)) break;
  }
  return { picked, usedTokens, budget, omitted:scored.length-picked.length };
}
async function codeReview(input) {
  const rules = [
    ["eval","high",/\beval\s*\(/g],
    ["new-function","high",/new\s+Function\s*\(/g],
    ["empty-catch","medium",/catch\s*\([^)]*\)\s*\{\s*\}/g],
    ["inner-html","high",/\.innerHTML\s*=/g],
    ["node-integration","critical",/nodeIntegration\s*:\s*true/g],
    ["context-isolation-off","critical",/contextIsolation\s*:\s*false/g],
    ["sandbox-off","high",/sandbox\s*:\s*false/g],
    ["web-security-off","critical",/webSecurity\s*:\s*false/g],
    ["insecure-content","critical",/allowRunningInsecureContent\s*:\s*true/g],
    ["sync-io","low",/\b(?:fs\.)?(?:readFileSync|writeFileSync|readdirSync|statSync)\s*\(/g]
  ];
  const findings = [];
  for (const file of input.files || []) {
    const source = read(file);
    const lines = source.split(/\r?\n/);
    for (const [rule,severity,regex] of rules) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(source))) {
        const position = lineColumn(source, match.index);
        findings.push({ file, rule, severity, line:position.line, column:position.column, snippet:(lines[position.line-1]||"").trim().slice(0,240), confidence:rule === "sync-io" ? 0.7 : 0.92 });
        if (!match[0].length) regex.lastIndex += 1;
      }
    }
  }
  return { findings, summary:findings.reduce((acc,item)=>{acc[item.severity]=(acc[item.severity]||0)+1;return acc;},{}) };
}
function exportedSymbols(source) {
  const result = new Set();
  const expressions = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+const\s+(\w+)/g,
    /(?:module\.exports|exports)\.(\w+)\s*=/g,
    /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g
  ];
  for (const regex of expressions) {
    let match;
    while ((match = regex.exec(source))) result.add(match[1]);
  }
  const objectExport = /module\.exports\s*=\s*\{([^}]+)\}/g;
  let objectMatch;
  while ((objectMatch = objectExport.exec(source))) {
    objectMatch[1].split(",").map((item)=>item.split(":")[0].trim()).filter(Boolean).forEach((name)=>result.add(name));
  }
  return Array.from(result);
}
async function testGenerator(input) {
  const results = [];
  for (const file of input.files || []) {
    const source = read(file);
    const symbols = exportedSymbols(source);
    const framework = /from ["']vitest|\bvi\.|describe\(/.test(source) ? "vitest" : /\bjest\.|expect\(/.test(source) ? "jest" : /pytest/.test(source) ? "pytest" : /node:test/.test(source) ? "node:test" : (input.framework || "node:test");
    results.push({ file, framework, symbols, importSuggestion:framework === "pytest" ? "from module import symbol" : "const { symbol } = require('./module')", cases:symbols.flatMap((symbol)=>[
      {symbol,kind:"happy",title:symbol+" geçerli girdide çalışır"},
      {symbol,kind:"boundary",title:symbol+" sınır girdisini yönetir"},
      {symbol,kind:"error",title:symbol+" geçersiz girdiyi reddeder"},
      {symbol,kind:"security",title:symbol+" zararlı girdiyi sınırlar"}
    ]) });
  }
  return { results };
}
async function bugFixPlanner(input) {
  const text = [input.stack,input.log,input.diff].filter(Boolean).join("\n");
  const rootCauses = [];
  if (/ENOENT/.test(text)) rootCauses.push({cause:"dosya yolu veya cwd",confidence:0.9});
  if (/EACCES|EPERM/.test(text)) rootCauses.push({cause:"izin veya kilit",confidence:0.9});
  if (/Cannot read propert|undefined/.test(text)) rootCauses.push({cause:"null/undefined guard",confidence:0.82});
  if (/npm warn deprecated/i.test(text) && !/(ERR!|exit code [1-9])/i.test(text)) rootCauses.push({cause:"uyarı hata sanılıyor",confidence:0.94});
  if (/out of memory|exit code 137/i.test(text)) rootCauses.push({cause:"bellek tükenmesi",confidence:0.95});
  if (!rootCauses.length) rootCauses.push({cause:"kanıt yetersiz; hedefli log gerekli",confidence:0.3});
  return { reproduction:input.repro||["Aynı komutu temiz klasörde çalıştır","Exit code ve ilk gerçek error satırını kaydet","Önce/sonra dosya hashlerini karşılaştır"], rootCauses, minimalFix:"En dar davranış değişikliğini uygula; önce başarısız regresyon testi yaz.", targetTests:["regression","fault-injection","rollback"], rollback:"Checkpoint/backup hash doğrulamasıyla önceki sürüme dön." };
}
async function dependencyAuditor(input) {
  const root = input.root || process.cwd();
  const packagePath = path.join(root,"package.json");
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(packagePath,"utf8")); } catch { return { issues:[{severity:"high",code:"PACKAGE_MISSING"}], dependencies:[], locks:[] }; }
  const locks = ["package-lock.json","pnpm-lock.yaml","yarn.lock","bun.lock","bun.lockb"].filter((name)=>fs.existsSync(path.join(root,name)));
  const issues = [];
  if (locks.length !== 1) issues.push({severity:"medium",code:"LOCKFILE_COUNT",locks});
  const dependencies = Object.assign({},pkg.dependencies||{},pkg.devDependencies||{});
  for (const [name,raw] of Object.entries(dependencies)) {
    const version = String(raw);
    if (version === "*" || version === "latest") issues.push({severity:"high",code:"UNPINNED",package:name,version});
    if (/^(git|github:|https?:)/.test(version)) issues.push({severity:"medium",code:"REMOTE_DEP",package:name,version});
    if (/electron|node-gyp|better-sqlite3|sharp/.test(name)) issues.push({severity:"info",code:"NATIVE_ABI",package:name});
  }
  return { dependencies:Object.entries(dependencies).map(([name,version])=>({name,version})), locks, issues };
}
async function documentationGenerator(input) {
  const root = input.root || process.cwd();
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")); } catch {}
  const projectFiles = fs.existsSync(root) ? scan(root,{maxFiles:5000}) : [];
  const has = (name) => projectFiles.some((item)=>item.path===name || item.path.endsWith("/"+name));
  const scripts = pkg.scripts || {};
  const sections = ["# "+(pkg.name||path.basename(root)),pkg.description||"","## Kurulum","```bat","npm install","```","## Komutlar"];
  for (const [name,command] of Object.entries(scripts)) sections.push("- npm run "+name+": "+command);
  sections.push("## Algılanan Yapı");
  sections.push("- Electron: "+Boolean(pkg.dependencies?.electron||pkg.devDependencies?.electron));
  sections.push("- Preload: "+has("preload.js"));
  sections.push("- Test: "+Boolean(scripts.test));
  return { markdown:sections.join("\n"), detected:{electron:Boolean(pkg.dependencies?.electron||pkg.devDependencies?.electron),preload:has("preload.js"),tests:Boolean(scripts.test)} };
}
async function changelogBuilder(input) {
  const groups = {Added:[],Changed:[],Fixed:[],Security:[],Performance:[],Migration:[],"Known Issues":[]};
  for (const commit of input.commits || []) {
    const message = String(commit.message || "");
    const lower = message.toLowerCase();
    const group = /^feat|add/.test(lower) ? "Added" : /^fix|bug/.test(lower) ? "Fixed" : /security|secret|xss|csp/.test(lower) ? "Security" : /perf|optimi/.test(lower) ? "Performance" : /migrat|breaking/.test(lower) ? "Migration" : /known/.test(lower) ? "Known Issues" : "Changed";
    groups[group].push(message);
  }
  const output = ["## "+(input.version||"Unreleased")];
  for (const [name,items] of Object.entries(groups)) if (items.length) output.push("","### "+name,...items.map((item)=>"- "+item));
  return { groups, markdown:output.join("\n") };
}
async function commitMessageAssistant(input) {
  const diff = input.diff || "";
  const type = /test/.test(diff) ? "test" : /README|docs\//i.test(diff) ? "docs" : /fix|error|bug/i.test(diff) ? "fix" : /package(?:-lock)?\.json/.test(diff) ? "chore" : "feat";
  const scope = input.scope ? "("+input.scope+")" : "";
  return { message:type+scope+": "+String(input.subject||"değişikliği uygula").slice(0,72)+(input.requirementId?"\n\nRefs: "+input.requirementId:"") };
}
async function promptLibrary(input) {
  const file = path.resolve(input.file || "prompts.json");
  let store = {prompts:[]};
  try { store = JSON.parse(fs.readFileSync(file,"utf8")); } catch {}
  const action = input.action || "list";
  if (action === "list") return store;
  if (action === "add") {
    const body = String(input.body || "");
    const secrets = scanSecrets(body);
    const item = { id:input.id||crypto.randomUUID(), title:input.title||"Başlıksız", body:secrets.length?"[REDACTED]":body, tags:input.tags||[], version:1, createdAt:new Date().toISOString() };
    store.prompts.push(item);
    const temp = file+".tmp";
    fs.writeFileSync(temp,JSON.stringify(store,null,2));
    fs.renameSync(temp,file);
    return {item,secrets:secrets.length};
  }
  if (action === "remove") { store.prompts=store.prompts.filter((item)=>item.id!==input.id);fs.writeFileSync(file,JSON.stringify(store,null,2));return{removed:input.id}; }
  if (action === "export") return {data:store};
  if (action === "import") { fs.writeFileSync(file,JSON.stringify(input.data||{prompts:[]},null,2));return{imported:true}; }
  throw new Error("Bilinmeyen action");
}
module.exports = {
  "repository-map":repositoryMap,
  "context-builder":contextBuilder,
  "code-review":codeReview,
  "test-generator":testGenerator,
  "bug-fix-planner":bugFixPlanner,
  "dependency-auditor":dependencyAuditor,
  "documentation-generator":documentationGenerator,
  "changelog-builder":changelogBuilder,
  "commit-message-assistant":commitMessageAssistant,
  "prompt-library":promptLibrary
};
`;

  const quality = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { scan } = require("../file-scanner");
const { lineColumn } = require("../text-utils");
const { scanSecrets, redact } = require("../secret-redaction");
function read(file,maxBytes){try{if(fs.statSync(file).size>(maxBytes||2_000_000))return"";return fs.readFileSync(file,"utf8");}catch{return"";}}
function escapeRegex(value){return String(value).replace(/[.*+?^$(){}|[\]\\]/g,"\\$&");}
async function fileSummarizer(input){const results=[];for(const file of input.files||[]){const source=read(file);const imports=Array.from(source.matchAll(/(?:require\(["']([^"']+)|from\s+["']([^"']+)|import\s+["']([^"']+))/g)).map((m)=>m[1]||m[2]||m[3]);const symbols=Array.from(source.matchAll(/(?:function|class|const|let)\s+(\w+)/g)).map((m)=>m[1]);const publicApi=Array.from(source.matchAll(/(?:exports\.(\w+)|export\s+(?:function|class|const)\s+(\w+))/g)).map((m)=>m[1]||m[2]);const todos=Array.from(source.matchAll(/\b(TODO|FIXME|HACK)\b[: ]*(.*)/gi)).map((m)=>({tag:m[1],text:m[2].trim()}));results.push({file,lines:source.split(/\r?\n/).length,complexity:(source.match(/\b(if|for|while|switch|case|catch)\b/g)||[]).length,imports:Array.from(new Set(imports)),symbols:Array.from(new Set(symbols)).slice(0,200),publicApi:Array.from(new Set(publicApi)),todos});}return{results};}
async function localSearch(input){if(!input.root)return{matches:[],truncated:false};if(String(input.query||"").length>300)throw new Error("pattern uzun");if(input.regex&&/(?:\(.+\)){5,}|\*\+|\+\*/.test(input.query))throw new Error("karmaşık regex");const flags=input.caseSensitive?"":"i";const expression=input.regex?String(input.query):escapeRegex(input.query||"");const regex=new RegExp(expression,flags);const matches=[];for(const item of scan(input.root,{maxFiles:input.maxFiles||10000,signal:input.signal})){if(item.binary||item.size>(input.maxFileBytes||1_000_000))continue;if(input.ext?.length&&!input.ext.includes(item.ext))continue;if(input.pathIncludes&&!item.path.includes(input.pathIncludes))continue;const lines=read(item.absolute).split(/\r?\n/);for(let index=0;index<lines.length;index++){regex.lastIndex=0;if(regex.test(lines[index])){matches.push({file:item.path,line:index+1,snippet:lines.slice(Math.max(0,index-(input.context||1)),index+(input.context||1)+1).join("\n")});if(matches.length>=(input.maxResults||200))return{matches,truncated:true};}}}return{matches,truncated:false};}
async function diffExplainer(input){const diff=String(input.diff||"");return{files:Array.from(diff.matchAll(/^\+\+\+ b\/(.+)$/gm)).map((m)=>m[1]),added:(diff.match(/^\+[^+]/gm)||[]).length,removed:(diff.match(/^-[^-]/gm)||[]).length,behavior:/return|throw|if\s*\(|switch/.test(diff),security:/(innerHTML|eval|token|secret|password|webSecurity)/i.test(diff),migration:/ALTER TABLE|CREATE TABLE|schema|migration/i.test(diff),tests:/test|spec/i.test(diff),rollback:"Base hash ve checkpoint doğrulamasıyla geri al"};}
function severity(line){return/fatal|panic|uncaught|segfault/i.test(line)?"critical":/error|failed|exception/i.test(line)?"high":/warn|deprecated/i.test(line)?"medium":"info";}
async function logAnalyzer(input){const lines=input.lines||String(input.text||"").split(/\r?\n/);const clusters=new Map();for(const raw of lines){if(!raw.trim())continue;const timestamp=raw.match(/\d{4}-\d{2}-\d{2}[T ][\d:.+\-Z]+/)?.[0]||null;let signature=raw.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.+\-Z]+/g,"<TS>").replace(/\bpid[=: ]?\d+/gi,"pid=<N>").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,"<GUID>").replace(/0x[0-9a-f]+/gi,"<HEX>").replace(/:\d{2,5}\b/g,":<PORT>").replace(/([A-Za-z]:)?[\\/](?:[^\s:]+[\\/])+([^\\/\s:]+)/g,"<PATH>/$2").slice(0,300);const current=clusters.get(signature)||{signature,count:0,firstSeen:timestamp,lastSeen:timestamp,severity:severity(raw),samples:[]};current.count+=1;current.lastSeen=timestamp||current.lastSeen;if(current.samples.length<3)current.samples.push(redact(raw).text);clusters.set(signature,current);}return{clusters:Array.from(clusters.values()).sort((a,b)=>b.count-a.count)};}
async function apiContractReview(input){const issues=[];function inspect(schema,prefix,seen){if(!schema||typeof schema!=="object"||seen.has(schema))return;seen.add(schema);if(schema.type==="object"){for(const key of schema.required||[])if(!schema.properties?.[key])issues.push({severity:"high",path:prefix,code:"REQUIRED_MISSING",key});if(schema.additionalProperties===undefined)issues.push({severity:"low",path:prefix,code:"ADDITIONAL_UNSPECIFIED"});for(const[key,value]of Object.entries(schema.properties||{}))inspect(value,prefix+"."+key,seen);}if(schema.enum&&!schema.enum.length)issues.push({severity:"medium",path:prefix,code:"EMPTY_ENUM"});}inspect(input.schema,"$",new Set());for(const[route,item]of Object.entries(input.openapi?.paths||{}))for(const[method,operation]of Object.entries(item||{}))if(["get","post","put","patch","delete"].includes(method)&&!operation.responses)issues.push({severity:"high",path:route+":"+method,code:"RESPONSES_MISSING"});if(input.before&&input.after)for(const key of input.before.required||[])if(!(input.after.required||[]).includes(key))issues.push({severity:"high",code:"BREAKING_REQUIRED_REMOVED",key});if(input.ipc&&!input.ipc.requestId)issues.push({severity:"medium",code:"IPC_REQUEST_ID_MISSING"});return{issues};}
async function secretScanner(input){const findings=[];for(const file of input.files||[])for(const finding of scanSecrets(read(file)))findings.push(Object.assign({file},finding));return{findings};}
function classifyLicense(value){const text=String(value||"").toUpperCase();if(/MIT|APACHE|BSD|ISC|UNLICENSE/.test(text))return"permissive";if(/LGPL|MPL|EPL/.test(text))return"weak-copyleft";if(/AGPL|GPL/.test(text))return"strong-copyleft";if(/BUSL|SSPL|ELASTIC|COMMERCIAL/.test(text))return"commercial";return"unknown";}
async function licenseScanner(input){const root=input.root||process.cwd();let pkg={};try{pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));}catch{}const dependencies=Object.keys(Object.assign({},pkg.dependencies||{},pkg.devDependencies||{}));const results=[];for(const name of dependencies){let license=null;try{license=JSON.parse(fs.readFileSync(path.join(root,"node_modules",name,"package.json"),"utf8")).license;}catch{}results.push({name,license,category:classifyLicense(license)});}return{results,summary:results.reduce((acc,item)=>{acc[item.category]=(acc[item.category]||0)+1;return acc;},{}),disclaimer:"Hukuki tavsiye değildir."};}
async function performanceHints(input){const rules=[["sync-io",/\b(?:readFileSync|writeFileSync|readdirSync|statSync)\s*\(/g],["listener",/\.(?:on|addEventListener)\s*\(/g],["interval",/setInterval\s*\(/g],["large-ipc",/ipc(?:Main|Renderer)\.[a-z]+\s*\([^)]{300,}/g],["loop-io",/(?:for|while)\s*\([\s\S]{0,300}(?:readFile|stat)\s*\(/g]];const findings=[];for(const file of input.files||[]){const source=read(file);for(const[id,regex]of rules){regex.lastIndex=0;let match;while((match=regex.exec(source)))findings.push(Object.assign({file,id},lineColumn(source,match.index)));}}return{findings};}
async function refactorPlanner(input){const descriptions=["Baseline davranış testini sabitle","Saf yardımcıları ayır","Yan etkileri servis sınırına taşı","State ownership netleştir","IPC sözleşmesini daralt","Hedefli testleri taşı","Ölü kodu temizle"];return{target:input.target||"hedef",steps:descriptions.map((description,index)=>({order:index+1,description,rollback:"önceki commit/checkpoint"})),reversible:true};}
async function workspaceDoctor(input){const root=input.root||process.cwd();const checks=[];const exists=(name)=>fs.existsSync(path.join(root,name));let pkg={};try{pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));}catch{}const projectFiles=fs.existsSync(root)?scan(root,{maxFiles:3000}):[];const html=projectFiles.filter((item)=>item.ext===".html"&&!item.binary).map((item)=>read(item.absolute)).join("\n");const allText=projectFiles.filter((item)=>!item.binary&&item.size<500_000).map((item)=>read(item.absolute)).join("\n");checks.push({id:"node",ok:Number(process.versions.node.split(".")[0])>=20,value:process.versions.node});checks.push({id:"package",ok:exists("package.json")});const locks=["package-lock.json","pnpm-lock.yaml","yarn.lock","bun.lock","bun.lockb"].filter(exists);checks.push({id:"single-lock",ok:locks.length===1,value:locks});checks.push({id:"electron",ok:Boolean(pkg.dependencies?.electron||pkg.devDependencies?.electron)});checks.push({id:"builder",ok:Boolean(pkg.devDependencies?.["electron-builder"]||pkg.dependencies?.["electron-builder"])});checks.push({id:"test-script",ok:Boolean(pkg.scripts?.test)});checks.push({id:"csp",ok:/Content-Security-Policy/i.test(html)});checks.push({id:"preload",ok:projectFiles.some((item)=>/preload/i.test(item.path))});checks.push({id:"mojibake",ok:!/[ÃÄÅ�]/.test(allText)});checks.push({id:"windows-build",ok:Boolean(pkg.scripts?.dist||pkg.scripts?.build)});const env=["OPENAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","ANTHROPIC_API_KEY","DEEPSEEK_API_KEY","KIMI_API_KEY","MOONSHOT_API_KEY","LOCAL_LLM_BASE_URL"].map((name)=>({name,set:Boolean(process.env[name])}));return{checks,env,summary:{passed:checks.filter((item)=>item.ok).length,total:checks.length}};}
module.exports={"file-summarizer":fileSummarizer,"local-search":localSearch,"diff-explainer":diffExplainer,"log-analyzer":logAnalyzer,"api-contract-review":apiContractReview,"secret-scanner":secretScanner,"license-scanner":licenseScanner,"performance-hints":performanceHints,"refactor-planner":refactorPlanner,"workspace-doctor":workspaceDoctor};
`;

  const architecture = String.raw`"use strict";
const fs=require("node:fs");const path=require("node:path");const crypto=require("node:crypto");const {scan}=require("../file-scanner");const {lineColumn}=require("../text-utils");
function read(file,maxBytes){try{if(fs.statSync(file).size>(maxBytes||2_000_000))return"";return fs.readFileSync(file,"utf8");}catch{return"";}}
function moduleImports(source,extension){const output=[];const expressions=extension===".py"?[/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm]:extension===".cs"?[/^\s*using\s+([\w.]+);/gm]:extension===".java"?[/^\s*import\s+([\w.]+);/gm]:[/(?:require\(["']([^"']+)|from\s+["']([^"']+)|import\s+["']([^"']+))/g];for(const expression of expressions){let match;while((match=expression.exec(source)))output.push(match[1]||match[2]||match[3]);}return output;}
async function architectureGraph(input){if(!input.root)return{nodes:[],edges:[],cycles:[],highFanIn:[],highFanOut:[]};const nodes=[],edges=[];for(const item of scan(input.root,{maxFiles:input.maxFiles||10000}).filter((entry)=>!entry.binary)){if(!/[.](?:js|ts|tsx|jsx|py|cs|java)$/.test(item.path))continue;nodes.push({id:item.path,size:item.size});for(const target of moduleImports(read(item.absolute),item.ext))edges.push({from:item.path,to:target});}const inbound={},outbound={},adjacent={};for(const edge of edges){inbound[edge.to]=(inbound[edge.to]||0)+1;outbound[edge.from]=(outbound[edge.from]||0)+1;(adjacent[edge.from]||=[]).push(edge.to);}const cycles=[];function walk(node,stack){if(stack.includes(node)){cycles.push(stack.slice(stack.indexOf(node)).concat(node));return;}if(stack.length>20)return;for(const target of adjacent[node]||[])if(adjacent[target])walk(target,stack.concat(node));}for(const node of nodes.slice(0,1000))walk(node.id,[]);return{nodes,edges,cycles:Array.from(new Set(cycles.map(JSON.stringify))).map(JSON.parse).slice(0,100),highFanIn:Object.entries(inbound).sort((a,b)=>b[1]-a[1]).slice(0,20),highFanOut:Object.entries(outbound).sort((a,b)=>b[1]-a[1]).slice(0,20)};}
async function deadCodeDetector(input){const root=input.root||process.cwd();if(!fs.existsSync(root))return{candidates:[],warning:"Workspace yok"};const files=scan(root,{maxFiles:10000}).filter((item)=>!item.binary&&/[.](?:js|ts|tsx|jsx)$/.test(item.path));const used=new Set(),provided=new Map(),entrypoints=new Set(input.entrypoints||["index.js","main.js","src/index.js","src/main.js"]);for(const item of files){const source=read(item.absolute);provided.set(item.path,Array.from(source.matchAll(/(?:export\s+(?:function|class|const)\s+|exports\.|module\.exports\.)(\w+)/g)).map((match)=>match[1]));for(const target of moduleImports(source,item.ext))used.add(target);}const candidates=[];for(const[file,symbols]of provided)for(const symbol of symbols)if(!entrypoints.has(file)&&!Array.from(used).some((target)=>target.includes(path.basename(file,path.extname(file))))candidates.push({file,symbol,confidence:read(path.join(root,file)).includes("import(")?0.35:0.72,reason:"import graph'ta erişilemiyor"});return{candidates,warning:"Dinamik import ve reflection nedeniyle otomatik silme yapılmaz."};}
function normalizedTokens(source){return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm,"").replace(/["'`][^"'`]*["'`]/g,"STR").split(/[^A-Za-z0-9_]+/).filter(Boolean);}
async function duplicateCodeFinder(input){if(!input.root)return{matches:[]};const minimum=input.minLines||6,threshold=input.threshold||0.8,blocks=[];for(const item of scan(input.root,{maxFiles:5000}).filter((entry)=>!entry.binary&&entry.size<1_000_000)){const lines=read(item.absolute).split(/\r?\n/);for(let index=0;index+minimum<=lines.length;index+=Math.max(1,Math.floor(minimum/2))){const tokens=normalizedTokens(lines.slice(index,index+minimum).join("\n"));if(tokens.length<4)continue;blocks.push({file:item.path,line:index+1,set:new Set(tokens),hash:crypto.createHash("sha1").update(tokens.join(" ")).digest("hex")});}}const matches=[];for(let left=0;left<blocks.length;left++)for(let right=left+1;right<blocks.length&&right<left+500;right++){if(blocks[left].file===blocks[right].file)continue;const intersection=Array.from(blocks[left].set).filter((token)=>blocks[right].set.has(token)).length;const similarity=blocks[left].hash===blocks[right].hash?1:intersection/Math.max(blocks[left].set.size,blocks[right].set.size);if(similarity>=threshold)matches.push({a:{file:blocks[left].file,line:blocks[left].line},b:{file:blocks[right].file,line:blocks[right].line},similarity});}return{matches:matches.sort((a,b)=>b.similarity-a.similarity).slice(0,input.maxResults||200)};}
async function migrationPlanner(input){const before=input.before||{},after=input.after||{},steps=[],warnings=[];for(const key of Object.keys(after))if(!(key in before))steps.push({type:"add",path:key,preflight:"default/nullability kontrolü",rollback:"alanı kaldır"});for(const key of Object.keys(before))if(!(key in after)){steps.push({type:"remove",path:key,preflight:"kullanım ve veri sayımı",rollback:"backup'tan geri yükle"});warnings.push({severity:"high",path:key,code:"DATA_LOSS"});}for(const key of Object.keys(after))if(key in before&&JSON.stringify(before[key])!==JSON.stringify(after[key]))steps.push({type:"change",path:key,from:before[key],to:after[key],preflight:"cast/constraint kontrolü",rollback:"önceki şema"});return{engine:input.engine||"generic",steps:steps.map((step,index)=>Object.assign({order:index+1},step)),warnings,backupRequired:steps.length>0,transactionRecommended:true};}
async function ipcContractAuditor(input){const channels={main:new Map(),preload:new Map(),renderer:new Map()},findings=[];for(const file of input.files||[]){const source=read(file);for(const match of source.matchAll(/ipcMain\.(handle|on)\s*\(\s*["']([^"']+)/g))channels.main.set(match[2],{file,kind:match[1]});for(const match of source.matchAll(/ipcRenderer\.(invoke|send)\s*\(\s*["']([^"']+)/g))channels.renderer.set(match[2],{file,kind:match[1]});for(const match of source.matchAll(/(?:exposeInMainWorld|contextBridge)[\s\S]{0,1000}?["']([^"']+)["']/g))channels.preload.set(match[1],{file});if(/invoke\s*:\s*\(channel/.test(source))findings.push({severity:"critical",file,code:"GENERIC_INVOKE"});if(/ipcMain\.(handle|on)/.test(source)&&!/sender|webContents|frame/.test(source))findings.push({severity:"medium",file,code:"SENDER_VALIDATION_MISSING"});}for(const channel of channels.renderer.keys())if(!channels.main.has(channel))findings.push({severity:"high",channel,code:"ORPHAN_RENDERER"});for(const channel of channels.main.keys())if(!channels.renderer.has(channel))findings.push({severity:"low",channel,code:"UNUSED_MAIN"});return{channels:Object.fromEntries(Object.entries(channels).map(([name,map])=>[name,Object.fromEntries(map)])),findings};}
async function electronSecurityAuditor(input){const rules=[["NODE_INTEGRATION","critical",/nodeIntegration\s*:\s*true/g],["CONTEXT_ISOLATION","critical",/contextIsolation\s*:\s*false/g],["SANDBOX","high",/sandbox\s*:\s*false/g],["WEB_SECURITY","critical",/webSecurity\s*:\s*false/g],["INSECURE_CONTENT","critical",/allowRunningInsecureContent\s*:\s*true/g],["REMOTE_MODULE","high",/(?:enableRemoteModule|@electron\/remote)/g]],findings=[];let combined="";for(const file of input.files||[]){const source=read(file);combined+=source;for(const[code,severity,regex]of rules){regex.lastIndex=0;let match;while((match=regex.exec(source)))findings.push(Object.assign({file,code,severity},lineColumn(source,match.index)));}}if(!/setWindowOpenHandler/.test(combined))findings.push({code:"WINDOW_OPEN_POLICY",severity:"medium"});if(!/will-navigate/.test(combined))findings.push({code:"NAVIGATION_POLICY",severity:"medium"});if(!/setPermissionRequestHandler/.test(combined))findings.push({code:"PERMISSION_HANDLER",severity:"medium"});if(!/Content-Security-Policy/.test(combined))findings.push({code:"CSP_MISSING",severity:"high"});return{findings};}
async function buildLogDiagnoser(input){const lines=input.lines||String(input.text||"").split(/\r?\n/),events=[];for(let index=0;index<lines.length;index++){const line=lines[index];if(/npm warn deprecated/i.test(line))events.push({line:index+1,type:"warning",code:"DEPRECATED",text:line});else if(/(?:npm ERR!|BUILD HATASI|fatal error|error MSB|makensis.*error)/i.test(line))events.push({line:index+1,type:"fatal",code:"BUILD_ERROR",text:line,context:lines.slice(Math.max(0,index-3),index+4)});else if(/exit code[: ]+[1-9]/i.test(line))events.push({line:index+1,type:"fatal",code:"NONZERO_EXIT",text:line});}const fatal=events.filter((event)=>event.type==="fatal");return{success:fatal.length===0&&(input.exitCode??0)===0,exitCode:input.exitCode??0,events,rootCause:fatal[0]||null,warningCount:events.length-fatal.length};}
async function encodingMojibakeDoctor(input){const findings=[];for(const file of input.files||[]){const buffer=fs.readFileSync(file),source=buffer.toString("utf8");if(source.includes("�"))findings.push({file,code:"REPLACEMENT_CHAR",count:(source.match(/�/g)||[]).length});for(const pair of [["Ã§","ç"],["Ä±","ı"],["ÅŸ","ş"],["Ã¶","ö"],["Ã¼","ü"],["ÄŸ","ğ"],["Ä°","İ"]])if(source.includes(pair[0]))findings.push({file,code:"MOJIBAKE",bad:pair[0],proposed:pair[1],count:source.split(pair[0]).length-1});if(buffer[0]===0xef&&buffer[1]===0xbb&&buffer[2]===0xbf)findings.push({file,code:"UTF8_BOM"});}return{findings,dryRun:true,advice:"Önce backup/hash al; yalnız doğrulanan eşleşmeleri UTF-8 olarak yeniden yaz."};}
async function configDriftDetector(input){const sets={defaults:new Set(Object.keys(input.defaults||{})),schema:new Set(Object.keys(input.schema?.properties||{})),env:new Set(input.envKeys||[]),docs:new Set(input.docKeys||[])},all=new Set(Object.values(sets).flatMap((set)=>Array.from(set))),drift=[];for(const key of all){const present=Object.fromEntries(Object.entries(sets).map(([name,set])=>[name,set.has(key)]));if(new Set(Object.values(present)).size>1)drift.push({key,present});}return{drift};}
async function environmentKeyDoctor(input){const official=["OPENAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","ANTHROPIC_API_KEY","DEEPSEEK_API_KEY","KIMI_API_KEY","MOONSHOT_API_KEY","LOCAL_LLM_BASE_URL"],aliases={OPENAL_API_KEY:"OPENAI_API_KEY",OPENAI_API_KEYY:"OPENAI_API_KEY",GEMINI_API_KEYY:"GEMINI_API_KEY"},env=input.env||process.env;return{official:official.map((name)=>({name,set:Boolean(env[name])})),typos:Object.entries(aliases).filter(([bad])=>Boolean(env[bad])).map(([bad,target])=>({bad,target,migration:bad+" değerini "+target+" adına taşı"}))};}
module.exports={"architecture-graph":architectureGraph,"dead-code-detector":deadCodeDetector,"duplicate-code-finder":duplicateCodeFinder,"migration-planner":migrationPlanner,"ipc-contract-auditor":ipcContractAuditor,"electron-security-auditor":electronSecurityAuditor,"build-log-diagnoser":buildLogDiagnoser,"encoding-mojibake-doctor":encodingMojibakeDoctor,"config-drift-detector":configDriftDetector,"environment-key-doctor":environmentKeyDoctor};
`;

  const release = String.raw`"use strict";
const fs=require("node:fs");const path=require("node:path");const crypto=require("node:crypto");const {scan}=require("../file-scanner");const {scanSecrets}=require("../secret-redaction");const {lineColumn}=require("../text-utils");
function read(file,maxBytes){try{if(fs.statSync(file).size>(maxBytes||2_000_000))return"";return fs.readFileSync(file,"utf8");}catch{return"";}}
function escapeRegex(value){return String(value).replace(/[.*+?^$(){}|[\]\\]/g,"\\$&");}
async function gitRiskAnalyzer(input){const risks=[];if(input.dirty?.length)risks.push({severity:"medium",code:"DIRTY",count:input.dirty.length});if(input.untracked?.length)risks.push({severity:"medium",code:"UNTRACKED",count:input.untracked.length});if((input.diff||"").length>(input.maxDiffBytes||500000))risks.push({severity:"high",code:"LARGE_DIFF"});if(/GIT binary patch|Binary files/.test(input.diff||""))risks.push({severity:"medium",code:"BINARY_DIFF"});if(scanSecrets(input.diff||"").length)risks.push({severity:"critical",code:"SECRET_IN_DIFF"});if(/package-lock|pnpm-lock|yarn.lock/.test(input.diff||""))risks.push({severity:"info",code:"LOCKFILE_CHANGED"});if(/migration|ALTER TABLE|CREATE TABLE/i.test(input.diff||""))risks.push({severity:"high",code:"MIGRATION_CHANGED"});return{risks,verdict:risks.some((item)=>item.severity==="critical")?"block":risks.some((item)=>item.severity==="high")?"review":"pass"};}
async function releaseReadiness(input){const gates=(input.gates||[]).map((gate)=>({id:gate.id,ok:Boolean(gate.ok),required:gate.required!==false,evidence:gate.evidence||null})),failed=gates.filter((gate)=>gate.required&&!gate.ok);return{ready:failed.length===0,gates,failed,summary:String(gates.length-failed.length)+"/"+String(gates.length)+" kapı geçti"};}
async function testGapAnalyzer(input){const sourceSymbols=new Set(input.sourceSymbols||[]),testText=(input.testTexts||[]).join("\n"),gaps=[];for(const symbol of sourceSymbols)if(!new RegExp("\\b"+escapeRegex(symbol)+"\\b").test(testText))gaps.push({symbol,confidence:input.coverage?.[symbol]===0?0.98:0.65,reason:input.coverage?.[symbol]===0?"coverage 0":"test metninde referans yok"});return{gaps,covered:sourceSymbols.size-gaps.length};}
async function flakyTestAnalyzer(input){const byTest=new Map();for(const run of input.runs||[])for(const current of run.tests||[]){const item=byTest.get(current.name)||{name:current.name,pass:0,fail:0,durations:[],messages:[]};current.ok?item.pass+=1:item.fail+=1;item.durations.push(current.durationMs||0);if(current.message)item.messages.push(current.message);byTest.set(current.name,item);}const findings=[];for(const item of byTest.values()){if(item.pass&&item.fail)findings.push({test:item.name,code:"NONDETERMINISTIC_RESULT",severity:"high",pass:item.pass,fail:item.fail});const average=item.durations.reduce((a,b)=>a+b,0)/Math.max(1,item.durations.length),maximum=Math.max(0,...item.durations);if(maximum>average*3&&maximum>1000)findings.push({test:item.name,code:"TIMING_VARIANCE",severity:"medium",average,maximum});const messages=item.messages.join(" ");if(/EADDRINUSE|port/i.test(messages))findings.push({test:item.name,code:"PORT_COLLISION",severity:"high"});if(/ENOENT|temp|tmp/i.test(messages))findings.push({test:item.name,code:"FILE_COLLISION",severity:"medium"});}return{findings};}
async function errorHandlingAuditor(input){const findings=[],rules=[["EMPTY_CATCH",/catch\s*\([^)]*\)\s*\{\s*\}/g],["GENERIC_CATCH",/catch\s*\([^)]*\)\s*\{[^}]{0,300}(?:console\.log|return false|return null)[^}]*\}/g],["LOST_CAUSE",/throw\s+new\s+Error\s*\([^)]*\)(?![^\n]*cause)/g],["UNHANDLED_PROMISE",/\b(?:fetch|readFile|writeFile|send)\([^;]+;(?![^\n]*(?:await|catch|then))/g],["MISSING_FINALLY",/try\s*\{[\s\S]{0,500}(?:open|lock|acquire)[\s\S]{0,500}catch(?![\s\S]{0,300}finally)/g]];for(const file of input.files||[]){const source=read(file);for(const[code,regex]of rules){regex.lastIndex=0;let match;while((match=regex.exec(source)))findings.push(Object.assign({file,code},lineColumn(source,match.index)));}}return{findings};}
async function accessibilityUiAuditor(input){const findings=[];for(const file of input.files||[]){const source=read(file);for(const match of source.matchAll(/<img\b(?![^>]*\balt=)[^>]*>/gi))findings.push(Object.assign({file,code:"IMG_ALT",severity:"high"},lineColumn(source,match.index)));for(const match of source.matchAll(/<(?:button|a)\b[^>]*>\s*<[^>]+>\s*<\/(?:button|a)>/gi))findings.push(Object.assign({file,code:"ICON_NAME",severity:"medium"},lineColumn(source,match.index)));for(const match of source.matchAll(/<(div|span)\b[^>]*onClick=/gi))if(!/role=|tabIndex=|onKey/.test(match[0]))findings.push(Object.assign({file,code:"CLICK_NO_KEYBOARD",severity:"high"},lineColumn(source,match.index)));}return{findings};}
function placeholders(value){return Array.from(String(value).matchAll(/\{\{?([A-Za-z0-9_]+)\}?\}|%[sd]|\$\{([A-Za-z0-9_]+)\}/g)).map((match)=>match[1]||match[2]||match[0]).sort();}
async function localizationIntegrity(input){const locales=input.locales||{},all=new Set(Object.values(locales).flatMap((locale)=>Object.keys(locale))),findings=[];for(const key of all){for(const[language,values]of Object.entries(locales))if(!(key in values))findings.push({code:"MISSING_KEY",language,key,severity:"high"});const values=Object.entries(locales).filter(([,locale])=>key in locale).map(([language,locale])=>[language,String(locale[key])]);if(values.length>1){const baseline=placeholders(values[0][1]).join("|");for(const[language,value]of values.slice(1))if(placeholders(value).join("|")!==baseline)findings.push({code:"PLACEHOLDER_MISMATCH",language,key,severity:"high"});for(const[language,value]of values)if(/[ÃÄÅ�]/.test(value))findings.push({code:"MOJIBAKE",language,key,severity:"high"});}}return{findings};}
async function workspaceIndexer(input){if(!input.root)return{stale:false,manifest:{generation:input.generation||1,createdAt:Date.now(),files:{}},changed:[]};const previous=input.previous||{generation:0,files:{}},generation=input.generation??previous.generation+1,manifest={generation,createdAt:Date.now(),files:{}};for(const item of scan(input.root,{maxFiles:input.maxFiles||20000,signal:input.signal}).filter((entry)=>!entry.binary)){const source=read(item.absolute,input.maxFileBytes||1_000_000),hash=crypto.createHash("sha256").update(source).digest("hex");if(previous.files?.[item.path]?.hash===hash)manifest.files[item.path]=previous.files[item.path];else manifest.files[item.path]={hash,size:item.size,mtimeMs:item.mtimeMs,symbols:Array.from(source.matchAll(/(?:function|class|const|let)\s+(\w+)/g)).map((match)=>match[1]).slice(0,200),imports:Array.from(source.matchAll(/(?:require\(["']([^"']+)|from\s+["']([^"']+))/g)).map((match)=>match[1]||match[2]).slice(0,200)};}if(input.latestGeneration!=null&&generation!==input.latestGeneration)return{stale:true,generation};return{stale:false,manifest,changed:Object.keys(manifest.files).filter((key)=>manifest.files[key]!==previous.files?.[key])};}
function semver(value){const match=String(value||"0.0.0").match(/(\d+)\.(\d+)\.(\d+)/);return match?match.slice(1).map(Number):[0,0,0];}
async function dependencyUpgradePlanner(input){const current=semver(input.current),target=semver(input.target),risks=[];if(target[0]>current[0])risks.push({severity:"high",code:"MAJOR"});if(input.peerConflicts?.length)risks.push({severity:"high",code:"PEER",items:input.peerConflicts});if(input.nativeElectron)risks.push({severity:"high",code:"ELECTRON_ABI"});const descriptions=["Lockfile ve baseline testleri kaydet","Paketi tek başına yükselt","Peer dependency kontrolü","Native modülleri rebuild et","Unit/integration/E2E çalıştır","Build artifact smoke test","Başarısızsa lockfile ve package değişikliklerini geri al"];return{risks,steps:descriptions.map((description,index)=>({order:index+1,description})),rollback:"package ve lockfile checkpoint"};}
function parsePatch(diff){const files=[];let current=null;for(const line of String(diff||"").split(/\r?\n/)){if(line.startsWith("+++ b/")){current={path:line.slice(6),added:[],removed:[]};files.push(current);}else if(current&&line.startsWith("+")&&!line.startsWith("+++"))current.added.push(line.slice(1));else if(current&&line.startsWith("-")&&!line.startsWith("---"))current.removed.push(line.slice(1));}return files;}
async function patchSafetyValidator(input){const files=parsePatch(input.diff),findings=[];for(const file of files){if(file.path.includes("..")||path.isAbsolute(file.path))findings.push({severity:"critical",code:"PATH_ESCAPE",file:file.path});if(/^(?:\.git|node_modules|release|dist)\//.test(file.path))findings.push({severity:"high",code:"FORBIDDEN_PATH",file:file.path});const added=file.added.join("\n");if(scanSecrets(added).length)findings.push({severity:"critical",code:"SECRET_ADDED",file:file.path});if(Buffer.byteLength(added)>(input.maxFilePatchBytes||1_000_000))findings.push({severity:"high",code:"LARGE_PATCH",file:file.path});if(/GIT binary patch/.test(input.diff||""))findings.push({severity:"high",code:"BINARY_PATCH",file:file.path});}if(input.expectedBaseHash&&input.actualBaseHash!==input.expectedBaseHash)findings.push({severity:"critical",code:"BASE_HASH_MISMATCH"});return{files:files.map((file)=>file.path),findings,applyReady:!findings.some((item)=>item.severity==="critical"||item.severity==="high"),testImpact:files.some((file)=>/src|electron|main|preload/.test(file.path))?"integration tests required":"targeted tests"};}
module.exports={"git-risk-analyzer":gitRiskAnalyzer,"release-readiness":releaseReadiness,"test-gap-analyzer":testGapAnalyzer,"flaky-test-analyzer":flakyTestAnalyzer,"error-handling-auditor":errorHandlingAuditor,"accessibility-ui-auditor":accessibilityUiAuditor,"localization-integrity":localizationIntegrity,"workspace-indexer":workspaceIndexer,"dependency-upgrade-planner":dependencyUpgradePlanner,"patch-safety-validator":patchSafetyValidator};
`;

  return {
    "src/shared/plugin-algorithms/index.js": index,
    "src/shared/plugin-algorithms/repository.js": repository,
    "src/shared/plugin-algorithms/quality.js": quality,
    "src/shared/plugin-algorithms/architecture.js": architecture,
    "src/shared/plugin-algorithms/release.js": release
  };
}

module.exports = { algorithmFiles };
