import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const libraryDir = path.join(repoRoot, 'docs', 'extension-dependency-library');

const requiredFiles = ['library.json', 'schema.json', 'README.md'];

const expectedReposByEntryId = Object.freeze({
  'lightningpixel-hunyuan3d-mini': 'lightningpixel/modly-hunyuan3d-mini-extension',
  'lightningpixel-hunyuan3d-fast': 'lightningpixel/modly-hunyuan3d-mini-fast-extension',
  'lightningpixel-hunyuan3d-turbo': 'lightningpixel/modly-hunyuan3d-mini-turbo-extension',
  'lightningpixel-trellis2': 'lightningpixel/modly-trellis2-extension',
  'lightningpixel-trellis2-gguf': 'lightningpixel/modly-trellis2-gguf-extension',
  'lightningpixel-triposg': 'lightningpixel/modly-triposg-extension',
  'drhepa-triposg': 'DrHepa/modly-triposg-extension',
  'drhepa-trellis-text': 'DrHepa/modly-trellis-text-extension',
  'drhepa-trellis2-gguf': 'DrHepa/modly-trellis2-gguf-extension',
  'drhepa-pixal3d': 'DrHepa/modly-pixal3d-extension',
  'drhepa-hunyuan3d-part': 'DrHepa/Hunyuan3D-Part-modly-extension',
  'drhepa-hunyuan3d-mv': 'DrHepa/hunyuan3d_mv_extension_modly',
  'iammojogo-hunyuan3d-part': 'iammojogo-sudo/hunyuan3D-Part_modly',
  'iammojogo-hunyuan3d-mv': 'iammojogo-sudo/hunyuan3D-2mv-modly',
  'drhepa-hunyuan3d-mini': 'DrHepa/modly-hunyuan3d-mini-extension',
  'drhepa-trellis2-fork': 'DrHepa/modly-trellis2-extension',
  'drhepa-unirig': 'DrHepa/UniRig-workspace_extension_modly',
  'drhepa-kimodo': 'DrHepa/Kimodo-modly-extension',
  'iammojogo-hunyuandit': 'iammojogo-sudo/hunyuanDIT1.2_t2i_modly',
});

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function collectStrings(value, pathParts = []) {
  if (typeof value === 'string') {
    return [{ path: pathParts.join('.'), value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStrings(item, [...pathParts, String(index)]));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => collectStrings(item, [...pathParts, key]));
  }

  return [];
}

function assertEnumValue(enums, enumName, value, context) {
  assert.ok(enums[enumName].includes(value), `${context} must use ${enumName}; received ${value}`);
}

function evidenceById(entry) {
  return new Map(entry.evidence.map((record) => [record.id, record]));
}

