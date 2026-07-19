"use strict";

// V3 kaynak üreticisini kontrollü biçimde derler. Kaynak dosyası kullanıcı paketine girmez;
// yalnız CI sırasında gerçek plugin engine dosyalarını üretir.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const filename = path.join(__dirname, "plugin-algorithms-template-v3.js");
let source = fs.readFileSync(filename, "utf8");

const start = source.indexOf("  async function deadCodeDetector");
const end = source.indexOf("  function normalizedTokens", start);
if (start < 0 || end < 0) throw new Error("deadCodeDetector kaynak sınırı bulunamadı");

const replacement = `  async function deadCodeDetector(input = {}) {
    const root = input.root || process.cwd();
    if (!fs.existsSync(root)) return { candidates: [], warning: "Workspace yok" };
    const files = scan(root, { maxFiles: 10000 }).filter((item) => !item.binary && /[.](?:js|ts|tsx|jsx)$/.test(item.path));
    const used = new Set();
    const provided = new Map();
    const entrypoints = new Set(input.entrypoints || ["index.js", "main.js", "src/index.js", "src/main.js"]);
    for (const item of files) {
      const text = read(item.absolute);
      provided.set(item.path, Array.from(text.matchAll(/(?:export\\s+(?:function|class|const)\\s+|exports\\.|module\\.exports\\.)(\\w+)/g)).map((match) => match[1]));
      for (const target of moduleImports(text, item.ext)) used.add(target);
    }
    const candidates = [];
    for (const [file, symbols] of provided) {
      for (const symbol of symbols) {
        const referenced = Array.from(used).some((target) => target.includes(path.basename(file, path.extname(file))));
        if (!entrypoints.has(file) && !referenced) {
          candidates.push({ file, symbol, confidence: read(path.join(root, file)).includes("import(") ? 0.35 : 0.72, reason: "import graph içinde erişilemiyor" });
        }
      }
    }
    return { candidates, warning: "Dinamik import ve reflection nedeniyle otomatik silme yapılmaz." };
  }
`;
source = source.slice(0, start) + replacement + source.slice(end);

const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(source, filename);
module.exports = compiled.exports;
