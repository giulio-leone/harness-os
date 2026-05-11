import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

test('root package keeps Next and React out of runtime dependencies', () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as PackageJson;

  assert.deepEqual(
    Object.keys(rootPackage.dependencies ?? {}).filter((name) =>
      ['next', 'react', 'react-dom'].includes(name),
    ),
    [],
  );
  assert.equal(rootPackage.devDependencies?.next, undefined);
  assert.equal(rootPackage.devDependencies?.react, undefined);
  assert.equal(rootPackage.devDependencies?.['react-dom'], undefined);
});
