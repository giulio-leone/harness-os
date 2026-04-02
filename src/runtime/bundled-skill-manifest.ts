import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  type BundledWorkloadProfile,
  type WorkloadProfileId,
  workloadProfileIds,
} from '../contracts/workload-profiles.js';
import { buildBundledWorkloadProfiles } from './workload-profile-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PACKAGE_ROOT = resolve(__dirname, '..', '..');

export const BUNDLED_SKILLS_DIR = '.github/skills';
export const BUNDLED_SKILL_MANIFEST_FILE = 'bundle-manifest.json';

const bundledSkillFileSchema = z.object({
  relativePath: z.string().min(1),
  sha256: z.string().min(1),
}).strict();

const bundledSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  relativePath: z.string().min(1),
  version: z.string().min(1),
  checksum: z.string().min(1),
  workloadProfileIds: z.array(z.enum(workloadProfileIds)).min(1),
  files: z.array(bundledSkillFileSchema).min(1),
}).strict();

const bundledWorkloadProfileSchema = z.object({
  id: z.enum(workloadProfileIds),
  name: z.string().min(1),
  description: z.string().min(1),
  guidance: z.string().min(1),
  version: z.string().min(1),
  checksum: z.string().min(1),
  skillIds: z.array(z.string().min(1)).min(1),
}).strict();

const bundledSkillManifestSchema = z.object({
  schemaVersion: z.literal(1),
  bundleVersion: z.string().min(1),
  manifestChecksum: z.string().min(1),
  workloadProfiles: z.array(bundledWorkloadProfileSchema).min(1),
  skills: z.array(bundledSkillSchema).min(1),
}).strict();

export type BundledSkillManifest = z.infer<typeof bundledSkillManifestSchema>;
export type BundledSkillManifestSkill = z.infer<typeof bundledSkillSchema>;
export type BundledSkillManifestFile = z.infer<typeof bundledSkillFileSchema>;
export type BundledWorkloadProfileManifest = z.infer<typeof bundledWorkloadProfileSchema>;

export interface BundledSkillValidationResult {
  missingFiles: string[];
  driftedFiles: string[];
  unexpectedFiles: string[];
  manifestMismatch: boolean;
}

export function getBundledSkillsDir(packageRoot: string = DEFAULT_PACKAGE_ROOT): string {
  return resolve(packageRoot, BUNDLED_SKILLS_DIR);
}

export function getBundledSkillManifestPath(packageRoot: string = DEFAULT_PACKAGE_ROOT): string {
  return join(getBundledSkillsDir(packageRoot), BUNDLED_SKILL_MANIFEST_FILE);
}

export function buildBundledSkillManifest(
  packageRoot: string = DEFAULT_PACKAGE_ROOT,
): BundledSkillManifest {
  const bundleVersion = readPackageVersion(packageRoot);
  const skillsDir = getBundledSkillsDir(packageRoot);
  const rawSkillEntries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillId = entry.name;
      const skillDir = join(skillsDir, skillId);
      const skillFiles = collectRelativeFilePaths(skillDir)
        .map((relativePath) => ({
          relativePath,
          sha256: sha256(readFileSync(join(skillDir, relativePath))),
        }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const rawSkill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
      const frontmatter = parseSkillFrontmatter(rawSkill);

      return {
        id: skillId,
        name: frontmatter.name ?? skillId,
        description: frontmatter.description ?? 'Bundled HarnessOS skill.',
        relativePath: `${BUNDLED_SKILLS_DIR}/${skillId}/SKILL.md`,
        version: bundleVersion,
        checksum: sha256(stableStringify(skillFiles)),
        files: skillFiles,
      } satisfies Omit<BundledSkillManifestSkill, 'workloadProfileIds'>;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const workloadProfiles = buildBundledWorkloadProfiles({
    bundleVersion,
    availableSkillIds: rawSkillEntries.map((entry) => entry.id),
  });
  const workloadProfileIdsBySkill = new Map(
    rawSkillEntries.map((entry) => [
      entry.id,
      workloadProfiles
        .filter((profile) => profile.skillIds.includes(entry.id))
        .map((profile) => profile.id)
        .sort((left, right) => left.localeCompare(right)),
    ] as const),
  );
  const skillEntries = rawSkillEntries.map((entry) => ({
    ...entry,
    workloadProfileIds: workloadProfileIdsBySkill.get(entry.id) ?? [],
  }));

  const manifestWithoutChecksum = {
    schemaVersion: 1 as const,
    bundleVersion,
    workloadProfiles,
    skills: skillEntries,
  };

  return {
    ...manifestWithoutChecksum,
    manifestChecksum: sha256(stableStringify(manifestWithoutChecksum)),
  };
}

export function renderBundledSkillManifest(manifest: BundledSkillManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function loadBundledSkillManifest(
  packageRoot: string = DEFAULT_PACKAGE_ROOT,
): BundledSkillManifest {
  const manifestPath = getBundledSkillManifestPath(packageRoot);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Missing bundled skill manifest at ${manifestPath}. Run \`npm run skills:render\` to regenerate it.`,
    );
  }

  return readBundledSkillManifest(manifestPath);
}

export function readBundledSkillManifest(manifestPath: string): BundledSkillManifest {
  const manifest = bundledSkillManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  );
  validateBundledSkillManifestConsistency(manifest);
  return manifest;
}

