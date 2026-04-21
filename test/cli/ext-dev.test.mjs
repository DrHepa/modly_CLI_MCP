import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { main } from '../../src/cli/index.mjs';
import { renderHelp } from '../../src/cli/help.mjs';

function createIoCapture() {
  const stdout = [];
  const stderr = [];

  return {
    stdout,
    stderr,
    deps: {
      stdout: { write(chunk) { stdout.push(String(chunk)); } },
      stderr: { write(chunk) { stderr.push(String(chunk)); } },
      env: {},
      cwd: '/workspace/modly_CLI_MCP',
      platform: 'linux',
    },
  };
}

function createWorkspace(t, manifest, relativePath = 'fixtures/ext-dev') {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'modly-ext-dev-cli-test-'));
  const workspaceRoot = path.join(tempRoot, relativePath);

  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'manifest.json'), JSON.stringify(manifest));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  return { tempRoot, workspaceRoot };
}

test('modly ext-dev --help muestra la surface visible en ayuda global y específica', async () => {
  const { stdout, deps } = createIoCapture();

  const exitCode = await main(['ext-dev', '--help'], deps);

  assert.equal(exitCode, 0);
  assert.match(stdout.join(''), /modly ext-dev — surface CLI de planificación observable/u);
  assert.match(stdout.join(''), /bucket-detect \| preflight \| scaffold \| audit \| release-plan/u);
  assert.match(stdout.join(''), /preflight\s+Plan-only; validación local con chequeo opcional de \/health/u);
  assert.match(stdout.join(''), /scaffold\s+Plan-only; plan de implementación no ejecutable por bucket/u);
  assert.match(stdout.join(''), /audit\s+Plan-only; gaps\/riesgos con confirmación bridge opcional/u);
  assert.match(stdout.join(''), /release-plan\s+Plan-only; checklist ordenado de release y documentación/u);

  const globalHelp = renderHelp();
  assert.match(globalHelp, /ext-dev <subcomando>\s+bucket-detect \| preflight \| scaffold \| audit \| release-plan/u);
  assert.match(globalHelp, /ext-dev\s+Planner local plan-only visible en V1; \/health opcional solo con evidencia backend y bridge opcional solo para confirmación\/colisión\./u);
});

test('modly ext-dev devuelve envelope JSON de error para subcomandos desconocidos', async () => {
  const { stdout, stderr, deps } = createIoCapture();

  const exitCode = await main(['--json', 'ext-dev', 'publish'], deps);

  assert.equal(exitCode, 2);
  assert.equal(stderr.join(''), '');

  const payload = JSON.parse(stdout.join(''));
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INVALID_USAGE');
  assert.match(payload.error.message, /Unknown ext-dev subcommand: publish/u);
  assert.match(payload.error.message, /bucket-detect, preflight, scaffold, audit, release-plan/u);
  assert.equal(payload.meta.apiUrl, 'http://127.0.0.1:8765');
});

