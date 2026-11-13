// Render purity guards (ADR 0006). In Book check, export and artwork frames, calls that make a page depend on the
// network, the GPU or time are recorded when they come from template code, and reported as `render-impure`.
// The guards report mistakes; they are not a security boundary. The render CSP still blocks the network.

export type ImpureCall = { api: string; spread?: string };

type Target = Record<string, unknown>;

// Contexts that need the GPU (or a deferred pipeline) and so do not render deterministically during print.
const gpuContexts = new Set(['webgl', 'webgl2', 'experimental-webgl', 'webgpu', 'bitmaprenderer']);

export type PurityGuards = {
  readonly calls: readonly ImpureCall[];
  // The spread whose layout is rendering, so a call can be located; undefined between layouts.
  rendering(spread: string | undefined): void;
};

let active: PurityGuards | undefined;
let current: string | undefined;

// Called around each layout's render; does nothing unless guards are installed.
export function renderingSpread(spread: string | undefined) {
  if (active) active.rendering(spread);
}

/**
 * Wraps the impure APIs on `target` (the frame's window). A call counts when the stack contains `scriptPath`, the
 * path of the bundled template, so the app's own timers and requests are never reported. Calls still go through:
 * the frame's CSP decides what actually reaches the network.
 */
export function installPurityGuards(target: Target, scriptPath: string, stack: () => string = () => new Error().stack ?? ''): PurityGuards {
  const calls: ImpureCall[] = [];
  const seen = new Set<string>();
  const record = (api: string) => {
    if (!stack().includes(scriptPath)) return;
    const key = api + '\u0000' + (current ?? '');
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ api, ...(current ? { spread: current } : {}) });
  };
  const wrapFunction = (name: string) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (...args: unknown[]) {
      record(name);
      return (original as (...args: unknown[]) => unknown).apply(target, args);
    };
  };
  const wrapConstructor = (name: string) => {
    const original = target[name] as (new (...args: unknown[]) => unknown) | undefined;
    if (typeof original !== 'function') return;
    target[name] = new Proxy(original, {
      construct(constructor, args, newTarget) {
        record(name);
        return Reflect.construct(constructor, args, newTarget);
      },
    });
  };
  const wrapContext = (name: string) => {
    const prototype = (target[name] as { prototype?: { getContext?: (...args: unknown[]) => unknown } } | undefined)?.prototype;
    const original = prototype?.getContext;
    if (!prototype || typeof original !== 'function') return;
    prototype.getContext = function (this: unknown, kind: unknown, ...rest: unknown[]) {
      if (typeof kind === 'string' && gpuContexts.has(kind)) record(name + '.getContext(\'' + kind + '\')');
      return original.call(this, kind, ...rest);
    };
  };
  const xhr = (target.XMLHttpRequest as { prototype?: { open?: (...args: unknown[]) => unknown } } | undefined)?.prototype;
  if (xhr && typeof xhr.open === 'function') {
    const open = xhr.open;
    xhr.open = function (this: unknown, ...args: unknown[]) {
      record('XMLHttpRequest');
      return open.apply(this, args);
    };
  }
  for (const name of ['fetch', 'importScripts', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback']) wrapFunction(name);
  for (const name of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker']) wrapConstructor(name);
  for (const name of ['HTMLCanvasElement', 'OffscreenCanvas']) wrapContext(name);
  const gpu = (target.navigator as { gpu?: Target } | undefined)?.gpu;
  if (gpu && typeof gpu.requestAdapter === 'function') {
    const request = gpu.requestAdapter as (...args: unknown[]) => unknown;
    gpu.requestAdapter = (...args: unknown[]) => {
      record('navigator.gpu');
      return request.apply(gpu, args);
    };
  }
  const guards: PurityGuards = { calls, rendering(spread) { current = spread; } };
  active = guards;
  return guards;
}

const kinds: [RegExp, string][] = [
  [/^(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)$/, 'requests data'],
  [/^(Worker|SharedWorker)$/, 'starts a worker'],
  [/getContext|^navigator\.gpu$/, 'draws with the GPU'],
  [/^(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)$/, 'schedules work for later'],
];

export function impureMessage(api: string) {
  const kind = kinds.find(([pattern]) => pattern.test(api))?.[1] ?? 'is not pure';
  return 'The template calls ' + api + ', which ' + kind + '. Layouts must render from their inputs alone, so the printed book cannot depend on it.';
}

export const impureSuggestion = 'Do this work in an element editor and save the result into the book (for example as a file parameter), ' +
  'or remove the call. A 2D canvas is allowed.';
