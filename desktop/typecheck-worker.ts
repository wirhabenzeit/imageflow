import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { TypecheckResult } from './typecheck';

const maxFiles = 512, maxBytes = 8 * 1024 * 1024, maxDiagnostics = 50;
const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
const slash = (path: string) => path.split(sep).join('/');

function check(): TypecheckResult {
  const folder = realpathSync(workerData.folder);
  const root = realpathSync(join(folder, 'template'));
  if (!inside(folder, root) || root === folder) throw new Error('template/ must stay inside the project.');
  const types = realpathSync(workerData.typesRoot);
  const lib = realpathSync(dirname(ts.getDefaultLibFilePath({})));
  const sources = new Map<string, string>();
  const visited = new Set<string>();
  let bytes = 0;
  function readSources(path: string, depth = 0) {
    if (depth > 32) throw new Error('Template source directories exceed 32 levels.');
    const actual = realpathSync(path);
    if (!inside(root, actual)) throw new Error('A template source points outside template/.');
    if (visited.has(actual)) return;
    visited.add(actual);
    for (const entry of readdirSync(actual, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      // Saved dependencies are checked through their declarations in vendor/types, not as template source.
      if (entry.name === 'vendor' && actual === root) continue;
      const next = join(actual, entry.name), canonical = realpathSync(next);
      if (!inside(root, canonical)) throw new Error('A template source points outside template/.');
      if (statSync(canonical).isDirectory()) { readSources(next, depth + 1); continue; }
      if (!/\.(?:[cm]?ts|tsx|[cm]?js|jsx|json)$/.test(entry.name)) continue;
      // Project copies support external editors; checking uses the installed runtime's authoritative declarations.
      if (/^types\/(?:imageflow|jsx-runtime|files)\.d\.ts$/.test(slash(relative(root, next)))) continue;
      if (sources.has(canonical)) continue;
      bytes += statSync(canonical).size;
      if (sources.size >= maxFiles || bytes > maxBytes) throw new Error('Type checking supports at most 512 source files and 8 MiB of template code.');
      sources.set(canonical, readFileSync(canonical, 'utf8'));
    }
  }
  readSources(root);
  // Declarations of the saved dependency bundle (ADR 0006), in vendor/types/packages by package name.
  const vendorTypes = join(root, 'vendor', 'types');
  const untyped = join(vendorTypes, 'untyped.d.ts');
  const modules: Record<string, string> = {
    imageflow: join(types, 'imageflow.d.ts'), react: join(types, 'react.d.ts'), 'react/jsx-runtime': join(types, 'jsx-runtime.d.ts'),
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true, skipLibCheck: false, types: [],
    allowJs: true, checkJs: false, noUncheckedSideEffectImports: true, resolveJsonModule: true, allowImportingTsExtensions: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    // Every bare import, from template code and from vendored declarations alike, resolves among the saved packages.
    baseUrl: vendorTypes, paths: { '*': ['packages/*', 'packages/@types/*'] },
  };
  const host = ts.createCompilerHost(options);
  const permitted = (path: string) => {
    try { const actual = realpathSync(path); return inside(root, actual) || inside(types, actual) || inside(lib, actual) ? actual : undefined; }
    catch { return undefined; }
  };
  host.getCurrentDirectory = () => root;
  host.readFile = (path) => {
    const actual = permitted(path);
    if (!actual) return undefined;
    if (inside(root, actual) && !inside(vendorTypes, actual)) return sources.get(actual);
    try { return readFileSync(actual, 'utf8'); } catch { return undefined; }
  };
  host.fileExists = (path) => host.readFile(path) !== undefined;
  host.directoryExists = (path) => { const actual = permitted(path); return !!actual && statSync(actual).isDirectory(); };
  host.getDirectories = () => [];
  host.realpath = (path) => permitted(path) ?? path;
  host.getSourceFile = (path, languageVersion) => {
    const source = host.readFile(path);
    return source === undefined ? undefined : ts.createSourceFile(path, source, languageVersion, true);
  };
  host.writeFile = () => { throw new Error('Type checking must not write files.'); };
  host.resolveModuleNames = (names, containingFile) => names.map((name) => {
    if (Object.hasOwn(modules, name)) return { resolvedFileName: modules[name], extension: ts.Extension.Dts };
    if (name === 'csstype' && inside(types, resolve(containingFile))) {
      return { resolvedFileName: join(types, 'csstype/index.d.ts'), extension: ts.Extension.Dts };
    }
    if (!name.startsWith('./') && !name.startsWith('../')) {
      const resolved = ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
      return resolved && inside(vendorTypes, resolve(resolved.resolvedFileName)) ? resolved : undefined;
    }
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  });
  // JSON participates only when imported; tsconfig.json remains editor configuration, never a compiler input.
  const roots = [...sources.keys()].filter((path) => !path.endsWith('.json')).concat(join(types, 'assets.d.ts'));
  if (host.fileExists(untyped)) roots.push(untyped);
  const globals = join(vendorTypes, 'globals.d.ts');
  if (host.fileExists(globals)) roots.push(globals);
  const program = ts.createProgram(roots, options, host);
  // Third-party declarations are not the template's to fix; their problems surface where the template uses them.
  const findings = ts.getPreEmitDiagnostics(program).filter((finding) => !finding.file || !inside(vendorTypes, resolve(finding.file.fileName)));
  const diagnostics: AuthoringDiagnostic[] = findings.slice(0, maxDiagnostics).map((finding) => {
    const position = finding.file && finding.start !== undefined ? finding.file.getLineAndCharacterOfPosition(finding.start) : undefined;
    const path = finding.file && (inside(root, resolve(finding.file.fileName))
      ? slash(relative(folder, finding.file.fileName)) : 'installed-types/' + slash(relative(types, finding.file.fileName)));
    return { code: 'typescript-error', stage: 'template', severity: 'error',
      message: ts.flattenDiagnosticMessageText(finding.messageText, '\n'), details: { typescriptCode: finding.code },
      ...(path ? { location: { path, ...(position ? { line: position.line + 1, column: position.character + 1 } : {}) } } : {}) };
  });
  return { diagnostics, files: program.getSourceFiles().map((file) => file.fileName).filter((path) => inside(root, path) && !inside(vendorTypes, path))
    .map((path) => slash(relative(folder, path))).sort(),
    totalDiagnostics: findings.length, truncated: findings.length > maxDiagnostics, elapsedMs: 0 };
}

try { parentPort!.postMessage(check()); }
catch (error) { parentPort!.postMessage({ files: [], totalDiagnostics: 1, truncated: false, elapsedMs: 0,
  diagnostics: [{ code: 'typescript-unavailable', stage: 'template', severity: 'error',
    message: error instanceof Error ? error.message : 'Type checking could not complete.' }] }); }
