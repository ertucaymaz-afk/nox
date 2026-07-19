#!/usr/bin/env node
"use strict";

// Ana üreticiyi değiştirmeden kontrollü kaynak düzeltmeleri uygular.
// Doctor kendi tarama desenlerini içerdiği için kendisini bozuk dosya sanmamalıdır.
const fs = require("node:fs");
const path = require("node:path");
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

// Prompt Library gerçek davranış testi zorunlu action alanıyla çalışır.
const promptAnchor = '  "file-summarizer":{file:true,';
const promptSpec = '  "prompt-library":{input:{action:"list"},assert:"assert.equal(result.ok,true); assert.ok(Array.isArray(result.data.prompts));"},\n';
if (!source.includes(promptAnchor)) throw new Error("Prompt Library test ekleme noktası bulunamadı");
source = source.replace(promptAnchor, promptSpec + promptAnchor);

// Repository Map fixture iki gerçek dosya içerir.
const repositoryPattern = /  "repository-map":\{[^\n]+\},/;
const repositorySpec = '  "repository-map":{fixture:true,inputExpr:"{root:fixture}",extra:"fs.writeFileSync(path.join(fixture,\'README.md\'),\'demo repository\');",assert:"assert.equal(result.ok,true); assert.ok(result.data.fileCount>=2); assert.ok(result.data.byLanguage.JavaScript>=1);"},';
if (!repositoryPattern.test(source)) throw new Error("Repository Map test düzeltme noktası bulunamadı");
source = source.replace(repositoryPattern, repositorySpec);

// Duplicate fixture yalnız tek satırlı, güvenli JavaScript kullanır; string kaçışına bağlı değildir.
const duplicatePattern = /  "duplicate-code-finder":\{[^\n]+\},/;
const duplicateSpec = '  "duplicate-code-finder":{fixture:true,inputExpr:"{root:fixture,minLines:1,threshold:0.6}",extra:"fs.writeFileSync(path.join(fixture,\'src\',\'beta.js\'),\'const shared=1; function calculate(){ return shared + 1; }\'); fs.writeFileSync(path.join(fixture,\'src\',\'gamma.js\'),\'const shared=1; function calculate(){ return shared + 1; }\');",assert:"assert.equal(result.ok,true); assert.ok(result.data.matches.length>=1);"},';
if (!duplicatePattern.test(source)) throw new Error("Duplicate Code Finder test düzeltme noktası bulunamadı");
source = source.replace(duplicatePattern, duplicateSpec);

const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(source, filename);