export function validateInstalledSkillBundle(
  hostSkillsDir: string,
  manifest: BundledSkillManifest,
  workloadProfileId?: WorkloadProfileId,
): BundledSkillValidationResult {
  const missingFiles: string[] = [];
  const driftedFiles: string[] = [];
  const expectedSkills = getBundledSkillsForWorkloadProfile(manifest, workloadProfileId);

  for (const skill of expectedSkills) {
    for (const file of skill.files) {
      const installedPath = join(hostSkillsDir, skill.id, file.relativePath);
      if (!existsSync(installedPath)) {
        missingFiles.push(`${skill.id}/${file.relativePath}`);
        continue;
      }

      if (sha256(readFileSync(installedPath)) !== file.sha256) {
        driftedFiles.push(`${skill.id}/${file.relativePath}`);
      }
    }
  }

  const installedManifestPath = join(hostSkillsDir, BUNDLED_SKILL_MANIFEST_FILE);
  let manifestMismatch = true;
  if (existsSync(installedManifestPath)) {
    try {
      const installedManifest = readBundledSkillManifest(installedManifestPath);
      manifestMismatch = installedManifest.manifestChecksum !== manifest.manifestChecksum;
    } catch {
      manifestMismatch = true;
    }
  }

  const expectedPaths = new Set<string>([
    BUNDLED_SKILL_MANIFEST_FILE,
    ...expectedSkills.flatMap((skill) =>
      skill.files.map((file) => join(skill.id, file.relativePath)),
    ),
  ]);
  const unexpectedFiles = collectRelativeFilePaths(hostSkillsDir)
    .filter((relativePath) => !expectedPaths.has(relativePath))
    .sort((left, right) => left.localeCompare(right));

  return {
    missingFiles,
    driftedFiles,
    unexpectedFiles,
    manifestMismatch,
  };
}

export function getBundledSkillsForWorkloadProfile(
  manifest: BundledSkillManifest,
  workloadProfileId?: WorkloadProfileId,
): BundledSkillManifestSkill[] {
  if (!workloadProfileId) {
    return [...manifest.skills].sort((left, right) => left.id.localeCompare(right.id));
  }

  return manifest.skills
    .filter((skill) => skill.workloadProfileIds.includes(workloadProfileId))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function getBundledWorkloadProfile(
  manifest: BundledSkillManifest,
  workloadProfileId: WorkloadProfileId,
): BundledWorkloadProfile {
  const profile = manifest.workloadProfiles.find((candidate) => candidate.id === workloadProfileId);
  if (!profile) {
    throw new Error(`Bundled skill manifest is missing workload profile "${workloadProfileId}".`);
  }

  return profile;
}

export function isCleanBundledSkillValidationResult(
  result: BundledSkillValidationResult,
): boolean {
  return (
    result.missingFiles.length === 0 &&
    result.driftedFiles.length === 0 &&
    result.unexpectedFiles.length === 0 &&
    !result.manifestMismatch
  );
}

function validateBundledSkillManifestConsistency(manifest: BundledSkillManifest): void {
  const manifestWithoutChecksum = {
    schemaVersion: manifest.schemaVersion,
    bundleVersion: manifest.bundleVersion,
    workloadProfiles: manifest.workloadProfiles,
    skills: manifest.skills,
  };
  const expectedChecksum = sha256(stableStringify(manifestWithoutChecksum));
  if (manifest.manifestChecksum !== expectedChecksum) {
    throw new Error(
      'Bundled skill manifest checksum mismatch. Run `npm run skills:render` to regenerate it.',
    );
  }

  const knownSkillIds = new Set(manifest.skills.map((skill) => skill.id));
  for (const profile of manifest.workloadProfiles) {
    for (const skillId of profile.skillIds) {
      if (!knownSkillIds.has(skillId)) {
        throw new Error(
          `Bundled skill manifest profile "${profile.id}" references unknown skill "${skillId}".`,
        );
      }
    }
  }

  const knownProfileIds = new Set(manifest.workloadProfiles.map((profile) => profile.id));
  for (const skill of manifest.skills) {
    for (const profileId of skill.workloadProfileIds) {
      if (!knownProfileIds.has(profileId)) {
        throw new Error(
          `Bundled skill manifest skill "${skill.id}" references unknown workload profile "${profileId}".`,
        );
      }
    }
  }

  for (const skill of manifest.skills) {
    if (skill.workloadProfileIds.length === 0) {
      throw new Error(`Bundled skill manifest skill "${skill.id}" must belong to at least one workload profile.`);
    }
  }
}

function collectRelativeFilePaths(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRelativeFilePaths(fullPath, base));
      continue;
    }

    if (!statSync(fullPath).isFile()) {
      continue;
    }

    results.push(fullPath.slice(base.length + 1));
  }

  return results.sort((left, right) => left.localeCompare(right));
}

function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }

  const frontmatter: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const separatorIndex = rawLine.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    const value = rawLine.slice(separatorIndex + 1).trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }

    frontmatter[key] = value;
  }

  return {
    name: frontmatter['name'],
    description: frontmatter['description'],
  };
}

function readPackageVersion(packageRoot: string): string {
  const rawPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (!rawPackage.version) {
    throw new Error(`Unable to determine package version from ${join(packageRoot, 'package.json')}.`);
  }

  return rawPackage.version;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (Array.isArray(nestedValue) || nestedValue === null || typeof nestedValue !== 'object') {
      return nestedValue;
    }

    return Object.keys(nestedValue as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = (nestedValue as Record<string, unknown>)[key];
        return accumulator;
      }, {});
  });
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