function githubRepoFromSource(source) {
  const httpsMatch = source.match(/^https:\/\/github\.com\/([^/]+\/[^/#?]+)(?:[/?#].*)?$/iu);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  const repoIdMatch = source.match(/^([^\s/]+\/[^\s/]+)$/iu);
  return repoIdMatch?.[1] ?? null;
}

function claimEvidence(entry, claim) {
  const byId = evidenceById(entry);
  return (claim.evidence_ids ?? []).map((id) => byId.get(id)).filter(Boolean);
}

function collectPackages(library) {
  return library.entries.flatMap((entry) =>
    (entry.dependency_groups ?? []).flatMap((group) =>
      (group.packages ?? []).map((pkg) => ({ entry, group, pkg })),
    ),
  );
}

function assertEvidenceIdsResolve(entry, evidenceIds, context) {
  const ids = new Set(entry.evidence.map((record) => record.id));
  assert.ok(evidenceIds.length > 0, `${context} must reference evidence ids`);
  for (const id of evidenceIds) {
    assert.ok(ids.has(id), `${context} evidence id ${id} must resolve within ${entry.id}`);
  }
}

function assertSafeSegment(value, context) {
  assert.equal(typeof value, 'string', `${context} must be a string`);
  assert.doesNotMatch(value, /^file:\/\//iu, `${context} must not be a file URL`);
  assert.doesNotMatch(value, /^https?:\/\//iu, `${context} must not be a URL`);
  assert.doesNotMatch(value, /[\\/]/u, `${context} must be a logical segment, not a path`);
  assert.doesNotMatch(value, /(?:^|\.)\.($|\.)/u, `${context} must not contain traversal`);
  assert.doesNotMatch(value, /^[A-Za-z]:/u, `${context} must not be a Windows absolute path`);
  assert.doesNotMatch(value, /^\//u, `${context} must not be an absolute path`);
  assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, `${context} must be path-safe`);
}

function assertSafeRelativePath(value, context) {
  assert.equal(typeof value, 'string', `${context} must be a string`);
  assert.doesNotMatch(value, /^file:\/\//iu, `${context} must not be a file URL`);
  assert.doesNotMatch(value, /^https?:\/\//iu, `${context} must not be a URL`);
  assert.doesNotMatch(value, /^\//u, `${context} must not be absolute`);
  assert.doesNotMatch(value, /^[A-Za-z]:/u, `${context} must not be a Windows absolute path`);
  for (const [index, segment] of value.split('/').entries()) {
    assertSafeSegment(segment, `${context}[${index}]`);
  }
}

function packagesByName(group) {
  return new Map((group?.packages ?? []).map((pkg) => [pkg.name, pkg]));
}

function packageNames(entry) {
  return new Set((entry.dependency_groups ?? []).flatMap((group) => (group.packages ?? []).map((pkg) => pkg.name)));
}

function buildDependencyView(entry) {
  return {
    inventory_groups: (entry.dependency_groups ?? []).map((group) => ({
      id: group.id,
      kind: group.kind,
      scope: group.scope,
      purpose: [...(group.purpose ?? [])],
      accelerator_lanes: [...(group.accelerator_lanes ?? [])],
      packages: (group.packages ?? []).map((pkg) => ({
        name: pkg.name,
        specifier: pkg.specifier,
        native_abi_risk: pkg.native_abi_risk,
        source: pkg.source,
        confidence: pkg.confidence,
        evidence_ids: [...(pkg.evidence_ids ?? [])],
        optional: pkg.optional,
        fallback: pkg.fallback,
        build_mode: pkg.build_mode,
      })),
    })),
    upstream_stack_lanes: (entry.upstream_requirements?.stack_lanes ?? []).map((lane) => ({
      lane_id: lane.lane_id,
      status: lane.status,
      packages: (lane.packages ?? []).map((pkg) => ({
        name: pkg.name,
        specifier: pkg.specifier,
      })),
    })),
  };
}

test('extension dependency library artifacts exist and are parseable', () => {
  for (const filename of requiredFiles) {
    assert.equal(existsSync(path.join(libraryDir, filename)), true, `${filename} must exist`);
  }

  assert.equal(typeof readJson('docs/extension-dependency-library/library.json').schema_version, 'string');
  assert.equal(typeof readJson('docs/extension-dependency-library/schema.json').schema_version, 'string');
  assert.match(readText('docs/extension-dependency-library/README.md'), /repo-local\/document-only/iu);
});

test('schema exposes required sections and controlled enums', () => {
  const schema = readJson('docs/extension-dependency-library/schema.json');

  assert.deepEqual(schema.required_top_level, [
    'schema_version',
    'curated_at',
    'confidence_scale',
    'entries',
    'shared_clusters',
    'global_unknowns',
  ]);
  assert.deepEqual(schema.required_entry_fields, [
    'id',
    'kind',
    'identity',
    'relationship',
    'install',
    'runtime',
    'models',
    'platform_support',
    'dependency_summary',
    'dependency_groups',
    'model_weights',
    'cluster_refs',
    'dependency_risks',
    'evidence',
    'unknowns',
  ]);

  assert.deepEqual(schema.enums.confidence, ['confirmed', 'strong', 'partial', 'weak', 'unknown']);
  assert.deepEqual(schema.enums.source_type, ['github-repo', 'github-file', 'github-release', 'huggingface-model', 'package-index', 'docs', 'registry-record', 'unknown']);
  assert.ok(schema.enums.relationship.includes('official-registry'));
  assert.ok(schema.enums.platform.includes('amd-rocm'));
  assert.ok(schema.enums.support_status.includes('supported'));
  assert.ok(schema.enums.install_mechanism.includes('huggingface-download'));
  assert.ok(schema.enums.runtime_ownership.includes('backend-runtime'));
  assert.ok(schema.enums.risk_marker.includes('amd-rocm-unknown'));
  assert.ok(schema.enums.dependency_group_kind.includes('python'));
  assert.ok(schema.enums.package_source_type.includes('custom-index'));
  assert.ok(schema.enums.accelerator_lane.includes('cuda'));
  assert.ok(schema.enums.native_abi_risk.includes('high'));
  assert.ok(schema.enums.download_owner.includes('extension-runtime'));
  assert.ok(schema.enums.auth_requirement.includes('unknown'));
  assert.match(schema.github_identity_contract.rule, /identity\.public_url.*identity\.repo/iu);
  assert.match(schema.github_evidence_consistency_contract.rule, /GitHub evidence.*identity\.repo/iu);
  assert.ok(schema.local_assets_contract, 'schema must document local_assets contract');
  assert.deepEqual(schema.enums.local_asset_status, ['confirmed', 'partial', 'deferred_no_evidence']);
  assert.match(schema.local_assets_contract.rule, /logical.*extensions\//iu);
  assert.match(schema.local_assets_contract.path_safety, /No host-local absolute paths/iu);
  assert.match(schema.local_assets_contract.presence_semantics, /not runtime compatibility/iu);
  assert.ok(schema.upstream_requirements_contract, 'schema must document upstream_requirements contract');
  assert.deepEqual(schema.enums.upstream_source_of_truth, ['extension-upstream', 'model-card', 'wrapper', 'mixed-evidence', 'unknown']);
  assert.deepEqual(schema.enums.upstream_ref_type, ['branch', 'tag', 'commit', 'release', 'unknown']);
  assert.deepEqual(schema.enums.upstream_setup_kind, ['none', 'python-root-setup-py', 'custom', 'unknown']);
  assert.deepEqual(schema.enums.upstream_lane_status, ['supported', 'experimental', 'blocked', 'unknown']);
  assert.deepEqual(schema.enums.wheelhouse_policy, ['none', 'preferred', 'required', 'unknown']);
  assert.match(schema.upstream_requirements_contract.rule, /without claiming Modly runtime enforcement/iu);
});

test('entries with upstream_requirements expose evidence-backed exact stack lane metadata', () => {
  const schema = readJson('docs/extension-dependency-library/schema.json');
  const library = readJson('docs/extension-dependency-library/library.json');
  const entries = library.entries.filter((entry) => entry.upstream_requirements);

  assert.ok(entries.length >= 3, 'pilot must add at least three upstream_requirements entries');

  for (const entry of entries) {
    const requirements = entry.upstream_requirements;

    for (const field of schema.upstream_requirements_contract.required_fields_when_present) {
      assert.ok(field in requirements, `${entry.id}.upstream_requirements must include ${field}`);
    }

    assert.equal(requirements.contract_version, '1.0.0', `${entry.id} must use upstream_requirements contract version 1.0.0`);
    assertEnumValue(schema.enums, 'upstream_source_of_truth', requirements.source_of_truth, `${entry.id}.upstream_requirements.source_of_truth`);
    assertEnumValue(schema.enums, 'upstream_ref_type', requirements.extension_ref.ref_type, `${entry.id}.upstream_requirements.extension_ref.ref_type`);
    assertEnumValue(schema.enums, 'upstream_setup_kind', requirements.manifest_contract.setup_kind, `${entry.id}.upstream_requirements.manifest_contract.setup_kind`);
    assert.ok(Array.isArray(requirements.dependency_sources) && requirements.dependency_sources.length > 0, `${entry.id}.upstream_requirements.dependency_sources must not be empty`);

    for (const source of requirements.dependency_sources) {
      assertEnumValue(schema.enums, 'upstream_dependency_source_kind', source.kind, `${entry.id}.upstream_requirements.dependency_sources.kind`);
      assert.match(source.url, /^https:\/\//u, `${entry.id}.upstream_requirements.dependency_sources.url must be a public https URL`);
    }

    const laneIds = requirements.stack_lanes.map((lane) => lane.lane_id);
    assert.equal(new Set(laneIds).size, laneIds.length, `${entry.id}.upstream_requirements.stack_lanes lane_id values must be unique`);

    for (const lane of requirements.stack_lanes) {
      for (const field of schema.upstream_requirements_contract.lane_required_fields) {
        assert.ok(field in lane, `${entry.id}.${lane.lane_id} must include ${field}`);
      }

      assertEnumValue(schema.enums, 'upstream_stack_os', lane.os, `${entry.id}.${lane.lane_id}.os`);
      assertEnumValue(schema.enums, 'upstream_stack_arch', lane.arch, `${entry.id}.${lane.lane_id}.arch`);
      assert.match(lane.python.specifier, /==?\d+\.\d+/u, `${entry.id}.${lane.lane_id}.python.specifier must be explicit`);
      assertEnumValue(schema.enums, 'upstream_accelerator_type', lane.accelerator.type, `${entry.id}.${lane.lane_id}.accelerator.type`);
      assert.ok(Array.isArray(lane.torch.packages) && lane.torch.packages.length > 0, `${entry.id}.${lane.lane_id}.torch.packages must not be empty`);
      assert.equal(typeof lane.wheel_policy.binary_only_preferred, 'boolean', `${entry.id}.${lane.lane_id}.wheel_policy.binary_only_preferred must be boolean`);
      assert.equal(typeof lane.wheel_policy.source_build_allowed, 'boolean', `${entry.id}.${lane.lane_id}.wheel_policy.source_build_allowed must be boolean`);
      assertEnumValue(schema.enums, 'native_abi_risk', lane.wheel_policy.native_abi_risk, `${entry.id}.${lane.lane_id}.wheel_policy.native_abi_risk`);
      assertEnumValue(schema.enums, 'upstream_lane_status', lane.status, `${entry.id}.${lane.lane_id}.status`);
    }

    assert.ok(Array.isArray(requirements.setup_requirements.injected_inputs), `${entry.id}.upstream_requirements.setup_requirements.injected_inputs must be an array`);
    assert.ok(requirements.setup_requirements.injected_inputs.includes('python_exe'), `${entry.id}.upstream_requirements must declare python_exe injection`);
    assert.ok(requirements.setup_requirements.injected_inputs.includes('ext_dir'), `${entry.id}.upstream_requirements must declare ext_dir injection`);
    assert.equal(typeof requirements.resolution_policy.pins_required, 'boolean', `${entry.id}.upstream_requirements.resolution_policy.pins_required must be boolean`);
    assert.equal(typeof requirements.resolution_policy.lockfile_present, 'boolean', `${entry.id}.upstream_requirements.resolution_policy.lockfile_present must be boolean`);
    assertEnumValue(schema.enums, 'wheelhouse_policy', requirements.resolution_policy.wheelhouse_policy, `${entry.id}.upstream_requirements.resolution_policy.wheelhouse_policy`);
    assertEnumValue(schema.enums, 'validation_inventory', requirements.validation_status.inventory, `${entry.id}.upstream_requirements.validation_status.inventory`);
    assertEnumValue(schema.enums, 'validation_contract', requirements.validation_status.install_contract, `${entry.id}.upstream_requirements.validation_status.install_contract`);
    assertEnumValue(schema.enums, 'validation_contract', requirements.validation_status.runtime_contract, `${entry.id}.upstream_requirements.validation_status.runtime_contract`);
  }
});

test('dependency consumers can build inventory views from dependency_groups without a flat dependencies field', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));

  for (const entryId of ['sd15', 'drhepa-unirig', 'drhepa-trellis2-gguf']) {
    const entry = entriesById.get(entryId);
    assert.ok(entry, `${entryId} must exist`);
    assert.ok(!Object.hasOwn(entry, 'dependencies'), `${entryId} must not require a flat dependencies field`);
  }

  const sd15View = buildDependencyView(entriesById.get('sd15'));
  const unirigView = buildDependencyView(entriesById.get('drhepa-unirig'));
  const trellisGgufView = buildDependencyView(entriesById.get('drhepa-trellis2-gguf'));

  assert.equal(sd15View.inventory_groups[0]?.id, 'python-runtime', 'sd15 view must carry dependency group id');
  assert.equal(sd15View.inventory_groups[0]?.kind, 'python', 'sd15 view must carry dependency group kind');
  assert.equal(sd15View.inventory_groups[0]?.scope, 'shared-runtime', 'sd15 view must carry dependency group scope');
  assert.ok(sd15View.inventory_groups[0]?.purpose.includes('runtime'), 'sd15 view must carry dependency group purpose');
  assert.ok(sd15View.inventory_groups[0]?.accelerator_lanes.includes('cuda'), 'sd15 view must carry dependency accelerator lanes');
  assert.ok(sd15View.inventory_groups[0]?.packages.some((pkg) => pkg.name === 'diffusers'), 'sd15 view must include diffusers from dependency_groups packages');

  assert.ok(unirigView.inventory_groups.some((group) => group.packages.some((pkg) => pkg.name === 'torch_scatter')), 'drhepa-unirig view must include torch_scatter from dependency_groups packages');
  assert.ok(unirigView.inventory_groups.some((group) => group.packages.some((pkg) => pkg.name === 'spconv-cu126')), 'drhepa-unirig view must include spconv-cu126 from dependency_groups packages');
  const unirigNativePkg = unirigView.inventory_groups.flatMap((group) => group.packages).find((pkg) => pkg.name === 'spconv-cu126');
  assert.equal(unirigNativePkg?.native_abi_risk, 'high', 'drhepa-unirig view must carry native ABI risk');
  assert.equal(unirigNativePkg?.source?.type, 'package-index', 'drhepa-unirig view must carry source metadata');
  assert.equal(unirigNativePkg?.confidence, 'partial', 'drhepa-unirig view must carry confidence metadata');

  assert.ok(trellisGgufView.inventory_groups.some((group) => group.packages.some((pkg) => pkg.name === 'gguf')), 'drhepa-trellis2-gguf view must include gguf from dependency_groups packages');
  assert.ok(trellisGgufView.inventory_groups.some((group) => group.packages.some((pkg) => pkg.name === 'cumesh')), 'drhepa-trellis2-gguf view must include cumesh from dependency_groups packages');
  assert.ok(trellisGgufView.upstream_stack_lanes.some((lane) => lane.packages.some((pkg) => pkg.name === 'gguf')), 'drhepa-trellis2-gguf view must expose upstream stack lane packages separately');
});

test('pilot upstream_requirements cover triposg, trellis2-gguf, and flux-schnell critical risks honestly', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));

  const triposg = entriesById.get('lightningpixel-triposg');
  const trellisGguf = entriesById.get('lightningpixel-trellis2-gguf');
  const flux = entriesById.get('flux-schnell');

  assert.ok(triposg?.upstream_requirements, 'triposg pilot must define upstream_requirements');
  assert.ok(trellisGguf?.upstream_requirements, 'trellis2-gguf pilot must define upstream_requirements');
  assert.ok(flux?.upstream_requirements, 'flux-schnell pilot must define upstream_requirements');

  assert.ok(packagesByName(triposg.dependency_groups[0]).has('diso'), 'triposg dependency inventory must include diso');
  assert.ok(triposg.dependency_risks.some((risk) => /diso/iu.test(risk.claim)), 'triposg risk inventory must call out diso');
  assert.equal(triposg.upstream_requirements.stack_lanes[0].lane_id, 'windows-x64-py311-cu124');

  const trellisPackages = packagesByName(trellisGguf.dependency_groups[0]);
  assert.ok(trellisPackages.has('cumesh'), 'trellis2-gguf dependency inventory must include cumesh');
  assert.ok(trellisPackages.has('flex-gemm'), 'trellis2-gguf dependency inventory must include flex-gemm');
  assert.ok(!trellisPackages.has('llama-cpp-python'), 'trellis2-gguf pilot must not keep the old llama-cpp-python assumption');
  assert.equal(trellisGguf.model_weights[0].repo_id, 'Aero-Ex/Trellis2-GGUF', 'trellis2-gguf pilot must use the Aero-Ex Trellis2-GGUF model source');
  assert.ok(JSON.stringify(trellisGguf).includes('https://huggingface.co/Aero-Ex/Trellis2-GGUF'), 'trellis2-gguf pilot must cite the Aero-Ex Trellis2-GGUF source');
  assert.ok(!JSON.stringify(trellisGguf).includes('city96/TRELLIS-image-large-gguf'), 'trellis2-gguf pilot must not cite the old city96 source');
  assert.ok(/cumesh/i.test(JSON.stringify(trellisGguf.upstream_requirements)) && /flex-gemm/i.test(JSON.stringify(trellisGguf.upstream_requirements)), 'trellis2-gguf upstream_requirements must preserve native wheel hotspots');

  assert.equal(flux.model_weights[0].auth, 'gated', 'flux-schnell pilot must remain gated');
  assert.ok(flux.dependency_risks.some((risk) => risk.marker === 'gated-weights'), 'flux-schnell pilot must include gated-weights risk');
  assert.ok(flux.upstream_requirements.dependency_sources.some((source) => source.kind === 'model-card'), 'flux-schnell pilot must reference a model-card source');
});

test('repo-specific fork entries exist with public sources, family risks, and conservative lanes', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));

  const requiredForks = [
    ['drhepa-triposg', 'DrHepa/modly-triposg-extension'],
    ['drhepa-trellis2-gguf', 'DrHepa/modly-trellis2-gguf-extension'],
    ['iammojogo-hunyuan3d-part', 'iammojogo-sudo/hunyuan3D-Part_modly'],
    ['iammojogo-hunyuan3d-mv', 'iammojogo-sudo/hunyuan3D-2mv-modly'],
  ];

  for (const [entryId, repo] of requiredForks) {
    const entry = entriesById.get(entryId);
    assert.ok(entry, `${entryId} must exist`);
    assert.equal(entry.identity.repo, repo, `${entryId} must map to the exact fork repo`);
    assert.ok(entry.upstream_requirements, `${entryId} must define upstream_requirements`);
    assert.equal(entry.upstream_requirements.extension_ref.repo, repo, `${entryId} upstream_requirements must point to the same fork repo`);
    assert.ok(entry.upstream_requirements.dependency_sources.length > 0, `${entryId} must define dependency_sources`);
    assert.ok(entry.upstream_requirements.dependency_sources.some((source) => /^https:\/\//u.test(source.url)), `${entryId} dependency_sources must keep public URLs`);
    assert.ok(entry.platform_support.every((support) => support.status !== 'supported'), `${entryId} must not claim supported runtime lanes by default`);
    assert.ok(entry.upstream_requirements.stack_lanes.every((lane) => ['unknown', 'experimental'].includes(lane.status)), `${entryId} stack lanes must stay conservative`);
  }

  const drhepaTriposg = entriesById.get('drhepa-triposg');
  const drhepaTriposgPackages = packageNames(drhepaTriposg);
  assert.ok(drhepaTriposgPackages.has('diso'), 'drhepa-triposg must preserve diso in the dependency inventory');
  assert.ok(drhepaTriposg.dependency_risks.some((risk) => /diso/iu.test(risk.claim)), 'drhepa-triposg must preserve diso ABI risk');

  const drhepaTrellisGguf = entriesById.get('drhepa-trellis2-gguf');
  const drhepaTrellisGgufPackages = packageNames(drhepaTrellisGguf);
  assert.ok(drhepaTrellisGgufPackages.has('gguf'), 'drhepa-trellis2-gguf must preserve gguf inventory');
  assert.ok(drhepaTrellisGgufPackages.has('cumesh'), 'drhepa-trellis2-gguf must preserve cumesh inventory');
  assert.ok(drhepaTrellisGgufPackages.has('flex-gemm'), 'drhepa-trellis2-gguf must preserve flex-gemm inventory');
  assert.ok(!drhepaTrellisGgufPackages.has('llama-cpp-python'), 'drhepa-trellis2-gguf must not reintroduce llama-cpp-python without evidence');
  assert.equal(drhepaTrellisGguf.model_weights[0].repo_id, 'Aero-Ex/Trellis2-GGUF', 'drhepa-trellis2-gguf must use the Aero-Ex Trellis2-GGUF model source');
  assert.ok(JSON.stringify(drhepaTrellisGguf).includes('https://huggingface.co/Aero-Ex/Trellis2-GGUF'), 'drhepa-trellis2-gguf must cite the Aero-Ex Trellis2-GGUF source');
  assert.ok(!JSON.stringify(drhepaTrellisGguf).includes('city96/TRELLIS-image-large-gguf'), 'drhepa-trellis2-gguf must not cite the old city96 source');
  assert.match(JSON.stringify(drhepaTrellisGguf.upstream_requirements), /gguf/iu, 'drhepa-trellis2-gguf upstream_requirements must preserve gguf guidance');
  assert.match(JSON.stringify(drhepaTrellisGguf.upstream_requirements), /cumesh|flex-gemm|nvdiffrast/iu, 'drhepa-trellis2-gguf upstream_requirements must preserve native wheel hotspots');

  const iammojogoPart = entriesById.get('iammojogo-hunyuan3d-part');
  assert.match(JSON.stringify(iammojogoPart), /spconv/iu, 'iammojogo-hunyuan3d-part must preserve sparse-conv risk');
  assert.match(JSON.stringify(iammojogoPart), /torch_scatter|torch_cluster|chamfer3D|sonata/iu, 'iammojogo-hunyuan3d-part must preserve the native segmentation stack');

  const iammojogoMv = entriesById.get('iammojogo-hunyuan3d-mv');
  assert.match(JSON.stringify(iammojogoMv), /custom_rasterizer/iu, 'iammojogo-hunyuan3d-mv must preserve custom_rasterizer risk');
  assert.match(JSON.stringify(iammojogoMv), /differentiable_renderer|xatlas|onnxruntime-gpu/iu, 'iammojogo-hunyuan3d-mv must preserve renderer and raster stack risk');
});

test('HunyuanDiT, SD15, and SDXL Base keep the requested auth and dependency semantics', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));

  const hunyuan = entriesById.get('iammojogo-hunyuandit');
  const sd15 = entriesById.get('sd15');
  const sdxl = entriesById.get('sdxl-base');
  const flux = entriesById.get('flux-schnell');

  assert.ok(hunyuan, 'iammojogo-hunyuandit entry must exist without duplication');
  assert.ok(sd15, 'sd15 entry must exist without duplication');
  assert.ok(sdxl, 'sdxl-base entry must exist without duplication');
  assert.ok(flux, 'flux-schnell entry must exist for gated sanity checks');

  const hunyuanPackages = packagesByName(hunyuan.dependency_groups[0]);
  for (const pkg of ['diffusers', 'transformers', 'accelerate', 'tiktoken', 'protobuf']) {
    assert.ok(hunyuanPackages.has(pkg), `iammojogo-hunyuandit dependency inventory must include ${pkg}`);
  }
  assert.equal(hunyuan.model_weights[0].auth, 'none', 'iammojogo-hunyuandit must not invent gated auth');
  assert.match(hunyuan.model_weights[0].repo_id, /Tencent-Hunyuan\/HunyuanDiT-v1\.2-Diffusers-Distilled/u, 'iammojogo-hunyuandit must preserve the upstream distilled repo');
  const hunyuanLaneIds = hunyuan.upstream_requirements.stack_lanes.map((lane) => lane.lane_id);
  assert.ok(hunyuanLaneIds.includes('linux-x64-py311-cu128'), 'iammojogo-hunyuandit must record a cu128 torch lane');
  assert.ok(hunyuanLaneIds.includes('linux-x64-py311-cu124'), 'iammojogo-hunyuandit must record a cu124 torch lane');
  assert.ok(hunyuanLaneIds.includes('linux-x64-py311-cu118'), 'iammojogo-hunyuandit must record a cu118 torch lane');
  for (const lane of hunyuan.upstream_requirements.stack_lanes) {
    const lanePackages = new Set((lane.packages ?? []).map((pkg) => pkg.name));
    for (const pkg of ['diffusers', 'transformers', 'accelerate', 'tiktoken', 'protobuf']) {
      assert.ok(lanePackages.has(pkg), `iammojogo-hunyuandit ${lane.lane_id} must preserve ${pkg}`);
    }
  }
  assert.ok(!hunyuanPackages.has('gguf'), 'iammojogo-hunyuandit must not inventory a gguf package path');
  assert.ok(!hunyuanPackages.has('bitsandbytes'), 'iammojogo-hunyuandit must not inventory a bitsandbytes quantized path');
  assert.ok(!JSON.stringify(hunyuan.model_weights).match(/gguf|bitsandbytes/iu), 'iammojogo-hunyuandit model weights must not claim gguf or bitsandbytes artifacts');

  const sd15Packages = packagesByName(sd15.dependency_groups[0]);
  for (const pkg of ['diffusers', 'transformers', 'accelerate', 'safetensors', 'huggingface_hub', 'pillow', 'numpy', 'sentencepiece', 'scipy']) {
    assert.ok(sd15Packages.has(pkg), `sd15 dependency inventory must include ${pkg}`);
  }
  assert.equal(sd15Packages.get('diffusers')?.specifier, '==0.35.1', 'sd15 must preserve diffusers==0.35.1');
  assert.equal(sd15Packages.get('transformers')?.specifier, '>=4.46,<5', 'sd15 must preserve transformers>=4.46,<5');
  assert.equal(sd15.model_weights[0].auth, 'none', 'sd15 model weights must not be gated');
  assert.ok(!sd15.cluster_refs.includes('gated-weights'), 'sd15 must not be classified in the gated-weights cluster');
  assert.match(JSON.stringify(sd15.upstream_requirements), /local-image-models|shared local-image-models runtime/iu, 'sd15 upstream_requirements must preserve shared local-image-models runtime evidence');

  const sdxlPackages = packagesByName(sdxl.dependency_groups[0]);
  for (const pkg of ['diffusers', 'transformers', 'accelerate', 'safetensors', 'huggingface_hub', 'pillow', 'numpy', 'sentencepiece', 'scipy']) {
    assert.ok(sdxlPackages.has(pkg), `sdxl-base dependency inventory must include ${pkg}`);
  }
  assert.ok(sdxlPackages.has('invisible-watermark'), 'sdxl-base dependency inventory must preserve invisible-watermark guidance');
  assert.equal(sdxlPackages.get('diffusers')?.specifier, '==0.35.1', 'sdxl-base must preserve diffusers==0.35.1');
  assert.equal(sdxlPackages.get('transformers')?.specifier, '>=4.46,<5', 'sdxl-base must preserve transformers>=4.46,<5');
  assert.equal(sdxl.model_weights[0].auth, 'none', 'sdxl-base model weights must not be gated');
  assert.ok(!sdxl.cluster_refs.includes('gated-weights'), 'sdxl-base must not be classified in the gated-weights cluster');
  const sdxlJson = JSON.stringify(sdxl);
  assert.match(sdxlJson, /higher VRAM than SD15|heavier VRAM|>=12GB VRAM/iu, 'sdxl-base must record heavier VRAM planning notes than SD15');
  assert.equal(sdxl.upstream_requirements.validation_status.runtime_contract, 'unknown', 'sdxl-base VRAM notes must remain evidence-only rather than runtime enforcement');

  assert.equal(flux.model_weights[0].auth, 'gated', 'flux-schnell must remain gated');
  assert.ok(flux.cluster_refs.includes('gated-weights'), 'flux-schnell must remain in the gated-weights cluster');
});

