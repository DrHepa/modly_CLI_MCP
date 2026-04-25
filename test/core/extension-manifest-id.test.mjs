import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPathWithinDirectory,
  normalizeExtensionManifestId,
  resolveContainedExtensionPath,
} from '../../src/core/extension-manifest-id.mjs';

test('normalizeExtensionManifestId accepts real extension identifiers including dots', () => {
  assert.equal(normalizeExtensionManifestId('triposg'), 'triposg');
  assert.equal(normalizeExtensionManifestId('modly-depth-anything'), 'modly-depth-anything');
  assert.equal(normalizeExtensionManifestId('modly.ultrashape-refiner-model'), 'modly.ultrashape-refiner-model');
  assert.equal(normalizeExtensionManifestId('octo.tools'), 'octo.tools');
});

test('normalizeExtensionManifestId rejects traversal, absolute-path, scoped, spaced, uppercase, and non-string ids', () => {
  const invalidIds = [
    null,
    undefined,
    '',
    '.',
    '..',
    '../escape',
    '..\\escape',
    '/tmp/escape',
    '\\server\\share',
    'C:/escape',
    'C:\\escape',
    'octo tools',
    'Octo.Tools',
    '@scope/name',
  ];

  for (const manifestId of invalidIds) {
    assert.throws(
      () => normalizeExtensionManifestId(manifestId),
      (error) => error?.code === 'MANIFEST_ID_INVALID',
      `expected ${String(manifestId)} to be rejected`,
    );
  }
});

test('normalizeExtensionManifestId rejects the explicit audit matrix payloads for manifest.id traversal and format abuse', () => {
  const auditCases = [
    ['a/b', 'manifest.id must not contain "/" or "\\" path separators.'],
    ['a\\b', 'manifest.id must not contain "/" or "\\" path separators.'],
    ['C:pwned', 'manifest.id must not contain a Windows drive prefix.'],
    [' bad', 'manifest.id must not contain whitespace.'],
    ['BadId', 'manifest.id must match ^[a-z0-9][a-z0-9._-]{0,127}$.'],
  ];

  for (const [manifestId, reason] of auditCases) {
    assert.throws(
      () => normalizeExtensionManifestId(manifestId),
      (error) => {
        assert.equal(error?.code, 'MANIFEST_ID_INVALID');
        assert.equal(error?.details?.manifestId?.value, manifestId);
        assert.equal(error?.details?.manifestId?.reason, reason);
        return true;
      },
      `expected ${manifestId} to be rejected explicitly`,
    );
  }
});

test('resolveContainedExtensionPath keeps derived paths inside the extensions directory', () => {
  const extensionsDir = '/opt/modly/extensions';
  const targetPath = resolveContainedExtensionPath(extensionsDir, 'octo.tools');
  const candidatePath = resolveContainedExtensionPath(extensionsDir, 'octo.tools.candidate');

  assert.equal(targetPath, '/opt/modly/extensions/octo.tools');
  assert.equal(candidatePath, '/opt/modly/extensions/octo.tools.candidate');
  assert.doesNotThrow(() => assertPathWithinDirectory(extensionsDir, targetPath));
});

test('resolveContainedExtensionPath rejects derived paths that escape the extensions directory', () => {
  assert.throws(
    () => resolveContainedExtensionPath('/opt/modly/extensions', '../escape'),
    (error) => error?.code === 'EXTENSION_PATH_OUTSIDE_ROOT',
  );
});
