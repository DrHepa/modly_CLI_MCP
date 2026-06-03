import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  buildNotCheckedReport,
  deriveExtensionCandidates,
  deriveModelCandidates,
  validateExtensionLocalAssets,
} from '../../src/core/extension-local-assets-validation.mjs'

const FIXED_NOW = () => '2026-05-25T00:00:00.000Z'

async function fixtureRoot() {
  return mkdtemp(path.join(tmpdir(), 'modly-local-assets-'))
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function fixtureLibrary() {
  return {
    schema_version: 'fixture-v1',
    curated_at: '2026-05-25',
    entries: [
      {
        id: 'trellis2-fixture',
        kind: 'external-extension-candidate',
        identity: {
          name: 'Fixture Trellis2',
          repo: 'example/modly-trellis2-extension',
          public_url: 'https://github.com/example/modly-trellis2-extension',
        },
        local_assets: { manifest_id: 'modly.trellis2' },
        model_weights: [
          {
            id: 'trellis2',
            provider: 'Hugging Face',
            repo_id: 'example/trellis2',
            files: [{ glob: '*.safetensors' }],
          },
        ],
      },
      {
        id: 'mesh-repair',
        kind: 'process-extension',
        identity: {
          name: 'Mesh Repair',
          repo: 'example/mesh-repair',
          public_url: 'https://github.com/example/mesh-repair',
        },
        no_dependencies_reason: 'process-extension-no-ml-model-assets',
      },
      {
        id: 'unsafe-extension',
        kind: 'external-extension-candidate',
        identity: {
          name: 'Unsafe Extension',
          repo: 'example/unsafe-extension',
          public_url: 'https://github.com/example/unsafe-extension',
        },
        local_assets: { manifest_id: '../escape' },
      },
      {
        id: 'ultrashape-refiner',
        kind: 'external-extension-candidate',
        identity: {
          name: 'UltraShape Refiner',
          repo: 'example/modly-ultrashape-refiner-model',
          public_url: 'https://github.com/example/modly-ultrashape-refiner-model',
        },
        model_weights: [
          {
            id: 'ultrashape',
            provider: 'Hugging Face',
            repo_id: 'example/ultrashape',
            files: [{ glob: '*.safetensors' }],
          },
        ],
      },
    ],
  }
}

test('core returns controlled not_checked report when no root is supplied', async () => {
  const report = await validateExtensionLocalAssets({ library: fixtureLibrary(), now: FIXED_NOW })

  assert.equal(report.schema_version, 'local-validation-report/v1')
  assert.equal(report.root.source, 'not_supplied')
  assert.equal(report.root.supplied, false)
  assert.equal(report.summary.by_status.not_checked, 1)
  assert.equal(report.extensions.length, 0)
  assert.equal(report.models.length, 0)
  assert.match(report.disclaimer, /presence-only/i)
})

test('not_checked report builder never includes host-local roots', () => {
  const report = buildNotCheckedReport({ library: fixtureLibrary(), rootSource: 'not_supplied', now: FIXED_NOW })

  assert.deepEqual(report.root, { supplied: false, source: 'not_supplied', redacted: true })
  assert.equal(JSON.stringify(report).includes(tmpdir()), false)
})

test('core validates real Modly layout with manifest id extension and custom model owner folders', async () => {
  const root = await fixtureRoot()
  await mkdir(path.join(root, 'extensions', 'modly.trellis2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', 'modly.trellis2', 'manifest.json'), {
    id: 'modly.trellis2',
    repo: 'example/modly-trellis2-extension',
  })
  await mkdir(path.join(root, 'extensions', '.modly-backup-modly.trellis2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', '.modly-backup-modly.trellis2', 'manifest.json'), {
    id: 'modly.backup.only',
  })
  await mkdir(path.join(root, 'models', 'modly.trellis2', 'trellis2'), { recursive: true })
  await writeFile(path.join(root, 'models', 'modly.trellis2', 'trellis2', 'weights.safetensors'), 'fixture')

  const report = await validateExtensionLocalAssets({
    library: fixtureLibrary(),
    modlyHome: root,
    rootSource: 'argument',
    now: FIXED_NOW,
  })

  const extension = report.extensions.find((item) => item.entry_id === 'trellis2-fixture')
  assert.equal(extension.status, 'present')
  assert.deepEqual(extension.candidate_keys, ['extensions/modly.trellis2'])
  assert.equal(extension.checks.find((check) => check.name === 'manifest_id').status, 'present')

  const model = report.models.find((item) => item.entry_id === 'trellis2-fixture')
  assert.equal(model.status, 'present')
  assert.equal(model.checks.find((check) => check.name === 'sentinel_files').status, 'present')
  assert.equal(JSON.stringify(report).includes(root), false)
})

test('explicit local_assets candidates are ordered before repo basename fallback', () => {
  const entry = {
    id: 'priority-fixture',
    kind: 'external-extension-candidate',
    identity: {
      name: 'Priority Fixture',
      repo: 'example/modly-trellis2-extension',
      public_url: 'https://github.com/example/modly-trellis2-extension',
    },
    local_assets: {
      extension_id: 'trellis-2',
      aliases: ['trellis2'],
      manifest_ids: ['modly.trellis2'],
    },
  }

  assert.deepEqual(
    deriveExtensionCandidates(entry).map((candidate) => candidate.logical_key),
    [
      'extensions/trellis-2',
      'extensions/trellis2',
      'extensions/modly.trellis2',
      'extensions/modly-trellis2-extension',
    ],
  )
})

test('model_assets roots, subpaths, and sentinels resolve before legacy weight-id fallback', async () => {
  const root = await fixtureRoot()
  const library = {
    schema_version: 'fixture-v1',
    curated_at: '2026-05-25',
    entries: [{
      id: 'trellis2-local-assets',
      kind: 'external-extension-candidate',
      identity: {
        name: 'Fixture Trellis2 Local Assets',
        repo: 'example/modly-trellis2-extension',
        public_url: 'https://github.com/example/modly-trellis2-extension',
      },
      local_assets: {
        extension_id: 'trellis-2',
        status: 'partial',
        confidence: 'partial',
        evidence_ids: ['fixture-local'],
        model_assets: [{
          weight_id: 'trellis2',
          roots: ['trellis-2'],
          subpaths: ['base-4b'],
          sentinel_files: ['pipeline.json'],
          status: 'partial',
          confidence: 'partial',
          evidence_ids: ['fixture-local'],
        }],
      },
      model_weights: [{
        id: 'trellis2',
        provider: 'Hugging Face',
        repo_id: 'example/trellis2',
        files: [{ glob: 'pipeline.json' }],
      }],
    }],
  }

  assert.deepEqual(
    deriveModelCandidates(library.entries[0]).map((candidate) => candidate.logical_key),
    ['models/trellis-2/base-4b', 'models/trellis-2/trellis2'],
  )

  await mkdir(path.join(root, 'extensions', 'trellis-2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', 'trellis-2', 'manifest.json'), {
    id: 'trellis-2',
    repo: 'example/modly-trellis2-extension',
  })
  await mkdir(path.join(root, 'models', 'trellis-2', 'base-4b'), { recursive: true })
  await writeFile(path.join(root, 'models', 'trellis-2', 'base-4b', 'pipeline.json'), 'fixture')

  const report = await validateExtensionLocalAssets({ library, modlyHome: root, now: FIXED_NOW })
  const model = report.models.find((item) => item.entry_id === 'trellis2-local-assets')

  assert.equal(model.status, 'present')
  assert.deepEqual(model.candidate_keys, ['models/trellis-2/base-4b'])
  assert.equal(model.checks.find((check) => check.name === 'sentinel_files').status, 'present')
  assert.match(report.disclaimer, /Presence.*not.*runtime compatibility|presence-only/i)
})

test('explicit model_assets without sentinel files remain unknown rather than runtime success', async () => {
  const root = await fixtureRoot()
  const library = fixtureLibrary()
  library.entries[0].local_assets = {
    extension_id: 'trellis-2',
    model_assets: [{ weight_id: 'trellis2', roots: ['trellis-2'], subpaths: ['base-4b'], sentinel_files: ['pipeline.json'] }],
  }
  await mkdir(path.join(root, 'extensions', 'trellis-2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', 'trellis-2', 'manifest.json'), { id: 'trellis-2' })
  await mkdir(path.join(root, 'models', 'trellis-2', 'base-4b'), { recursive: true })

  const report = await validateExtensionLocalAssets({ library, modlyHome: root, now: FIXED_NOW })
  const model = report.models.find((item) => item.entry_id === 'trellis2-fixture')

  assert.equal(model.status, 'unknown')
  assert.equal(model.unknown_reason, 'model_folder_empty_or_no_sentinel_files')
  assert.equal(JSON.stringify(model).includes('runtime success'), false)
})

test('shared local aliases require repo correspondence before present status', async () => {
  const root = await fixtureRoot()
  const library = {
    schema_version: 'fixture-v1',
    curated_at: '2026-05-25',
    entries: ['example/modly-hunyuan3d-mini-extension', 'other/modly-hunyuan3d-mini-extension'].map((repo, index) => ({
      id: `shared-hunyuan-${index + 1}`,
      kind: 'external-extension-candidate',
      identity: { name: `Shared Hunyuan ${index + 1}`, repo, public_url: `https://github.com/${repo}` },
      local_assets: { extension_id: 'hunyuan3d-mini' },
      model_weights: [],
    })),
  }
  await mkdir(path.join(root, 'extensions', 'hunyuan3d-mini'), { recursive: true })
  await writeJson(path.join(root, 'extensions', 'hunyuan3d-mini', 'manifest.json'), { id: 'hunyuan3d-mini' })

  const report = await validateExtensionLocalAssets({ library, modlyHome: root, now: FIXED_NOW })
  const statuses = report.extensions.map((item) => item.status)

  assert.deepEqual(statuses, ['unknown', 'unknown'])
  assert.ok(report.extensions.every((item) => item.checks.some((check) => check.name === 'shared_alias_ownership' && check.status === 'unknown')))
})

test('conflicting local extension metadata marks repo correspondence invalid without leaking paths', async () => {
  const root = await fixtureRoot()
  await mkdir(path.join(root, 'extensions', 'modly.trellis2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', 'modly.trellis2', 'manifest.json'), {
    id: 'modly.trellis2',
    public_url: 'https://github.com/other/not-trellis2',
  })

  const report = await validateExtensionLocalAssets({
    library: fixtureLibrary(),
    modlyHome: root,
    rootSource: 'argument',
    now: FIXED_NOW,
  })
  const extension = report.extensions.find((item) => item.entry_id === 'trellis2-fixture')
  const correspondence = extension.checks.find((check) => check.name === 'repo_correspondence')

  assert.equal(extension.status, 'invalid')
  assert.equal(correspondence.status, 'invalid')
  assert.equal(correspondence.reason, 'metadata_repo_mismatch')
  assert.equal(JSON.stringify(report).includes(root), false)
  assert.equal(JSON.stringify(report).includes('other/not-trellis2'), false)
})

test('hidden backup directories are ignored when the public extension folder is absent', async () => {
  const root = await fixtureRoot()
  await mkdir(path.join(root, 'extensions', '.modly-backup-modly.trellis2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', '.modly-backup-modly.trellis2', 'manifest.json'), {
    id: 'modly.trellis2',
  })

  const report = await validateExtensionLocalAssets({ library: fixtureLibrary(), modlyHome: root, now: FIXED_NOW })
  const extension = report.extensions.find((item) => item.entry_id === 'trellis2-fixture')

  assert.equal(extension.status, 'missing')
  assert.equal(extension.checks.some((check) => check.logical_key.includes('.modly-backup')), false)
})

test('empty model placeholders are not reported as complete model presence', async () => {
  const root = await fixtureRoot()
  await mkdir(path.join(root, 'extensions', 'modly.trellis2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', 'modly.trellis2', 'manifest.json'), { id: 'modly.trellis2' })
  await mkdir(path.join(root, 'models', 'modly.trellis2', 'trellis2'), { recursive: true })

  const report = await validateExtensionLocalAssets({ library: fixtureLibrary(), modlyHome: root, now: FIXED_NOW })
  const model = report.models.find((item) => item.entry_id === 'trellis2-fixture')

  assert.equal(model.status, 'unknown')
  assert.equal(model.unknown_reason, 'model_folder_empty_or_no_sentinel_files')
})

test('ambiguous model evidence remains unknown even when local sentinel files exist', async () => {
  const root = await fixtureRoot()
  const library = fixtureLibrary()
  library.entries[0].model_weights = [{
    id: 'trellis2',
    provider: 'Hugging Face',
    files: [{ glob: '**/*' }],
  }]
  await mkdir(path.join(root, 'extensions', 'modly.trellis2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', 'modly.trellis2', 'manifest.json'), { id: 'modly.trellis2' })
  await mkdir(path.join(root, 'models', 'modly.trellis2', 'trellis2'), { recursive: true })
  await writeFile(path.join(root, 'models', 'modly.trellis2', 'trellis2', 'weights.safetensors'), 'fixture')

  const report = await validateExtensionLocalAssets({ library, modlyHome: root, now: FIXED_NOW })
  const model = report.models.find((item) => item.entry_id === 'trellis2-fixture')

  assert.equal(model.status, 'unknown')
  assert.equal(model.unknown_reason, 'model_evidence_ambiguous_or_missing_repo_id')
  assert.equal(model.checks.find((check) => check.name === 'model_evidence').status, 'unknown')
})

test('missing model repo id remains unknown and is never upgraded to complete presence', async () => {
  const root = await fixtureRoot()
  const library = fixtureLibrary()
  library.entries[0].model_weights = [{
    id: 'trellis2',
    provider: 'Hugging Face',
    files: [{ glob: '*.safetensors' }],
  }]
  await mkdir(path.join(root, 'extensions', 'modly.trellis2'), { recursive: true })
  await writeJson(path.join(root, 'extensions', 'modly.trellis2', 'manifest.json'), { id: 'modly.trellis2' })
  await mkdir(path.join(root, 'models', 'modly.trellis2', 'trellis2'), { recursive: true })
  await writeFile(path.join(root, 'models', 'modly.trellis2', 'trellis2', 'weights.safetensors'), 'fixture')

  const report = await validateExtensionLocalAssets({ library, modlyHome: root, now: FIXED_NOW })
  const model = report.models.find((item) => item.entry_id === 'trellis2-fixture')

  assert.equal(model.status, 'unknown')
  assert.equal(model.unknown_reason, 'model_evidence_ambiguous_or_missing_repo_id')
  assert.equal(model.checks.find((check) => check.name === 'model_evidence').reason, 'missing_repo_id')
})

test('process extensions skip ML model checks and UltraShape entries stay excluded', async () => {
  const root = await fixtureRoot()
  const report = await validateExtensionLocalAssets({ library: fixtureLibrary(), modlyHome: root, now: FIXED_NOW })

  const processExtension = report.models.find((item) => item.entry_id === 'mesh-repair')
  assert.equal(processExtension.status, 'not_checked')
  assert.equal(processExtension.unknown_reason, 'process_extension_has_no_model_assets')
  assert.equal(report.extensions.some((item) => /ultrashape/i.test(item.entry_id)), false)
  assert.equal(report.models.some((item) => /ultrashape/i.test(item.entry_id)), false)
  assert.equal(report.risks_unknowns.some((risk) => risk.code === 'ultrashape_excluded'), true)
})

test('unsafe extension candidate keys are invalid and sanitized', () => {
  const [candidate] = deriveExtensionCandidates(fixtureLibrary().entries.find((entry) => entry.id === 'unsafe-extension'))

  assert.equal(candidate.status, 'invalid')
  assert.equal(candidate.reason, 'unsafe_extension_key')
  assert.equal(JSON.stringify(candidate).includes('../escape'), false)
})

test('script emits JSON, prefers --modly-home over MODLY_HOME, and redacts roots', async () => {
  const argRoot = await fixtureRoot()
  const envRoot = await fixtureRoot()

  const result = spawnSync(process.execPath, [
    'scripts/validate-extension-local-assets.mjs',
    '--modly-home',
    argRoot,
  ], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, MODLY_HOME: envRoot },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.root.source, 'argument')
  assert.equal(report.root.supplied, true)
  assert.equal(JSON.stringify(report).includes(argRoot), false)
  assert.equal(JSON.stringify(report).includes(envRoot), false)
})

test('script emits not_checked without a root and does not inspect the local machine', () => {
  const { MODLY_HOME, ...envWithoutRoot } = process.env
  const result = spawnSync(process.execPath, ['scripts/validate-extension-local-assets.mjs'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: envWithoutRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.root.source, 'not_supplied')
  assert.equal(report.summary.by_status.not_checked, 1)
  assert.deepEqual(report.extensions, [])
  assert.deepEqual(report.models, [])
})

test('local validation documentation explains opt-in presence-only behavior without absolute paths', async () => {
  const docPath = path.resolve(import.meta.dirname, '../../docs/extension-dependency-library/local-validation.md')
  const { readFile } = await import('node:fs/promises')
  const doc = await readFile(docPath, 'utf8')

  assert.match(doc, /opt-in/i)
  assert.match(doc, /presence-only/i)
  assert.match(doc, /extensions\/<manifest\.id>/)
  assert.match(doc, /models\/<extension-id>\/<capability-or-weight-owner>/)
  assert.match(doc, /UltraShape remains excluded/i)
  assert.equal(doc.includes('/__LOCAL_MODLY_HOME_SHOULD_NOT_LEAK__'), false)
})
