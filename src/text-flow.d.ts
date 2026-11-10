export const flow: {
  run(html: string, boxes: HTMLElement[], strategy: 'measure' | 'columns'): {
    elapsed: number;
    results: { retries: number; unresolved?: boolean; failed?: boolean }[];
    overflowText: string;
  };
  lines(box: HTMLElement): string[];
  ruleViolations(box: HTMLElement): string[];
};
