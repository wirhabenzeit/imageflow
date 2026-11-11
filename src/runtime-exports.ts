// The named exports of the `imageflow` module that templates import. The renderer provides them at runtime, the
// bundler exposes exactly these names, and the shipped declarations must declare the same set (src/template-types.ts).
export const runtimeExports = [
  'defineTemplate', 'spreadFor', 'p', 'mm', 'pt', 'inch', 'Spread', 'PhotoBox', 'MarkdownBox', 'Element', 'asset', 'file',
  'geometry', 'box', 'issue', 'capabilities',
] as const;

// Template API features this runtime provides beyond contract 1 as first released. A template lists the ones it
// needs in `requires`; an app without one of them reports which, instead of failing somewhere in a layout.
export const capabilities = ['anchors', 'geometry', 'box-helpers', 'template-issues', 'typed-components'] as const;
export type Capability = typeof capabilities[number];
