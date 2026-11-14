const icons = {
  check: 'M3 8l3 3 7-7',
  warning: 'M8 2l6 11H2zM8 6v3M8 11v.1',
  document: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 7h4M6 9h4M6 11h3',
  link: 'M6.5 10.5l3-5M5.8 8.8l-1 1a2.5 2.5 0 0 0 3.5 3.5l2.2-2.2a2.5 2.5 0 0 0 0-3.5M10.2 7.2l1-1a2.5 2.5 0 0 0-3.5-3.5L5.5 4.9a2.5 2.5 0 0 0 0 3.5',
  cog: 'M6.5 2l.4-1h2.2l.4 1 .3 1 1 .6 1.1-.2 1.1-.1 1.1 1.9-.6.9-.7.8v1.2l.7.8.6.9-1.1 1.9-1.1-.1-1.1-.2-1 .6-.3 1-.4 1H6.9l-.4-1-.3-1-1-.6-1.1.2-1.1.1-1.1-1.9.6-.9.7-.8V6.9l-.7-.8-.6-.9L3 3.3l1.1.1 1.1.2 1-.6zM10.25 8a2.25 2.25 0 1 0-4.5 0 2.25 2.25 0 1 0 4.5 0',
  close: 'M4 4l8 8M12 4l-8 8',
  previous: 'M10 3L5 8l5 5',
  next: 'M6 3l5 5-5 5',
  minus: 'M3 8h10',
  plus: 'M8 3v10M3 8h10',
  sidebarLeft: 'M3 3h10v10H3zM6 3v10',
  sidebarRight: 'M3 3h10v10H3zM10 3v10',
  // The editor panel under the canvas.
  undo: 'M6 4L3 7l3 3M3 7h6a3 3 0 0 1 3 3v2',
  redo: 'M10 4l3 3-3 3M13 7H7a3 3 0 0 0-3 3v2',
  export: 'M8 10V2M5 5l3-3 3 3M3 8v5h10V8',
  chevron: 'M5 6l3 3 3-3',
  play: 'M5 3l8 5-8 5z',
  add: 'M8 3v10M3 8h10',
  duplicate: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  delete: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  // Settings toolbar: sliders for General, an open book for Templates, a sparkle for agents.
  templates: 'M2.5 3.5H6.5A1.5 1.5 0 0 1 8 5V13A1.5 1.5 0 0 0 6.5 11.5H2.5ZM13.5 3.5H9.5A1.5 1.5 0 0 0 8 5V13A1.5 1.5 0 0 1 9.5 11.5H13.5Z',
  settings: 'M2.5 5h5.5M11.5 5h2M2.5 11h1.5M7.5 11h6M8 5a1.75 1.75 0 1 0 3.5 0a1.75 1.75 0 1 0-3.5 0M4 11a1.75 1.75 0 1 0 3.5 0a1.75 1.75 0 1 0-3.5 0',
  agent: 'M7 2.5l1.3 3.7 3.7 1.3-3.7 1.3L7 12.5 5.7 8.8 2 7.5l3.7-1.3zM12 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
};
export const Icon = ({ name, size = 14 }: { name: keyof typeof icons; size?: number }) => <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
  <path d={icons[name]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
</svg>;

