import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBundledSkillManifest,
  getBundledSkillManifestPath,
  renderBundledSkillManifest,
} from '../src/runtime/bundled-skill-manifest.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const manifest = buildBundledSkillManifest(packageRoot);
const manifestPath = getBundledSkillManifestPath(packageRoot);

writeFileSync(manifestPath, renderBundledSkillManifest(manifest), 'utf8');
console.log(`Rendered bundled skill manifest to ${manifestPath}`);
