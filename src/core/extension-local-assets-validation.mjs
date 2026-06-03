import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const REPORT_SCHEMA_VERSION = 'local-validation-report/v1';
const STATUSES = ['present', 'missing', 'unknown', 'not_checked', 'invalid'];
const SENTINEL_FILENAMES = new Set(['model_index.json', 'pipeline.json', 'pipeline.text-localized.json', 'config.json', 'config.yaml']);
const SENTINEL_EXTENSIONS = new Set(['.safetensors', '.gguf', '.ckpt']);
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const defaultFsAdapter = Object.freeze({ stat, readdir, readFile });

function timestamp(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date().toISOString());
  return value instanceof Date ? value.toISOString() : String(value);
}

function entriesFromLibrary(library) {
  return Array.isArray(library?.entries) ? library.entries : [];
}

function sourceLibrary(library) {
  return {
    schema_version: typeof library?.schema_version === 'string' ? library.schema_version : 'unknown',
    curated_at: typeof library?.curated_at === 'string' ? library.curated_at : 'unknown',
    entry_count: entriesFromLibrary(library).length,
  };
}

function isUltraShapeEntry(entry) {
  const haystack = [
    entry?.id,
    entry?.identity?.name,
    entry?.identity?.repo,
    entry?.identity?.public_url,
    ...(entry?.model_weights ?? []).flatMap((weight) => [weight.id, weight.repo_id]),
  ].filter(Boolean).join(' ');

  return /ultrashape/iu.test(haystack);
}

function isProcessExtension(entry) {
  return entry?.kind === 'process-extension'
    || /process-extension-no-ml-model-assets/iu.test(entry?.no_dependencies_reason ?? '')
    || /mesh-repair|unirig-process-extension/iu.test(entry?.id ?? '');
}

function repoBasename(repo) {
  if (typeof repo !== 'string') {
    return null;
  }

  const parts = repo.split('/').filter(Boolean);
  return parts.at(-1) ?? null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function arrayValues(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [];
}

function unsafeReason(segment) {
  if (typeof segment !== 'string' || segment.length === 0) {
    return 'empty_key';
  }

  if (segment.startsWith('file://')) {
    return 'file_url_key';
  }

  if (segment === '.' || segment === '..' || segment.includes('..')) {
    return 'traversal_key';
  }

  if (segment.includes('/') || segment.includes('\\')) {
    return 'path_separator_key';
  }

  if (path.isAbsolute(segment) || path.win32.isAbsolute(segment) || /^[A-Za-z]:/u.test(segment)) {
    return 'absolute_key';
  }

  if (!SAFE_SEGMENT_PATTERN.test(segment)) {
    return 'unsafe_characters_key';
  }

  return null;
}

export function sanitizeLogicalKey(parts) {
  const sanitizedParts = [];
  for (const part of parts) {
    const reason = unsafeReason(part);
    if (reason) {
      return { status: 'invalid', reason, logical_key: null };
    }
    sanitizedParts.push(part);
  }

  return { status: 'present', logical_key: sanitizedParts.join('/') };
}

function containedPath(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return target;
  }

  return null;
}

function extensionKeyOptions(entry) {
  return unique([
    entry?.local_assets?.extension_id,
    ...(entry?.local_assets?.aliases ?? []),
    ...(entry?.local_assets?.manifest_ids ?? []),
    entry?.local_assets?.manifest_id,
    entry?.manifest?.id,
    repoBasename(entry?.identity?.repo),
  ]);
}

export function deriveExtensionCandidates(entry) {
  const keys = extensionKeyOptions(entry);
  if (keys.length === 0) {
    return [{ status: 'invalid', reason: 'missing_extension_key', logical_key: null }];
  }

  return keys.map((key) => {
    const sanitized = sanitizeLogicalKey(['extensions', key]);
    if (sanitized.status === 'invalid') {
      return { status: 'invalid', reason: 'unsafe_extension_key', unsafe_reason: sanitized.reason, logical_key: null };
    }
    return { status: 'candidate', key, logical_key: sanitized.logical_key };
  });
}

function primaryExtensionId(entry) {
  const candidate = deriveExtensionCandidates(entry).find((item) => item.status === 'candidate');
  return candidate?.key ?? entry?.id ?? repoBasename(entry?.identity?.repo) ?? 'unknown';
}

