export interface MemoryFact {
  id: string;
  category: 'decision' | 'preference' | 'project' | 'campaign' | 'contact' | 'sync_rule';
  content: string;
  scope: 'global' | 'repo' | 'campaign';
  projectId?: string;
  createdAt: string;
}

export interface MemorySearchResult {
  fact: MemoryFact;
  score: number;
}

export interface Mem0Adapter {
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
  addMemory(fact: MemoryFact): Promise<string>;
  searchMemory(query: string, scope?: MemoryFact['scope']): Promise<MemorySearchResult[]>;
  deleteMemory(id: string): Promise<void>;
}
