import fs from 'node:fs';
import path from 'node:path';

const runtimeCandidates = [
  path.resolve(process.cwd(), '.next/server/chunks/ssr/[turbopack]_runtime.js'),
  path.resolve(process.cwd(), '.next/server/chunks/[turbopack]_runtime.js'),
  path.resolve(
    process.cwd(),
    '.open-next/server-functions/default/.next/server/chunks/ssr/[turbopack]_runtime.js',
  ),
  path.resolve(
    process.cwd(),
    '.open-next/server-functions/default/.next/server/chunks/[turbopack]_runtime.js',
  ),
];

const blockPattern = /function readWebAssemblyAsResponse\(path\) \{[\s\S]*?async function instantiateWebAssemblyFromPath\(path, importsObj\) \{[\s\S]*?return instance\.exports;\n\}/m;

const replacement = `async function compileWebAssemblyFromPath(path) {
    const { readFile } = require('fs/promises');
    const wasmBytes = await readFile(path);
    return await WebAssembly.compile(wasmBytes);
}
async function instantiateWebAssemblyFromPath(path, importsObj) {
    const { readFile } = require('fs/promises');
    const wasmBytes = await readFile(path);
    const { instance } = await WebAssembly.instantiate(wasmBytes, importsObj);
    return instance.exports;
}`;

let patchedFiles = 0;

for (const runtimePath of runtimeCandidates) {
  if (!fs.existsSync(runtimePath)) {
    continue;
  }

  const original = fs.readFileSync(runtimePath, 'utf8');
  const next = original.replace(blockPattern, replacement);

  if (next !== original) {
    fs.writeFileSync(runtimePath, next, 'utf8');
    patchedFiles += 1;
    console.log(`[patch-turbopack-wasm-runtime] patched ${runtimePath}`);
  } else {
    console.warn(`[patch-turbopack-wasm-runtime] no wasm runtime block matched in ${runtimePath}`);
  }
}

if (patchedFiles === 0) {
  console.warn('[patch-turbopack-wasm-runtime] no files patched');
}
