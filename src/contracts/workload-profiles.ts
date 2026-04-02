export const workloadProfileIds = [
  'coding',
  'research',
  'ops',
  'sales',
  'support',
  'assistant',
] as const;

export type WorkloadProfileId = typeof workloadProfileIds[number];

export interface WorkloadProfileDefinition {
  id: WorkloadProfileId;
  name: string;
  description: string;
  guidance: string;
  skillIds: string[];
}

export interface BundledWorkloadProfile extends WorkloadProfileDefinition {
  version: string;
  checksum: string;
}