test('next Hunyuan3D LightningPixel batch documents conservative upstream requirements without inventing gating', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));

  const mini = entriesById.get('lightningpixel-hunyuan3d-mini');
  const fast = entriesById.get('lightningpixel-hunyuan3d-fast');
  const turbo = entriesById.get('lightningpixel-hunyuan3d-turbo');

  for (const [entryId, entry] of [
    ['lightningpixel-hunyuan3d-mini', mini],
    ['lightningpixel-hunyuan3d-fast', fast],
    ['lightningpixel-hunyuan3d-turbo', turbo],
  ]) {
    assert.ok(entry?.upstream_requirements, `${entryId} must define upstream_requirements in this migration batch`);
    assert.ok(entry.upstream_requirements.stack_lanes.every((lane) => ['experimental', 'unknown'].includes(lane.status)), `${entryId} lanes must stay conservative`);
    assert.equal(entry.model_weights[0].auth, 'unknown', `${entryId} must not invent gated model access without explicit evidence`);
    assert.ok(entry.dependency_risks.some((risk) => risk.marker === 'large-download'), `${entryId} must preserve large-download risk`);
    assert.ok(entry.upstream_requirements.dependency_sources.some((source) => source.kind === 'model-card'), `${entryId} must reference a model-card dependency source`);
  }

  const miniJson = JSON.stringify(mini.upstream_requirements);
  assert.match(miniJson, /diffusers/iu, 'lightningpixel-hunyuan3d-mini must preserve diffusers in upstream requirements guidance');
  assert.match(miniJson, /transformers/iu, 'lightningpixel-hunyuan3d-mini must preserve transformers in upstream requirements guidance');
  assert.match(miniJson, /spconv|flash-attn/iu, 'lightningpixel-hunyuan3d-mini must preserve native ABI hotspots in upstream requirements guidance');
  assert.ok(mini.dependency_risks.some((risk) => risk.marker === 'native-abi'), 'lightningpixel-hunyuan3d-mini must preserve native-abi risk');

  const fastJson = JSON.stringify(fast.upstream_requirements);
  assert.match(fastJson, /transformers/iu, 'lightningpixel-hunyuan3d-fast must preserve transformers in upstream requirements guidance');
  assert.match(fastJson, /huggingface_hub/iu, 'lightningpixel-hunyuan3d-fast must preserve huggingface_hub in upstream requirements guidance');

  const turboJson = JSON.stringify(turbo.upstream_requirements);
  assert.match(turboJson, /accelerate/iu, 'lightningpixel-hunyuan3d-turbo must preserve accelerate in upstream requirements guidance');
  assert.match(turboJson, /safetensors/iu, 'lightningpixel-hunyuan3d-turbo must preserve safetensors in upstream requirements guidance');
});