export function deriveModelCandidates(entry) {
  if (isProcessExtension(entry)) {
    return [{ status: 'not_checked', reason: 'process_extension_has_no_model_assets', logical_key: null }];
  }

  const extensionId = primaryExtensionId(entry);
  return (entry?.model_weights ?? []).flatMap((weight) => {
    const owner = weight?.id || repoBasename(weight?.repo_id);
    const explicitAssets = (entry?.local_assets?.model_assets ?? []).filter((asset) => asset?.weight_id === weight?.id);
    const explicitCandidates = [];
    for (const asset of explicitAssets) {
      const roots = arrayValues(asset.roots).length > 0 ? arrayValues(asset.roots) : arrayValues(entry?.local_assets?.model_roots);
      const subpaths = arrayValues(asset.subpaths);
      for (const root of roots) {
        for (const subpath of subpaths) {
          const pathParts = [root, ...subpath.split('/')];
          const sanitized = sanitizeLogicalKey(['models', ...pathParts]);
          if (sanitized.status === 'invalid') {
            return [{ status: 'invalid', reason: 'unsafe_model_key', logical_key: null, weight }];
          }
          explicitCandidates.push({
            status: 'candidate',
            extensionId: root,
            owner: subpath,
            pathParts,
            logical_key: sanitized.logical_key,
            sentinel_files: arrayValues(asset.sentinel_files),
            weight,
          });
        }
      }
    }
    const sanitized = sanitizeLogicalKey(['models', extensionId, owner]);
    if (!owner || sanitized.status === 'invalid') {
      return [{ status: 'invalid', reason: 'unsafe_model_key', logical_key: null, weight }];
    }
    return [
      ...explicitCandidates,
      { status: 'candidate', extensionId, owner, pathParts: [extensionId, owner], logical_key: sanitized.logical_key, sentinel_files: [], weight },
    ];
  });
}

function localAliasKeys(entry) {
  return unique([
    entry?.local_assets?.extension_id,
    ...(entry?.local_assets?.aliases ?? []),
    ...(entry?.local_assets?.manifest_ids ?? []),
    entry?.local_assets?.manifest_id,
  ]);
}

function buildLocalAliasOwnershipIndex(entries) {
  const index = new Map();
  for (const entry of entries) {
    for (const key of localAliasKeys(entry)) {
      const sanitized = sanitizeLogicalKey(['extensions', key]);
      if (sanitized.status === 'invalid') {
        continue;
      }
      const owners = index.get(key) ?? [];
      owners.push(entry.id);
      index.set(key, owners);
    }
  }
  return index;
}

