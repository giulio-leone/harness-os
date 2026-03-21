export interface InitializerSessionInput {
  sessionId: string;
  cwd: string;
  syncManifestPath: string;
  sourceRepositories: string[];
}

export interface InitializerSessionOutput {
  progressPath: string;
  featureListPath: string;
  initScriptPath: string;
  smokeTestPassed: boolean;
  notes: string[];
}

export interface IncrementalSessionInput {
  sessionId: string;
  progressPath: string;
  featureListPath: string;
  planPath: string;
  syncManifestPath: string;
  mem0Enabled: boolean;
}

export interface IncrementalSessionOutput {
  selectedIssueId: string;
  smokeTestPassed: boolean;
  cleanHandoff: boolean;
  updatedArtifacts: string[];
}
