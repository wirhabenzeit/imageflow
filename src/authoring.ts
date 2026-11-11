// A content revision identifies the project inputs used by an authoring operation.
export type ProjectRevision = string;

export type RevisionDiagnosticCode = 'source-changed' | 'source-missing' | 'source-outside-project' | 'source-unreadable';

export type AuthoringDiagnostic = {
  code: string;
  stage: 'project' | 'template' | 'render' | 'preview';
  severity: 'error' | 'warning';
  message: string;
  location?: {
    path?: string; line?: number; column?: number;
    spread?: string; box?: string; element?: string; source?: string; where?: string;
  };
};

export type AuthoringReport = {
  revision: ProjectRevision | null;
  diagnostics: AuthoringDiagnostic[];
};