test('migrated TRELLIS and Hunyuan families keep critical native and attention risks documented', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));

  const trellis2 = entriesById.get('lightningpixel-trellis2');
  const trellisText = entriesById.get('drhepa-trellis-text');
  const trellis2Fork = entriesById.get('drhepa-trellis2-fork');
  const hunyuanPart = entriesById.get('drhepa-hunyuan3d-part');
  const hunyuanMv = entriesById.get('drhepa-hunyuan3d-mv');

  for (const [entryId, entry] of [
    ['lightningpixel-trellis2', trellis2],
    ['drhepa-trellis-text', trellisText],
    ['drhepa-trellis2-fork', trellis2Fork],
    ['drhepa-hunyuan3d-part', hunyuanPart],
    ['drhepa-hunyuan3d-mv', hunyuanMv],
  ]) {
    assert.ok(entry?.upstream_requirements, `${entryId} must define upstream_requirements in this migration batch`);
    assert.ok(
      /not runtime enforcement|without claiming Modly runtime enforcement|documentation only/i.test(readText('docs/extension-dependency-library/README.md')),
      'README must keep upstream_requirements evidence-only/document-only',
    );
  }

  const trellis2Json = JSON.stringify(trellis2.upstream_requirements);
  assert.match(trellis2Json, /flash-attn|xformers/iu, 'lightningpixel-trellis2 must preserve attention package expectations');
  assert.match(trellis2Json, /spconv|nvdiffrast|diff-gaussian-rasterization/iu, 'lightningpixel-trellis2 must preserve native postprocess or sparse-conv hotspots');

  const trellisTextJson = JSON.stringify(trellisText.upstream_requirements);
  assert.match(trellisTextJson, /xformers|flash-attn/iu, 'drhepa-trellis-text must preserve attention package expectations');
  assert.match(trellisTextJson, /nvdiffrast|diff_gaussian_rasterization|spconv/iu, 'drhepa-trellis-text must preserve native postprocess hotspots');

  const trellisForkJson = JSON.stringify(trellis2Fork.upstream_requirements);
  assert.match(trellisForkJson, /spconv|cumm/iu, 'drhepa-trellis2-fork must preserve sparse-conv native hotspots');
  assert.match(trellisForkJson, /nvdiffrast|diff_gaussian_rasterization|CuMesh|o-voxel/iu, 'drhepa-trellis2-fork must preserve native postprocess and geometry hotspots');
  assert.ok(trellis2Fork.upstream_requirements.stack_lanes.every((lane) => lane.status === 'experimental'), 'drhepa-trellis2-fork lanes must stay experimental unless a lane is fully verified');

  const hunyuanPartJson = JSON.stringify(hunyuanPart.upstream_requirements);
  assert.match(hunyuanPartJson, /spconv/iu, 'drhepa-hunyuan3d-part must preserve sparse-conv ABI risk');
  assert.match(hunyuanPartJson, /torch_scatter|torch_cluster|chamfer3D|sonata/iu, 'drhepa-hunyuan3d-part must preserve PyG, Sonata, or chamfer native ABI risks');

  const hunyuanMvJson = JSON.stringify(hunyuanMv.upstream_requirements);
  assert.match(hunyuanMvJson, /custom_rasterizer/iu, 'drhepa-hunyuan3d-mv must preserve custom rasterizer risk');
  assert.match(hunyuanMvJson, /differentiable_renderer|xatlas|onnxruntime-gpu/iu, 'drhepa-hunyuan3d-mv must preserve renderer or xatlas-related native/runtime risks');
});

