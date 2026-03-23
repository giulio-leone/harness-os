export type SkillScope = 'global_runtime' | 'repo_local_only' | 'manual_global_only';

export interface SkillFamilyPolicy {
  family: string;
  scope: SkillScope;
  preferredUpstream?: 'workflow_instructions' | 'mobile_auto' | 'onecrawl_github' | 'onecrawl_agent' | 'manual';
  syncToGlobalHosts: boolean;
  notes?: string;
}

export const defaultSkillPolicies: SkillFamilyPolicy[] = [
  {
    family: 'generic_engineering',
    scope: 'global_runtime',
    preferredUpstream: 'workflow_instructions',
    syncToGlobalHosts: true,
    notes: 'Shared engineering patterns usable across projects.',
  },
  {
    family: 'frameworks_and_patterns',
    scope: 'global_runtime',
    preferredUpstream: 'onecrawl_github',
    syncToGlobalHosts: true,
  },
  {
    family: 'global_platform_utilities',
    scope: 'global_runtime',
    preferredUpstream: 'onecrawl_github',
    syncToGlobalHosts: true,
  },
  {
    family: 'job_automation_variants',
    scope: 'repo_local_only',
    syncToGlobalHosts: false,
    notes: 'Stay in source repos; never auto-install into global hosts automatically.',
  },
  {
    family: 'manual_global_only',
    scope: 'manual_global_only',
    preferredUpstream: 'manual',
    syncToGlobalHosts: false,
  },
  {
    family: 'harness_installation_and_sync',
    scope: 'global_runtime',
    preferredUpstream: 'workflow_instructions',
    syncToGlobalHosts: true,
    notes: 'Skills that teach LLMs how to auto-configure and sync the harness to their own environments.',
  },
];
