#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'smoke-suite-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const projectRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function usage() {
  console.log('Usage: node .harness/run-smoke-suites.js [--list] [--suite <id>]');
}

function getByPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function formatValue(value) {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

function checkExpectation(summary, check) {
  const actual = getByPath(summary, check.path);
  if (check.op === 'equals') {
    return {
      pass: actual === check.value,
      message: `${check.path} expected ${formatValue(check.value)} got ${formatValue(actual)}`,
    };
  }
  if (check.op === 'contains') {
    const pass = typeof actual === 'string' && actual.includes(check.value);
    return {
      pass,
      message: `${check.path} expected to contain ${formatValue(check.value)} got ${formatValue(actual)}`,
    };
  }
  if (check.op === 'min') {
    const pass = typeof actual === 'number' && actual >= check.value;
    return {
      pass,
      message: `${check.path} expected >= ${check.value} got ${formatValue(actual)}`,
    };
  }
  return {
    pass: false,
    message: `Unsupported check op ${check.op} for ${check.path}`,
  };
}

function suiteOutput(suite) {
  return `${suite.id} (${suite.mission})`;
}

if (args.includes('--help')) {
  usage();
  process.exit(0);
}

const listOnly = args.includes('--list');
const suiteIndex = args.indexOf('--suite');
const requestedSuiteId = suiteIndex >= 0 ? args[suiteIndex + 1] : null;

if (suiteIndex >= 0 && !requestedSuiteId) {
  usage();
  process.exit(1);
}

let suites = manifest.suites;
if (requestedSuiteId) {
  suites = suites.filter((suite) => suite.id === requestedSuiteId);
  if (suites.length === 0) {
    console.error(`Unknown suite id: ${requestedSuiteId}`);
    process.exit(1);
  }
}

if (listOnly) {
  console.log(`Smoke suites for ${manifest.projectId}:`);
  for (const suite of suites) {
    console.log(`- ${suiteOutput(suite)} -> ${suite.summaryPath}`);
  }
  process.exit(0);
}

let failed = 0;
let passed = 0;
console.log(`Verifying smoke suites for ${manifest.projectId} using ${path.relative(process.cwd(), manifestPath) || manifestPath}`);
for (const suite of suites) {
  const summaryPath = path.join(projectRoot, suite.summaryPath);
  if (!fs.existsSync(summaryPath)) {
    failed += 1;
    console.log(`FAIL ${suiteOutput(suite)} -> missing summary ${summaryPath}`);
    continue;
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const results = suite.checks.map((check) => checkExpectation(summary, check));
  const failures = results.filter((result) => !result.pass).map((result) => result.message);
  const missingArtifacts = [];
  for (const artifact of suite.proofArtifacts || []) {
    const artifactPath = path.join(projectRoot, suite.suitePath, artifact);
    if (!fs.existsSync(artifactPath)) {
      missingArtifacts.push(`missing artifact ${artifactPath}`);
    }
  }
  failures.push(...missingArtifacts);

  if (failures.length === 0) {
    passed += 1;
    console.log(`PASS ${suiteOutput(suite)} -> ${results.length}/${results.length} checks passed, ${(suite.proofArtifacts || []).length} artifacts present`);
    continue;
  }

  failed += 1;
  console.log(`FAIL ${suiteOutput(suite)} -> ${results.length - (results.filter((result) => !result.pass).length)}/${results.length} checks passed`);
  for (const failure of failures) {
    console.log(`  - ${failure}`);
  }
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