test('UniRig and Kimodo remain evidence-only while recording the requested dependency-library fact set', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const readme = readText('docs/extension-dependency-library/README.md');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));

  const unirig = entriesById.get('drhepa-unirig');
  const kimodo = entriesById.get('drhepa-kimodo');

  assert.ok(unirig?.upstream_requirements, 'drhepa-unirig must define upstream_requirements');
  assert.ok(kimodo?.upstream_requirements, 'drhepa-kimodo must define upstream_requirements');

  const unirigPackages = packagesByName(unirig.dependency_groups[0]);
  assert.ok(unirigPackages.has('bpy'), 'drhepa-unirig must inventory bpy');
  assert.ok(unirigPackages.has('torch_scatter'), 'drhepa-unirig must inventory torch_scatter');
  assert.ok(unirigPackages.has('torch_cluster'), 'drhepa-unirig must inventory torch_cluster');
  assert.ok(unirigPackages.has('spconv-cu126'), 'drhepa-unirig must inventory a spconv wheel lane');
  assert.ok(unirigPackages.has('cumm-cu126'), 'drhepa-unirig must inventory a cumm wheel lane');
  assert.equal(unirigPackages.get('numpy')?.specifier, '==1.26.4', 'drhepa-unirig must pin numpy==1.26.4');
  assert.ok(unirig.dependency_risks.some((risk) => risk.marker === 'native-abi' && /flash_attn|spconv|torch_scatter|torch_cluster/iu.test(risk.claim)), 'drhepa-unirig must keep high native ABI risk explicit');
  assert.equal(unirig.model_weights[0].auth, 'none', 'drhepa-unirig must not invent gated auth');
  assert.match(JSON.stringify(unirig.upstream_requirements), /flash_attn/iu, 'drhepa-unirig upstream_requirements must record flash_attn guidance');
  assert.match(JSON.stringify(unirig.upstream_requirements), /bpy/iu, 'drhepa-unirig upstream_requirements must record bpy guidance');
  assert.match(JSON.stringify(unirig.upstream_requirements), /spconv|cumm/iu, 'drhepa-unirig upstream_requirements must record sparse-conv guidance');
  assert.match(JSON.stringify(unirig.upstream_requirements), /torch_scatter|torch_cluster/iu, 'drhepa-unirig upstream_requirements must record PyG wheel guidance');
  assert.ok(unirig.cluster_refs.includes('pyg-sparse-conv-family'), 'drhepa-unirig must reference the PyG/sparse-conv shared cluster');

  const kimodoPackages = packagesByName(kimodo.dependency_groups[0]);
  assert.equal(kimodoPackages.get('transformers')?.specifier, '==5.1.0', 'drhepa-kimodo must record transformers==5.1.0');
  assert.ok(kimodoPackages.has('peft'), 'drhepa-kimodo must inventory peft');
  assert.ok(kimodoPackages.has('trimesh'), 'drhepa-kimodo must inventory trimesh');
  assert.ok(kimodoPackages.has('av'), 'drhepa-kimodo must inventory av');
  assert.ok(kimodoPackages.has('bvhio'), 'drhepa-kimodo must inventory bvhio');
  assert.ok(kimodo.dependency_risks.some((risk) => risk.marker === 'gated-weights' && /Meta Llama|LLM2Vec/iu.test(risk.claim)), 'drhepa-kimodo must keep gated Meta/LLM2Vec encoder risk explicit');
  assert.ok(kimodo.dependency_groups[0].unknowns.some((item) => /MotionCorrection|SKIP_MOTION_CORRECTION_IN_SETUP/iu.test(item)), 'drhepa-kimodo must record MotionCorrection as skipped or optional');
  assert.ok(kimodo.upstream_requirements.stack_lanes.every((lane) => ['experimental', 'unknown'].includes(lane.status)), 'drhepa-kimodo must not overclaim runtime support');
  assert.ok(kimodo.platform_support.every((support) => support.status !== 'supported'), 'drhepa-kimodo platform support must stay conservative');
  assert.ok(kimodo.model_weights.some((weight) => weight.auth === 'gated' && /meta-llama|llm2vec/iu.test(`${weight.repo_id ?? ''} ${weight.id}`)), 'drhepa-kimodo must record gated encoder/model assets');
  assert.match(JSON.stringify(kimodo.upstream_requirements), /MotionCorrection|SKIP_MOTION_CORRECTION_IN_SETUP/iu, 'drhepa-kimodo upstream_requirements must record the MotionCorrection skip behavior');

  for (const entry of [unirig, kimodo]) {
    assert.equal(entry.upstream_requirements.validation_status.runtime_contract, 'unknown', `${entry.id} must stay evidence-only at runtime level`);
    assert.match(readme, /evidence-only\/document-only/iu, 'README must keep the dependency library evidence-only/document-only');
  }
});

