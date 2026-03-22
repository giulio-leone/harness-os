#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def read_text(path: Path) -> str:
    return path.read_text()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> int:
    parser = argparse.ArgumentParser(description='Prove that repo-native harness skills are reusable by a real consumer workspace.')
    parser.add_argument('--runtime-skills', required=True, help='Path to the global runtime skill directory, e.g. ~/.copilot/skills')
    parser.add_argument('--consumer-workspace', required=True, help='Path to the consumer workspace that should boot with the published skills')
    parser.add_argument('--output', help='Optional path for the JSON proof artifact')
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    runtime_dir = Path(args.runtime_skills).expanduser().resolve()
    consumer_root = Path(args.consumer_workspace).expanduser().resolve()

    repo_skills = repo_root / '.github' / 'skills'
    skill_slugs = ['session-lifecycle', 'prompt-contract-bindings']
    parity = {}
    for slug in skill_slugs:
        repo_file = repo_skills / slug / 'SKILL.md'
        runtime_file = runtime_dir / slug / 'SKILL.md'
        require(repo_file.exists(), f'missing repo skill: {repo_file}')
        require(runtime_file.exists(), f'missing runtime skill: {runtime_file}')
        repo_text = read_text(repo_file)
        runtime_text = read_text(runtime_file)
        require(repo_text == runtime_text, f'repo/runtime mismatch for {slug}')
        require(repo_text.startswith('---\nname: '), f'invalid frontmatter start for {slug}')
        require('\ndescription: ' in repo_text, f'missing description for {slug}')
        require('\nversion: "' in repo_text, f'missing version for {slug}')
        parity[slug] = {'repoMatchesRuntime': True}

    manifest_text = read_text(Path.home() / '.copilot' / 'SYNC_MANIFEST.yaml')
    manifest_checks = {
        'agentHarnessCoreSourceListed': 'agent_harness_core:' in manifest_text,
        'harnessRuntimeFamilyListed': 'name: harness_runtime' in manifest_text,
        'sessionLifecycleRoutedFromHarnessRepo': 'preferred_upstream: agent_harness_core' in manifest_text and '- session-lifecycle' in manifest_text,
        'promptBindingsRoutedFromHarnessRepo': '- prompt-contract-bindings' in manifest_text,
        'expectedCount29': 'expected_count: 29' in manifest_text
    }
    require(all(manifest_checks.values()), 'SYNC_MANIFEST is missing one or more harness skill publication checks')

    harness_project = json.loads(read_text(consumer_root / 'harness-project.json'))
    consumer_checks = {
        'promptBindingsPresent': harness_project.get('promptBindings') == '.harness/prompt-workflow-bindings.json',
        'domainSchemasPresent': bool(harness_project.get('domainSchemas')),
        'missionWorkflowsPresent': bool(harness_project.get('missionWorkflows')),
        'globalSkillReuseProofPathPresent': harness_project.get('validationArtifacts', {}).get('globalSkillReuseProof') == '.harness/runtime/global-skill-reuse-proof.json'
    }
    require(all(consumer_checks.values()), 'consumer harness-project.json is missing one or more prompt-contract or proof-artifact references')

    init_result = subprocess.run(
        ['bash', str(consumer_root / 'init.sh')],
        check=True,
        capture_output=True,
        text=True,
    )
    init_output = init_result.stdout
    init_checks = {
        'originalPromptFixtureFound': '[ok] original prompt fixture found' in init_output,
        'promptWorkflowBindingsFound': '[ok] prompt workflow bindings found' in init_output,
        'domainSchemaOverlayFound': '[ok] domain schema overlay found' in init_output,
        'missionWorkflowContractFound': '[ok] mission workflow contract found' in init_output,
        'sessionLifecycleCliFound': '[ok] session-lifecycle CLI found' in init_output,
        'mem0CliFound': '[ok] mem0 CLI found' in init_output
    }
    require(all(init_checks.values()), 'consumer init output is missing one or more expected global-skill reuse signals')

    proof = {
        'status': 'passed',
        'runtimeSkillsPath': str(runtime_dir),
        'consumerWorkspace': str(consumer_root),
        'repoToRuntimeParity': parity,
        'syncManifestChecks': manifest_checks,
        'consumerManifestChecks': consumer_checks,
        'consumerBootstrapChecks': init_checks
    }

    if args.output:
        output_path = Path(args.output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(proof, indent=2) + '\n')

    print(json.dumps(proof, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
