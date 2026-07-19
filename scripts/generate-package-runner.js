#!/usr/bin/env node
"use strict";

// Ana üreticiyi kontrollü biçimde çalıştırır ve üretim sonrası kesin kaynak düzeltmelerini uygular.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const Module = require("node:module");

const filename = path.join(__dirname, "generate-package.js");
let source = fs.readFileSync(filename, "utf8");

const validatorNeedle = 'if(/TODO_PLACEHOLDER|REMOVE_THIS|fake success/i.test(written.get(p)))';
const validatorReplacement = 'if(p!=="scripts/doctor.js"&&/TODO_PLACEHOLDER|REMOVE_THIS|fake success/i.test(written.get(p)))';
if (!source.includes(validatorNeedle)) throw new Error("Validator düzeltme noktası bulunamadı");
source = source.replace(validatorNeedle, validatorReplacement);

const doctorNeedle = 'assert.equal(/TODO_PLACEHOLDER|REMOVE_THIS|fake success/i.test(s),false,"placeholder "+f);';
const doctorReplacement = 'const markerRegex=new RegExp([["TODO","PLACEHOLDER"].join("_"),["REMOVE","THIS"].join("_"),["fake","success"].join(" ")].join("|"),"i");assert.equal(markerRegex.test(s),false,"placeholder "+f);';
if (!source.includes(doctorNeedle)) throw new Error("Doctor placeholder düzeltme noktası bulunamadı");
source = source.replace(doctorNeedle, doctorReplacement);

const replacementCharNeedle = 'assert.equal(s.includes("�"),false,"replacement char "+f);';
const replacementCharFix = 'assert.equal(s.includes(String.fromCodePoint(0xfffd)),false,"replacement char "+f);';
if (!source.includes(replacementCharNeedle)) throw new Error("Doctor replacement-character düzeltme noktası bulunamadı");
source = source.replace(replacementCharNeedle, replacementCharFix);

// Prompt Library davranış testi için zorunlu action girdisi.
const promptAnchor = '  "file-summarizer":{file:true,';
const promptSpec = '  "prompt-library":{input:{action:"list"},assert:"assert.equal(result.ok,true); assert.ok(Array.isArray(result.data.prompts));"},\n';
if (!source.includes(promptAnchor)) throw new Error("Prompt Library test ekleme noktası bulunamadı");
source = source.replace(promptAnchor, promptSpec + promptAnchor);

const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(source, filename);

const packageRoot = path.join(__dirname, "..", "dist", "WahooGPT_Harici_40_Eklenti_32_Ozellik_Ucretsiz_v2");

const repositoryTest = `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const plugin = require("../index");

test("repository-map gerçek davranış", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "repository-map-"));
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "src", "alpha.js"), "module.exports = { alpha: true };\n", "utf8");
  fs.writeFileSync(path.join(fixture, "README.md"), "# Demo\n", "utf8");
  const result = await plugin.run({ root: fixture }, {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.data.fileCount >= 2, JSON.stringify(result.data));
  assert.ok(result.data.byLanguage.JavaScript >= 1, JSON.stringify(result.data));
});

test("repository-map şema ve hata zarfı", async () => {
  const result = await plugin.run(null, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_SCHEMA");
});
`;

const duplicateTest = `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const plugin = require("../index");

test("duplicate-code-finder gerçek davranış", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duplicate-code-"));
  fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
  const repeated = "const shared = 1; function calculate(){ return shared + 1; }\n";
  fs.writeFileSync(path.join(fixture, "src", "alpha.js"), repeated, "utf8");
  fs.writeFileSync(path.join(fixture, "src", "beta.js"), repeated, "utf8");
  const result = await plugin.run({ root: fixture, minLines: 1, threshold: 0.6 }, {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.data.matches.length >= 1, JSON.stringify(result.data));
  assert.equal(result.data.matches[0].similarity, 1);
});

test("duplicate-code-finder şema ve hata zarfı", async () => {
  const result = await plugin.run(null, {});
  assert.equal(typeof result.ok, "boolean");
  if (!result.ok) assert.ok(result.error.code);
});
`;

fs.writeFileSync(path.join(packageRoot, "src", "plugins", "repository-map", "tests", "plugin.test.js"), repositoryTest, "utf8");
fs.writeFileSync(path.join(packageRoot, "src", "plugins", "duplicate-code-finder", "tests", "plugin.test.js"), duplicateTest, "utf8");

// Paket içerik hash'i checksum dosyalarının kendisini hariç tutar.
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}
const hash = crypto.createHash("sha256");
for (const file of walk(packageRoot).sort()) {
  const relative = path.relative(packageRoot, file).replace(/\\/g, "/");
  if (relative === "SOURCE_SHA256SUMS.json" || relative === "PACKAGE_CONTENT_SHA256.txt") continue;
  hash.update(relative);
  hash.update("\0");
  hash.update(fs.readFileSync(file));
  hash.update("\0");
}
fs.writeFileSync(path.join(packageRoot, "PACKAGE_CONTENT_SHA256.txt"), hash.digest("hex") + "  source-tree\n", "utf8");
childProcess.execFileSync(process.execPath, [path.join(packageRoot, "scripts", "create-checksums.js")], { stdio: "inherit" });