test('evidenced local_assets metadata uses safe logical aliases and model subpaths', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));
  const expected = {
    'lightningpixel-hunyuan3d-mini': { extension_id: 'hunyuan3d-mini', model: { weight_id: 'hunyuan3d-mini', roots: ['hunyuan3d-mini'], subpaths: ['generate'], sentinel_files: ['config.json'] } },
    'lightningpixel-trellis2': { extension_id: 'trellis-2', aliases: ['trellis2'], model: { weight_id: 'trellis2', roots: ['trellis-2'], subpaths: ['base-4b'], sentinel_files: ['pipeline.json'] } },
    'lightningpixel-triposg': { extension_id: 'triposg', model: { weight_id: 'triposg', roots: ['triposg'], subpaths: ['generate'], sentinel_files: ['model_index.json'] } },
    'drhepa-trellis-text': { extension_id: 'trellis-text', model: { weight_id: 'trellis-text', roots: ['trellis-text'], subpaths: ['text-base', 'text-large', 'text-xlarge'], sentinel_files: ['pipeline.json'] } },
    'drhepa-hunyuan3d-mini': { extension_id: 'hunyuan3d-mini', model: { weight_id: 'hunyuan3d-mini', roots: ['hunyuan3d-mini'], subpaths: ['generate'], sentinel_files: ['config.json'] } },
  };

  for (const [entryId, expectedAssets] of Object.entries(expected)) {
    const entry = entriesById.get(entryId);
    assert.ok(entry?.local_assets, `${entryId} must define local_assets`);
    assert.equal(entry.local_assets.status, 'partial', `${entryId} local_assets stay evidence-only/partial`);
    assertEnumValue({ confidence: ['confirmed', 'strong', 'partial', 'weak', 'unknown'] }, 'confidence', entry.local_assets.confidence, `${entryId}.local_assets.confidence`);
    assertEvidenceIdsResolve(entry, entry.local_assets.evidence_ids, `${entryId}.local_assets`);
    assert.equal(entry.local_assets.extension_id, expectedAssets.extension_id, `${entryId}.local_assets.extension_id`);
    assertSafeSegment(entry.local_assets.extension_id, `${entryId}.local_assets.extension_id`);
    for (const alias of entry.local_assets.aliases ?? []) {
      assertSafeSegment(alias, `${entryId}.local_assets.aliases`);
    }
    assert.deepEqual(entry.local_assets.aliases ?? [], expectedAssets.aliases ?? [], `${entryId}.local_assets.aliases`);

    const modelAsset = entry.local_assets.model_assets.find((asset) => asset.weight_id === expectedAssets.model.weight_id);
    assert.ok(modelAsset, `${entryId} must define model_assets for ${expectedAssets.model.weight_id}`);
    assert.deepEqual(modelAsset.roots, expectedAssets.model.roots, `${entryId}.model_assets.roots`);
    assert.deepEqual(modelAsset.subpaths, expectedAssets.model.subpaths, `${entryId}.model_assets.subpaths`);
    assert.deepEqual(modelAsset.sentinel_files, expectedAssets.model.sentinel_files, `${entryId}.model_assets.sentinel_files`);
    assertEvidenceIdsResolve(entry, modelAsset.evidence_ids, `${entryId}.model_assets.${modelAsset.weight_id}`);
    for (const value of [...modelAsset.roots, ...modelAsset.subpaths]) {
      assertSafeRelativePath(value, `${entryId}.model_assets.${modelAsset.weight_id}`);
    }
    for (const sentinel of modelAsset.sentinel_files) {
      assertSafeRelativePath(sentinel, `${entryId}.model_assets.${modelAsset.weight_id}.sentinel_files`);
    }
  }
});

test('unsupported variants do not invent fast, turbo, part, GGUF, MV, or fork aliases', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));
  const deferredEntryIds = [
    'lightningpixel-hunyuan3d-fast',
    'lightningpixel-hunyuan3d-turbo',
    'lightningpixel-trellis2-gguf',
    'drhepa-hunyuan3d-part',
    'drhepa-hunyuan3d-mv',
    'drhepa-trellis2-fork',
  ];

  for (const entryId of deferredEntryIds) {
    const localAssets = entriesById.get(entryId)?.local_assets;
    if (!localAssets) {
      continue;
    }
    assert.equal(localAssets.status, 'deferred_no_evidence', `${entryId} may only record a non-candidate deferred status`);
    assert.ok(localAssets.unknowns?.length > 0, `${entryId} deferred status must explain unknowns`);
    assert.equal('extension_id' in localAssets, false, `${entryId} must not publish an invented extension candidate`);
    assert.deepEqual(localAssets.aliases ?? [], [], `${entryId} must not publish invented aliases`);
    assert.deepEqual(localAssets.model_roots ?? [], [], `${entryId} must not publish invented model roots`);
    assert.deepEqual(localAssets.model_assets ?? [], [], `${entryId} must not publish invented model assets`);
  }
});