async function existsDirectory(fsAdapter, directoryPath) {
  try {
    const result = await fsAdapter.stat(directoryPath);
    return result.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonIfExists(fsAdapter, filePath) {
  try {
    return JSON.parse(await fsAdapter.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function checkRepoCorrespondence(entry, metadata) {
  const observedRepo = metadata?.repo ?? metadata?.repository ?? metadata?.public_url;
  if (!observedRepo) {
    return { name: 'repo_correspondence', status: 'unknown', reason: 'metadata_repo_not_declared' };
  }

  const expectedRepo = entry?.identity?.repo;
  const normalizedObserved = String(observedRepo).replace(/^https:\/\/github\.com\//iu, '').replace(/\.git$/iu, '');
  return normalizedObserved === expectedRepo
    ? { name: 'repo_correspondence', status: 'present', reason: 'metadata_repo_matches' }
    : { name: 'repo_correspondence', status: 'invalid', reason: 'metadata_repo_mismatch' };
}

async function validateExtension(entry, root, fsAdapter, aliasOwnershipIndex = new Map()) {
  const candidates = deriveExtensionCandidates(entry);
  const invalid = candidates.find((candidate) => candidate.status === 'invalid');
  if (invalid) {
    return {
      entry_id: entry.id,
      kind: entry.kind ?? 'unknown',
      identity_repo: entry.identity?.repo ?? 'unknown',
      candidate_keys: [],
      status: 'invalid',
      checks: [{ name: 'candidate_key', status: 'invalid', reason: invalid.reason }],
      risks: ['unsafe_extension_candidate'],
    };
  }

  const extensionRoot = containedPath(root, 'extensions');
  const checks = [];
  for (const candidate of candidates) {
    const candidatePath = containedPath(root, 'extensions', candidate.key);
    const present = candidatePath ? await existsDirectory(fsAdapter, candidatePath) : false;
    checks.push({ name: 'directory', logical_key: candidate.logical_key, status: present ? 'present' : 'missing' });
    if (!present) {
      continue;
    }

    const manifest = await readJsonIfExists(fsAdapter, path.join(candidatePath, 'manifest.json'));
    checks.push({
      name: 'manifest_id',
      logical_key: `${candidate.logical_key}/manifest.json`,
      status: manifest?.id ? (manifest.id === candidate.key ? 'present' : 'invalid') : 'unknown',
      reason: manifest?.id ? (manifest.id === candidate.key ? 'manifest_id_matches' : 'manifest_id_mismatch') : 'manifest_id_not_declared',
    });
    checks.push(checkRepoCorrespondence(entry, manifest));
    const repoCorrespondence = checks.find((check) => check.name === 'repo_correspondence');
    const sharedOwners = aliasOwnershipIndex.get(candidate.key) ?? [];
    if (sharedOwners.length > 1 && repoCorrespondence?.status !== 'present') {
      checks.push({
        name: 'shared_alias_ownership',
        logical_key: candidate.logical_key,
        status: repoCorrespondence?.status === 'invalid' ? 'invalid' : 'unknown',
        reason: repoCorrespondence?.status === 'invalid' ? 'shared_alias_repo_mismatch' : 'shared_alias_repo_correspondence_required',
      });
      return {
        entry_id: entry.id,
        kind: entry.kind ?? 'unknown',
        identity_repo: entry.identity?.repo ?? 'unknown',
        candidate_keys: [candidate.logical_key],
        status: repoCorrespondence?.status === 'invalid' ? 'invalid' : 'unknown',
        checks,
        risks: ['presence_only_not_runtime_compatibility', 'shared_alias_requires_repo_correspondence'],
      };
    }

    return {
      entry_id: entry.id,
      kind: entry.kind ?? 'unknown',
      identity_repo: entry.identity?.repo ?? 'unknown',
      candidate_keys: [candidate.logical_key],
      status: checks.some((check) => check.status === 'invalid') ? 'invalid' : 'present',
      checks,
      risks: ['presence_only_not_runtime_compatibility'],
    };
  }

  return {
    entry_id: entry.id,
    kind: entry.kind ?? 'unknown',
    identity_repo: entry.identity?.repo ?? 'unknown',
    candidate_keys: candidates.map((candidate) => candidate.logical_key),
    status: extensionRoot ? 'missing' : 'missing',
    checks,
    risks: ['presence_only_not_runtime_compatibility'],
  };
}

async function collectSentinels(fsAdapter, directoryPath, logicalKey, depth = 0) {
  let entries;
  try {
    entries = await fsAdapter.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const visibleEntries = entries.filter((entry) => !entry.name.startsWith('.'));
  const sentinels = [];
  for (const entry of visibleEntries) {
    const childPath = path.join(directoryPath, entry.name);
    const childLogicalKey = `${logicalKey}/${entry.name}`;
    if (entry.isDirectory() && depth < 2) {
      sentinels.push(...await collectSentinels(fsAdapter, childPath, childLogicalKey, depth + 1));
      continue;
    }
    if (entry.isFile() && (SENTINEL_FILENAMES.has(entry.name) || SENTINEL_EXTENSIONS.has(path.extname(entry.name)))) {
      sentinels.push(childLogicalKey);
    }
  }

  return sentinels;
}

function modelEvidenceIssue(weight) {
  if (typeof weight?.repo_id !== 'string' || weight.repo_id.length === 0) {
    return 'missing_repo_id';
  }

  const files = Array.isArray(weight?.files) ? weight.files : [];
  if (files.some((file) => file?.glob === '**/*')) {
    return 'ambiguous_recursive_glob';
  }

  return null;
}

async function validateModels(entry, root, fsAdapter) {
  const candidates = deriveModelCandidates(entry);
  if (candidates.length === 0) {
    return [];
  }

  const results = [];
  for (const candidate of candidates) {
    if (candidate.status === 'not_checked') {
      results.push({
        entry_id: entry.id,
        kind: entry.kind ?? 'unknown',
        repo_id: 'not_applicable',
        candidate_keys: [],
        status: 'not_checked',
        checks: [{ name: 'model_assets', status: 'not_checked', reason: candidate.reason }],
        unknown_reason: candidate.reason,
        risks: [],
      });
      continue;
    }

    if (candidate.status === 'invalid') {
      results.push({
        entry_id: entry.id,
        kind: entry.kind ?? 'unknown',
        repo_id: candidate.weight?.repo_id ?? 'unknown',
        candidate_keys: [],
        status: 'invalid',
        checks: [{ name: 'candidate_key', status: 'invalid', reason: candidate.reason }],
        risks: ['unsafe_model_candidate'],
      });
      continue;
    }

    const candidatePath = containedPath(root, 'models', ...(candidate.pathParts ?? [candidate.extensionId, candidate.owner]));
    const present = candidatePath ? await existsDirectory(fsAdapter, candidatePath) : false;
    const evidenceIssue = modelEvidenceIssue(candidate.weight);
    if (evidenceIssue) {
      results.push({
        entry_id: entry.id,
        kind: entry.kind ?? 'unknown',
        repo_id: candidate.weight?.repo_id ?? 'unknown',
        candidate_keys: [candidate.logical_key],
        status: 'unknown',
        checks: [
          { name: 'model_directory', logical_key: candidate.logical_key, status: present ? 'present' : 'unknown' },
          { name: 'model_evidence', status: 'unknown', reason: evidenceIssue },
        ],
        unknown_reason: 'model_evidence_ambiguous_or_missing_repo_id',
        risks: ['presence_only_not_runtime_compatibility'],
      });
      continue;
    }

    if (!present) {
      results.push({
        entry_id: entry.id,
        kind: entry.kind ?? 'unknown',
        repo_id: candidate.weight?.repo_id ?? 'unknown',
        candidate_keys: [candidate.logical_key],
        status: 'missing',
        checks: [{ name: 'model_directory', logical_key: candidate.logical_key, status: 'missing' }],
        risks: ['presence_only_not_runtime_compatibility'],
      });
      continue;
    }

    const sentinels = await collectSentinels(fsAdapter, candidatePath, candidate.logical_key);
    const requiredSentinels = arrayValues(candidate.sentinel_files);
    const matchingSentinels = requiredSentinels.length === 0
      ? sentinels
      : sentinels.filter((sentinel) => requiredSentinels.some((required) => sentinel.endsWith(`/${required}`)));
    const hasSentinel = matchingSentinels.length > 0;
    results.push({
      entry_id: entry.id,
      kind: entry.kind ?? 'unknown',
      repo_id: candidate.weight?.repo_id ?? 'unknown',
      candidate_keys: [candidate.logical_key],
      status: hasSentinel ? 'present' : 'unknown',
      checks: [
        { name: 'model_directory', logical_key: candidate.logical_key, status: 'present' },
        { name: 'sentinel_files', status: hasSentinel ? 'present' : 'unknown', logical_keys: matchingSentinels },
      ],
      unknown_reason: hasSentinel ? undefined : 'model_folder_empty_or_no_sentinel_files',
      risks: ['presence_only_not_runtime_compatibility'],
    });
  }

  return results;
}

function summarize(extensions, models) {
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const byKind = { extensions: {}, models: {} };
  for (const [kind, items] of [['extensions', extensions], ['models', models]]) {
    byKind[kind] = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const item of items) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      byKind[kind][item.status] = (byKind[kind][item.status] ?? 0) + 1;
    }
  }

  return { total_items: extensions.length + models.length, by_status: byStatus, by_kind: byKind };
}

function baseReport({ library, root, generatedAt }) {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: generatedAt,
    source_library: sourceLibrary(library),
    root,
    summary: summarize([], []),
    extensions: [],
    models: [],
    risks_unknowns: [],
    non_goals: [
      'No downloads, installs, auth checks, network calls, Electron IPC, FastAPI calls, or runtime compatibility probes.',
      'Presence does not mean functional, compatible, authenticated, or complete.',
    ],
    disclaimer: 'This report is presence-only local asset validation; it never claims runtime compatibility or successful execution.',
  };
}

export function buildNotCheckedReport({ library, rootSource = 'not_supplied', now } = {}) {
  const report = baseReport({
    library,
    root: { supplied: false, source: rootSource, redacted: true },
    generatedAt: timestamp(now),
  });
  report.summary = {
    total_items: 0,
    by_status: { ...Object.fromEntries(STATUSES.map((status) => [status, 0])), not_checked: 1 },
    by_kind: {
      extensions: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      models: Object.fromEntries(STATUSES.map((status) => [status, 0])),
    },
  };
  report.risks_unknowns.push({ code: 'root_not_supplied', status: 'not_checked', message: 'No Modly root was supplied, so filesystem checks were intentionally skipped.' });
  return report;
}

export async function validateExtensionLocalAssets({ library, modlyHome, rootSource = 'not_supplied', now, fsAdapter = defaultFsAdapter } = {}) {
  if (!modlyHome) {
    return buildNotCheckedReport({ library, rootSource: 'not_supplied', now });
  }

  const includedEntries = entriesFromLibrary(library).filter((entry) => !isUltraShapeEntry(entry));
  const excludedUltraShape = entriesFromLibrary(library).length - includedEntries.length;
  const root = { supplied: true, source: rootSource, redacted: true };
  const extensions = [];
  const models = [];
  const aliasOwnershipIndex = buildLocalAliasOwnershipIndex(includedEntries);

  for (const entry of includedEntries) {
    if (!isProcessExtension(entry)) {
      extensions.push(await validateExtension(entry, modlyHome, fsAdapter, aliasOwnershipIndex));
    }
    models.push(...await validateModels(entry, modlyHome, fsAdapter));
  }

  const report = baseReport({ library, root, generatedAt: timestamp(now) });
  report.extensions = extensions;
  report.models = models;
  report.summary = summarize(extensions, models);
  report.risks_unknowns = [
    { code: 'presence_only', status: 'unknown', message: 'Filesystem presence is not runtime or compatibility success.' },
  ];
  if (excludedUltraShape > 0) {
    report.risks_unknowns.push({ code: 'ultrashape_excluded', status: 'not_checked', message: 'UltraShape entries are excluded from this public/nonfunctional validation report.' });
  }
  return report;
}
