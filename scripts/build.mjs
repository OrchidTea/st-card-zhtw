import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const pkg = JSON.parse(read('package.json'));
let core = read('src/legacy-core.js');
// These adapters supply field context without changing the recovered v0.3 safety checks.
core = core.replaceAll('q(s,t)', 'q(s,t,c)').replaceAll('q(a,t)', 'q(a,t,c)').replaceAll('q(i,ee)', 'q(i,ee,s)').replaceAll('after:be(d)', 'after:nameSafeGlyph(d)');
const dictionary = JSON.parse(read('dictionary.json'));
const api = 'globalThis.CardTranslator={version:' + JSON.stringify(pkg.version) + ',convert:convertV05,legacyConvert:Ee,inspect:Se,describe:_e,readPng:Ne,writePng:Pe,textFields,fieldAt,setField,editableField,previewReplacement,validateManual,technicalIntegrity,reviewScan,replaceAt,replaceAllReview,aiCandidates,fieldLabel,mirrorField,setDictionary,getDictionary,compileDictionary,frozenTokens,U};';
const shared = read('vendor/opencc-bundled.js') + '\n(()=>{\n' + core + '\n' + read('src/localization.js') + '\n' + read('src/manual-review.js') + '\n'
  + read('src/png-export.js') + '\n' + read('src/v05-engine.js') + '\nsetDictionary(' + JSON.stringify(dictionary) + ');\n' + api;
fs.rmSync(path.join(root, 'dist'), {recursive: true, force: true});
fs.mkdirSync(path.join(root, 'dist'), {recursive: true});
fs.mkdirSync(path.join(root, 'build'), {recursive: true});
fs.writeFileSync(path.join(root, 'build/core.js'), shared + '\n})();');
fs.writeFileSync(path.join(root, 'dist/app.js'), shared + '\n})();\n' + read('src/ai.js') + '\n' + read('src/app-ui.js'));
fs.writeFileSync(path.join(root, 'dist/index.html'), read('index.html').replaceAll('{{VERSION}}', pkg.version));
fs.copyFileSync(path.join(root, 'styles.css'), path.join(root, 'dist/styles.css'));
fs.copyFileSync(path.join(root, 'dictionary.json'), path.join(root, 'dist/dictionary.json'));
fs.cpSync(path.join(root, 'assets'), path.join(root, 'dist/assets'), {recursive: true});
console.log('Built v' + pkg.version);
