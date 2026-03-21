export type SkillScope = 'global_runtime' | 'repo_local_only' | 'manual_global_only';

export interface SkillFamilyPolicy {
  family: string;
  scope: SkillScope;
  preferredUpstream?: 'workflow_instructions' | 'mobile_auto' | 'onecrawl_github' | 'onecrawl_agent' | 'manual';
  syncToCopilot: boolean;
  notes?: string;
}

export const defaultSkillPolicies: SkillFamilyPolicy[] = [
  {
    family: 'generic_engineering',
    scope: 'global_runtime',
    preferredUpstream: 'workflow_instructions',
    syncToCopilot: true,
    notes: 'Shared engineering patterns usable across projects.',
  },
  {
    family: 'frameworks_and_patterns',
    scope: 'global_runtime',
    preferredUpstream: 'onecrawl_github',
    syncToCopilot: true,
  },
  {
    family: 'global_platform_utilities',
    scope: 'global_runtime',
    preferredUpstream: 'onecrawl_github',
    syncToCopilot: true,
  },
  {
    family: 'job_automation_variants',
    scope: 'repo_local_only',
    syncToCopilot: false,
    notes: 'Stay in source repos; never auto-install into ~/.copilot.',
  },
  {
    family: 'manual_global_only',
    scope: 'manual_global_only',
    preferredUpstream: 'manual',
    syncToCopilot: false,
  },
];