test('library entries use valid enums, public evidence, and unique ids', () => {
  const schema = readJson('docs/extension-dependency-library/schema.json');
  const library = readJson('docs/extension-dependency-library/library.json');
  const ids = library.entries.map((entry) => entry.id);

  assert.deepEqual(new Set(ids).size, ids.length, 'entry ids must be unique');
  assert.ok(library.entries.length >= 10, 'v1 should include required public/verifiable LightningPixel and DrHepa entries');

  for (const key of schema.required_top_level) {
    assert.ok(key in library, `library must include ${key}`);
  }

  for (const entry of library.entries) {
    for (const key of schema.required_entry_fields) {
      assert.ok(key in entry, `${entry.id} must include ${key}`);
    }

    assertEnumValue(schema.enums, 'relationship', entry.relationship, `${entry.id}.relationship`);

    for (const item of entry.install.mechanisms) {
      assertEnumValue(schema.enums, 'install_mechanism', item.mechanism, `${entry.id}.install.mechanisms`);
      assertEnumValue(schema.enums, 'confidence', item.confidence, `${entry.id}.install.mechanisms.confidence`);
    }

    assertEnumValue(schema.enums, 'runtime_ownership', entry.runtime.owner, `${entry.id}.runtime.owner`);
    assertEnumValue(schema.enums, 'confidence', entry.runtime.confidence, `${entry.id}.runtime.confidence`);

    for (const model of entry.models) {
      assertEnumValue(schema.enums, 'confidence', model.confidence, `${entry.id}.models.confidence`);
    }

    assert.ok(entry.dependency_summary?.inventory_status, `${entry.id} must include dependency summary status`);
    assertEnumValue(schema.enums, 'confidence', entry.dependency_summary.confidence, `${entry.id}.dependency_summary.confidence`);

    for (const support of entry.platform_support) {
      assertEnumValue(schema.enums, 'platform', support.platform, `${entry.id}.platform_support.platform`);
      assertEnumValue(schema.enums, 'support_status', support.status, `${entry.id}.platform_support.status`);
      assertEnumValue(schema.enums, 'confidence', support.confidence, `${entry.id}.platform_support.confidence`);
    }

    for (const risk of entry.dependency_risks) {
      assertEnumValue(schema.enums, 'risk_marker', risk.marker, `${entry.id}.dependency_risks.marker`);
      assertEnumValue(schema.enums, 'confidence', risk.confidence, `${entry.id}.dependency_risks.confidence`);
    }

    for (const evidence of entry.evidence) {
      assertEnumValue(schema.enums, 'confidence', evidence.confidence, `${entry.id}.evidence.confidence`);
      assertEnumValue(schema.enums, 'source_type', evidence.source_type, `${entry.id}.evidence.source_type`);
      assert.match(evidence.source, /^https:\/\/|^[a-z0-9_.-]+\/[a-z0-9_.-]+/iu, `${entry.id}.evidence.source must be public or a public repo id`);
      assert.ok(evidence.claim && evidence.locator && evidence.observed_at, `${entry.id}.evidence records must include claim, locator, and observed_at`);
      assert.ok(evidence.quote_or_value || evidence.notes, `${entry.id}.evidence records must include quote_or_value or notes`);
    }
  }
});

test('library uses canonical GitHub repository identities', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));
  const expectedEntryIds = Object.keys(expectedReposByEntryId);

  assert.deepEqual(
    library.entries.filter((entry) => entry.identity.repo).map((entry) => entry.id).sort(),
    expectedEntryIds.toSorted(),
    'library entries must exactly match the canonical repository mapping coverage',
  );

  for (const [entryId, expectedRepo] of Object.entries(expectedReposByEntryId)) {
    const entry = entriesById.get(entryId);
    assert.ok(entry, `${entryId} must exist in the dependency library`);
    assert.equal(entry.identity.repo, expectedRepo, `${entryId}.identity.repo must use the canonical public repository id`);
    assert.equal(entry.identity.public_url, `https://github.com/${expectedRepo}`, `${entryId}.identity.public_url must derive from identity.repo`);
    assert.doesNotMatch(entry.identity.repo, /ComfyUI-/iu, `${entryId}.identity.repo must not use legacy ComfyUI repository names`);
    assert.doesNotMatch(entry.identity.public_url, /ComfyUI-/iu, `${entryId}.identity.public_url must not use legacy ComfyUI repository names`);

    const githubEvidence = entry.evidence.filter((record) => record.source_type.startsWith('github-'));
    assert.ok(githubEvidence.length > 0, `${entryId} must keep at least one GitHub evidence source`);

    for (const evidence of githubEvidence) {
      assert.doesNotMatch(evidence.source, /ComfyUI-/iu, `${entryId}.${evidence.id}.source must not use legacy ComfyUI repository names`);
      assert.equal(githubRepoFromSource(evidence.source), expectedRepo, `${entryId}.${evidence.id}.source must reference identity.repo`);
    }
  }
});

test('Pixal3D is registered with honest Linux and Windows runtime validation semantics', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const entriesById = new Map(library.entries.map((entry) => [entry.id, entry]));
  const pixal3d = entriesById.get('drhepa-pixal3d');

  assert.ok(pixal3d, 'drhepa-pixal3d must exist');
  assert.equal(pixal3d.identity.repo, 'DrHepa/modly-pixal3d-extension');
  assert.ok(pixal3d.upstream_requirements, 'drhepa-pixal3d must define upstream_requirements');

  const packageSet = packageNames(pixal3d);
  for (const requiredPkg of ['natten', 'cumesh', 'flex-gemm', 'o-voxel', 'nvdiffrast', 'nvdiffrec-render']) {
    assert.ok(packageSet.has(requiredPkg), `drhepa-pixal3d must include ${requiredPkg} in dependency inventory`);
  }

  const linuxLane = pixal3d.upstream_requirements.stack_lanes.find((lane) => lane.lane_id === 'linux-arm64-py312-cu124');
  const windowsLane = pixal3d.upstream_requirements.stack_lanes.find((lane) => lane.lane_id === 'windows-x64-py311-cu124');

  assert.ok(linuxLane, 'drhepa-pixal3d must expose linux-arm64-py312-cu124 lane');
  assert.ok(windowsLane, 'drhepa-pixal3d must expose windows-x64-py311-cu124 lane');
  assert.equal(linuxLane.status, 'supported', 'linux arm64 Pixal3D lane must be recorded as supported');
  assert.equal(linuxLane.accelerator.cuda_version, '13.0', 'linux arm64 Pixal3D lane must record observed torch CUDA runtime 13.0 while preserving the published wheelhouse selector in notes');
  assert.match(JSON.stringify(linuxLane), /HAS_LIBNATTEN|libnatten|native import validated|functional validation/iu, 'linux arm64 lane must record natten/libnatten availability or functional validation');
  assert.match(JSON.stringify(linuxLane), /Published wheelhouse selector: cuda124/iu, 'linux arm64 Pixal3D lane must preserve the published wheelhouse selector label separately from observed torch CUDA runtime');
  assert.match(JSON.stringify(linuxLane), /cumesh|nvdiffrast|nvdiffrec-render|natten/iu, 'linux arm64 lane must preserve native package validation context');

  assert.equal(windowsLane.status, 'supported', 'windows cp311/cu124 Pixal3D lane must be supported after final GLB generation is confirmed');
  assert.match(JSON.stringify(windowsLane), /native natten|libnatten included|HAS_LIBNATTEN|torch\.compile disabled/iu, 'windows lane must record native natten availability and import compatibility');
  assert.match(JSON.stringify(windowsLane), /Low VRAM 1024|GLB extraction|final GLB save|workspace fetch/iu, 'windows lane must record full runtime validation');
  assert.match(JSON.stringify(windowsLane), /cumesh|flex-gemm|o-voxel|nvdiffrast|nvdiffrec-render/iu, 'windows lane must preserve critical native packages and aliases');

  const windowsSupport = pixal3d.platform_support.find((support) => support.platform === 'windows-x64');
  assert.equal(windowsSupport?.status, 'supported', 'Pixal3D must claim Windows supported only after generation is validated');
  assert.doesNotMatch(JSON.stringify(pixal3d), /candidate workflow|validated candidate|completed natten windows workflow/iu, 'Pixal3D entry must not claim the unvalidated natten Windows candidate workflow as completed');
});

