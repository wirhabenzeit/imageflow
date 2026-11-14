export class TemplateFilesError extends Error {}
export function listTemplateFiles(folder: string): Promise<string[]>;
export function hashTemplateFiles(folder: string, files: readonly string[]): Promise<string>;