test('modly ext-dev mantiene semántica plan-only local por subcomando vía main', async (t) => {
  const { workspaceRoot } = createWorkspace(t, {
    id: 'octo.simple',
    name: 'Octo Simple',
    version: '1.0.0',
  });

  for (const subcommand of ['bucket-detect', 'preflight', 'scaffold', 'audit', 'release-plan']) {
    const { stdout, deps } = createIoCapture();

    const exitCode = await main(['--json', 'ext-dev', subcommand], {
      ...deps,
      cwd: workspaceRoot,
      createClient() {
        return {};
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.ok, true);
    assert.equal(payload.data.plan.command, subcommand);
    assert.equal(payload.data.plan.plan_only, true);
    assert.equal(payload.data.plan.bucket, 'model-simple');
    assert.equal(payload.data.plan.workspace.manifestFilename, 'manifest.json');
    assert.equal(payload.data.plan.identity.planned.manifest_id, 'octo.simple');
    assert.equal(payload.meta.apiUrl, 'http://127.0.0.1:8765');
  }
});

test('modly ext-dev preflight intenta /health solo cuando corresponde y degrada a local si no está disponible', async (t) => {
  const { workspaceRoot } = createWorkspace(t, {
    id: 'octo.simple',
    name: 'Octo Simple',
    version: '1.0.0',
  });

  let bucketHealthCalls = 0;
  {
    const { stdout, deps } = createIoCapture();
    const exitCode = await main(['--json', 'ext-dev', 'bucket-detect'], {
      ...deps,
      cwd: workspaceRoot,
      createClient() {
        return {
          async health() {
            bucketHealthCalls += 1;
            return { status: 'ok' };
          },
        };
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.data.plan.checks.fastapi.requested, false);
    assert.equal(payload.data.plan.checks.fastapi.available, false);
    assert.equal(payload.data.plan.checks.fastapi.reason, 'not-required-for-command');
  }

  let preflightHealthCalls = 0;
  {
    const { stdout, deps } = createIoCapture();
    const exitCode = await main(['--json', 'ext-dev', 'preflight'], {
      ...deps,
      cwd: workspaceRoot,
      createClient() {
        return {
          async health() {
            preflightHealthCalls += 1;
            throw new Error('backend offline');
          },
        };
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.ok, true);
    assert.equal(payload.data.plan.command, 'preflight');
    assert.equal(payload.data.plan.plan_only, true);
    assert.equal(payload.data.plan.checks.local.ready, true);
    assert.equal(payload.data.plan.checks.fastapi.requested, true);
    assert.equal(payload.data.plan.checks.fastapi.available, false);
    assert.equal(payload.data.plan.checks.fastapi.reason, 'health-unavailable');
    assert.equal(payload.data.plan.bucket, 'model-simple');
  }

  assert.equal(bucketHealthCalls, 0);
  assert.equal(preflightHealthCalls, 1);
});

test('modly ext-dev audit usa bridge opcional solo para confirmación o colisión sin cambiar la identidad planned', async (t) => {
  const { workspaceRoot } = createWorkspace(t, {
    id: 'octo.process',
    name: 'Octo Process',
    version: '2.0.0',
    process: { entry: 'main.py' },
  });

  let releasePlanBridgeCalls = 0;
  {
    const { stdout, deps } = createIoCapture();
    const exitCode = await main(['--json', 'ext-dev', 'release-plan'], {
      ...deps,
      cwd: workspaceRoot,
      createClient() {
        return {
          async confirmExtDevBridge() {
            releasePlanBridgeCalls += 1;
            return { confirmed: true, manifest_id: 'octo.process', source: 'bridge' };
          },
        };
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.data.plan.checks.bridge.requested, false);
    assert.equal(payload.data.plan.identity.live.confirmed, false);
  }

  let auditBridgeCalls = 0;
  {
    const { stdout, deps } = createIoCapture();
    const exitCode = await main(['--json', 'ext-dev', 'audit'], {
      ...deps,
      cwd: workspaceRoot,
      createClient() {
        return {
          async confirmExtDevBridge() {
            auditBridgeCalls += 1;
            return {
              confirmed: true,
              manifest_id: 'octo.process-live',
              source: 'bridge',
              collision: true,
            };
          },
        };
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.ok, true);
    assert.equal(payload.data.plan.command, 'audit');
    assert.equal(payload.data.plan.identity.planned.manifest_id, 'octo.process');
    assert.equal(payload.data.plan.identity.live.confirmed, true);
    assert.equal(payload.data.plan.identity.live.manifest_id, 'octo.process-live');
    assert.equal(payload.data.plan.identity.live.collision, true);
    assert.equal(payload.data.plan.checks.bridge.requested, true);
    assert.equal(payload.data.plan.checks.bridge.available, true);
    assert.equal(payload.data.plan.checks.bridge.collision, true);
    assert.match(payload.data.plan.risks.join(','), /electron-owned-surface/u);
  }

  assert.equal(releasePlanBridgeCalls, 0);
  assert.equal(auditBridgeCalls, 1);
});

test('modly ext-dev scaffold emite un plan de implementación no ejecutable específico por comando', async (t) => {
  const simpleWorkspace = createWorkspace(t, {
    id: 'octo.simple',
    name: 'Octo Simple',
    version: '1.0.0',
  }, 'fixtures/ext-dev/simple');

  {
    const { stdout, deps } = createIoCapture();
    const exitCode = await main(['--json', 'ext-dev', 'scaffold'], {
      ...deps,
      cwd: simpleWorkspace.workspaceRoot,
      createClient() {
        return {};
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.data.plan.command, 'scaffold');
    assert.equal(payload.data.plan.scaffold_plan.kind, 'non-executable-implementation-plan');
    assert.equal(payload.data.plan.scaffold_plan.executable, false);
    assert.deepEqual(
      payload.data.plan.scaffold_plan.steps.map((step) => step.id),
      ['validate-manifest-contract', 'draft-fastapi-surface', 'record-local-test-seams'],
    );
    assert.deepEqual(
      payload.data.plan.scaffold_plan.steps.map((step) => step.order),
      [1, 2, 3],
    );
    assert.ok(payload.data.plan.scaffold_plan.steps.every((step) => step.executable === false));
  }

  const processWorkspace = createWorkspace(t, {
    id: 'octo.process',
    name: 'Octo Process',
    version: '2.0.0',
    process: { entry: 'main.py' },
  }, 'fixtures/ext-dev/process');

  {
    const { stdout, deps } = createIoCapture();
    const exitCode = await main(['--json', 'ext-dev', 'scaffold'], {
      ...deps,
      cwd: processWorkspace.workspaceRoot,
      createClient() {
        return {};
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.data.plan.bucket, 'process-extension');
    assert.equal(payload.data.plan.scaffold_plan.steps[1].owner, 'electron');
    assert.equal(payload.data.plan.scaffold_plan.steps[1].id, 'document-electron-workflow');
    assert.match(payload.data.plan.scaffold_plan.steps[1].reason, /electron-owned/u);
  }
});

test('modly ext-dev release-plan emite un checklist ordenado de release y documentación específico por comando', async (t) => {
  const simpleWorkspace = createWorkspace(t, {
    id: 'octo.simple',
    name: 'Octo Simple',
    version: '1.0.0',
  }, 'fixtures/ext-dev/release-simple');

  {
    const { stdout, deps } = createIoCapture();
    const exitCode = await main(['--json', 'ext-dev', 'release-plan'], {
      ...deps,
      cwd: simpleWorkspace.workspaceRoot,
      createClient() {
        return {};
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.data.plan.command, 'release-plan');
    assert.equal(payload.data.plan.release_plan.kind, 'ordered-release-checklist');
    assert.equal(payload.data.plan.release_plan.executable, false);
    assert.deepEqual(
      payload.data.plan.release_plan.checklist.map((step) => step.id),
      ['freeze-manifest-contract', 'prepare-release-notes', 'record-runtime-hand-off'],
    );
    assert.deepEqual(
      payload.data.plan.release_plan.checklist.map((step) => step.order),
      [1, 2, 3],
    );
    assert.ok(payload.data.plan.release_plan.checklist.every((step) => step.executable === false));
  }

  const managedWorkspace = createWorkspace(t, {
    id: 'octo.managed',
    name: 'Octo Managed',
    version: '3.0.0',
    setup: { kind: 'wizard' },
  }, 'fixtures/ext-dev/release-managed');

  {
    const { stdout, deps } = createIoCapture();
    const exitCode = await main(['--json', 'ext-dev', 'release-plan'], {
      ...deps,
      cwd: managedWorkspace.workspaceRoot,
      createClient() {
        return {};
      },
    });

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.join(''));
    assert.equal(payload.data.plan.bucket, 'model-managed-setup');
    assert.equal(payload.data.plan.release_plan.checklist[2].owner, 'electron');
    assert.equal(payload.data.plan.release_plan.checklist[2].id, 'document-electron-setup-hand-off');
    assert.match(payload.data.plan.release_plan.summary, /ordered/u);
  }
});

test('modly ext-dev mantiene guardas contra flujos runtime/apply/setup/install/release/repair', async (t) => {
  const { workspaceRoot } = createWorkspace(t, {
    id: 'octo.simple',
    name: 'Octo Simple',
    version: '1.0.0',
  });
  const { stdout, deps } = createIoCapture();

  const exitCode = await main(['--json', 'ext-dev', 'audit'], {
    ...deps,
    cwd: workspaceRoot,
    createClient() {
      return {};
    },
    stageGitHubExtension() {
      throw new Error('ext-dev must not stage GitHub extensions');
    },
    applyStagedExtension() {
      throw new Error('ext-dev must not apply extensions');
    },
    configureStagedExtension() {
      throw new Error('ext-dev must not run setup');
    },
    repairStagedExtension() {
      throw new Error('ext-dev must not run repair');
    },
    reconcileLatestSetupRun() {
      throw new Error('ext-dev must not read live setup status');
    },
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.join(''));
  assert.equal(payload.ok, true);

  const extDevCommandSource = readFileSync(new URL('../../src/cli/commands/ext-dev.mjs', import.meta.url), 'utf8');
  const plannerSource = readFileSync(new URL('../../src/core/ext-dev/planner.mjs', import.meta.url), 'utf8');

  for (const source of [extDevCommandSource, plannerSource]) {
    assert.doesNotMatch(source, /extension-apply\.mjs|extension-setup\.mjs|github-extension-staging\.mjs/u);
    assert.doesNotMatch(source, /\bapplyStagedExtension\b|\bconfigureStagedExtension\b|\brepairStagedExtension\b|\bstageGitHubExtension\b/u);
    assert.doesNotMatch(source, /\bpublishExtension\b|\binstallExtension\b|\breleaseExtension\b|\brepairExtension\b/u);
  }
});