test('entries declare real dependency inventories or valid evidence-backed no-dependency reasons', () => {
  const schema = readJson('docs/extension-dependency-library/schema.json');
  const library = readJson('docs/extension-dependency-library/library.json');
  const clusterIds = new Set(library.shared_clusters.map((cluster) => cluster.id));

  assert.ok(library.shared_clusters.length >= 6, 'library must define reusable shared dependency clusters');

  for (const entry of library.entries) {
    const dependencyGroups = entry.dependency_groups ?? [];
    const modelWeights = entry.model_weights ?? [];
    const hasInventory = dependencyGroups.length > 0 || modelWeights.length > 0;

    assert.ok(
      hasInventory || entry.no_dependencies_reason,
      `${entry.id} must include concrete dependency groups, model weights, or an evidence-backed no_dependencies_reason`,
    );
    assert.ok(
      hasInventory ? !entry.no_dependencies_reason : Boolean(entry.no_dependencies_reason),
      `${entry.id} must not mix dependency/model records with no_dependencies_reason`,
    );

    for (const ref of entry.cluster_refs) {
      assert.ok(clusterIds.has(ref), `${entry.id} cluster ref ${ref} must resolve`);
    }

    for (const group of dependencyGroups) {
      assertEnumValue(schema.enums, 'dependency_group_kind', group.kind, `${entry.id}.${group.id}.kind`);
      assert.ok(group.packages.length > 0, `${entry.id}.${group.id} must contain package records`);
      for (const lane of group.accelerator_lanes) {
        assertEnumValue(schema.enums, 'accelerator_lane', lane, `${entry.id}.${group.id}.accelerator_lanes`);
      }

      for (const pkg of group.packages) {
        assert.ok(pkg.name, `${entry.id}.${group.id} package must include name`);
        assert.ok(pkg.ecosystem, `${entry.id}.${group.id}.${pkg.name} must include ecosystem`);
        assert.ok(pkg.specifier || pkg.unknown_reason, `${entry.id}.${group.id}.${pkg.name} must include specifier or unknown_reason`);
        assert.ok(pkg.source?.type, `${entry.id}.${group.id}.${pkg.name} must include source type`);
        assertEnumValue(schema.enums, 'package_source_type', pkg.source.type, `${entry.id}.${group.id}.${pkg.name}.source.type`);
        assertEnumValue(schema.enums, 'native_abi_risk', pkg.native_abi_risk, `${entry.id}.${group.id}.${pkg.name}.native_abi_risk`);
        assertEvidenceIdsResolve(entry, pkg.evidence_ids, `${entry.id}.${group.id}.${pkg.name}`);
      }
    }
  }
});

test('library contains meaningful package families and explicit model weight metadata', () => {
  const schema = readJson('docs/extension-dependency-library/schema.json');
  const library = readJson('docs/extension-dependency-library/library.json');
  const packages = collectPackages(library);
  const packageNames = new Set(packages.map(({ pkg }) => pkg.name));
  const requiredPackages = [
    'torch',
    'torchvision',
    'torchaudio',
    'transformers',
    'accelerate',
    'huggingface_hub',
    'trimesh',
    'spconv-cu120',
    'flash-attn',
    'diffusers',
    'safetensors',
    'einops',
  ];

  assert.ok(packageNames.size >= 12, `library must inventory at least 12 concrete package names; found ${packageNames.size}`);
  for (const name of requiredPackages) {
    assert.ok(packageNames.has(name), `library package inventory must include ${name}`);
  }

  for (const entry of library.entries) {
    for (const model of entry.model_weights) {
      assert.ok(model.id && model.provider, `${entry.id} model weight record must include id and provider`);
      assert.ok(model.repo_id || model.unknown_reason, `${entry.id}.${model.id} must include repo_id or unknown_reason`);
      assertEnumValue(schema.enums, 'download_owner', model.download_owner, `${entry.id}.${model.id}.download_owner`);
      assertEnumValue(schema.enums, 'auth_requirement', model.auth, `${entry.id}.${model.id}.auth`);
      assertEnumValue(schema.enums, 'confidence', model.confidence, `${entry.id}.${model.id}.confidence`);
      assertEvidenceIdsResolve(entry, model.evidence_ids, `${entry.id}.${model.id}`);
    }
  }
});

test('non-unknown claims are backed by matching non-unknown evidence', () => {
  const library = readJson('docs/extension-dependency-library/library.json');

  for (const entry of library.entries) {
    const claims = [
      ...entry.install.mechanisms,
      entry.runtime,
      ...entry.models,
      ...entry.platform_support,
      ...entry.dependency_risks,
    ];

    for (const claim of claims.filter((item) => item.confidence !== 'unknown')) {
      const evidence = claimEvidence(entry, claim);
      assert.ok(evidence.length > 0, `${entry.id} claim ${claim.claim} must reference evidence`);
      assert.ok(
        evidence.some((record) => record.confidence !== 'unknown' && (record.claim === claim.claim || record.notes || record.quote_or_value)),
        `${entry.id} claim ${claim.claim} must have non-unknown evidence with a matching claim or explanatory evidence notes`,
      );
    }
  }
});

test('sources are sanitized and UltraShape is excluded from entries', () => {
  const library = readJson('docs/extension-dependency-library/library.json');
  const allLibraryStrings = collectStrings(library);

  for (const { path: stringPath, value } of allLibraryStrings) {
    assert.doesNotMatch(value, /(?:^|\s)\/home\//u, `${stringPath} must not contain host-local paths`);
    assert.doesNotMatch(value, /[A-Za-z]:\\/u, `${stringPath} must not contain Windows absolute paths`);
    assert.doesNotMatch(value, /file:\/\//u, `${stringPath} must not contain file URLs`);
    assert.doesNotMatch(value, /(?:^|[\\/])\.\.(?:[\\/]|$)/u, `${stringPath} must not contain traversal segments`);
  }

  for (const entry of library.entries) {
    const entryStrings = collectStrings({ id: entry.id, identity: entry.identity, evidence: entry.evidence });
    for (const { path: stringPath, value } of entryStrings) {
      assert.doesNotMatch(value, /ultrashape/iu, `${entry.id}.${stringPath} must not present UltraShape as an entry`);
    }
  }
});

test('AMD/ROCm is never marked supported without explicit evidence', () => {
  const library = readJson('docs/extension-dependency-library/library.json');

  for (const entry of library.entries) {
    for (const support of entry.platform_support.filter((item) => item.platform === 'amd-rocm' && item.status === 'supported')) {
      const evidence = claimEvidence(entry, support);
      assert.ok(evidence.length > 0, `${entry.id} AMD/ROCm support must reference evidence`);
      assert.ok(
        evidence.some((record) => /amd|rocm/iu.test(`${record.claim} ${record.quote_or_value ?? ''} ${record.notes ?? ''}`)),
        `${entry.id} AMD/ROCm support must have explicit AMD/ROCm evidence`,
      );
    }
  }
});

test('README documents non-goals, update workflow, sanitization, and packaging behavior', () => {
  const readme = readText('docs/extension-dependency-library/README.md');
  const packageJson = readJson('package.json');

  assert.match(readme, /evidence-only/iu);
  assert.match(readme, /confidence/iu);
  assert.match(readme, /dependency_groups/iu);
  assert.match(readme, /model_weights/iu);
  assert.match(readme, /upstream_requirements/iu);
  assert.match(readme, /shared_clusters/iu);
  assert.match(readme, /semantic validation/iu);
  assert.match(readme, /unknown_reason|unknowns/iu);
  assert.match(readme, /manual review|reviewer/iu);
  assert.match(readme, /source sanitization|sanitization/iu);
  assert.match(readme, /planner skill v2/iu);
  assert.match(readme, /repository identity accuracy/iu);
  assert.match(readme, /public_url.*identity\.repo/iu);
  assert.match(readme, /GitHub evidence.*same.*repo/iu);
  assert.match(readme, /label-inferred|inferred.*label/iu);
  assert.match(readme, /not an installer|no installer/iu);
  assert.match(readme, /not .*downloader|no downloads/iu);
  assert.match(readme, /runtime probing/iu);
  assert.match(readme, /Electron IPC/iu);
  assert.match(readme, /FastAPI integration/iu);
  assert.match(readme, /compatibility oracle/iu);
  assert.match(readme, /evidence-only\/document-only/iu);
  assert.match(readme, /do not execute setup|do not trigger setup|not runtime setup enforcement/iu);
  assert.match(readme, /repo-local\/document-only/iu);

  assert.ok(
    !packageJson.files.some((entry) => entry === 'docs/extension-dependency-library/**' || entry.startsWith('docs/extension-dependency-library')),
    'V1 must not add extension dependency docs to package files',
  );
});
