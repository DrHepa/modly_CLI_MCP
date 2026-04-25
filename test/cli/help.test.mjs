import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderCapabilitiesHelp,
  renderGenerateHelp,
  renderHelp,
  renderJobHelp,
  renderMeshHelp,
  renderProcessRunHelp,
  renderSceneHelp,
} from '../../src/cli/help.mjs';
import { main } from '../../src/cli/index.mjs';

function createWritableStreamCapture() {
  let output = '';

  return {
    stream: {
      write(chunk) {
        output += String(chunk);
        return true;
      },
    },
    read() {
      return output;
    },
  };
}

test('main help advertises scene import without unsupported UI automation claims', () => {
  const help = renderHelp();
  const sceneHelp = renderSceneHelp();

  assert.match(help, /scene <subcomando>\s+import-mesh/u);
  assert.match(help, /scene, ext, ext-dev y config ya son funcionales/u);
  assert.match(sceneHelp, /GET \/health/u);
  assert.match(sceneHelp, /scene\.import_mesh/u);
  assert.match(sceneHelp, /falla cerrado/u);
  assert.match(sceneHelp, /No automatiza file pickers, menús, clicks ni diálogos del sistema/u);
  assert.doesNotMatch(sceneHelp, /Add to Scene/u);
});

test('legacy and mesh help sections keep their command matrices factual', () => {
  const jobHelp = renderJobHelp();
  const generateHelp = renderGenerateHelp();
  const meshHelp = renderMeshHelp();

  assert.match(jobHelp, /modly job status <job-id>/u);
  assert.match(jobHelp, /Superficie legacy de compatibilidad visible/u);
  assert.match(generateHelp, /modly generate from-image --image <path> --model <id>/u);
  assert.match(generateHelp, /workflow-run es la ruta run canónica/u);
  assert.match(meshHelp, /modly mesh optimize --path <workspace-relative-path> --target-faces <n>/u);
  assert.match(meshHelp, /modly mesh export --path <workspace-relative-path> --format glb\|obj\|stl\|ply/u);
  assert.match(meshHelp, /Subcomandos disponibles:\n\s+optimize\s+Decima/u);
});

test('capabilities and process-run help document enriched supplemental inputs conservatively', () => {
  const capabilitiesHelp = renderCapabilitiesHelp();
  const processRunHelp = renderProcessRunHelp();

  assert.match(capabilitiesHelp, /declared_inputs/u);
  assert.match(capabilitiesHelp, /supplemental_inputs/u);
  assert.match(capabilitiesHelp, /enriched_inputs/u);
  assert.match(capabilitiesHelp, /provenance/u);
  assert.match(capabilitiesHelp, /do not guess hidden params|no adivinar params ocultos/iu);
  assert.match(capabilitiesHelp, /trellis2\/refine/u);
  assert.match(capabilitiesHelp, /params\.mesh_path/u);
  assert.match(capabilitiesHelp, /params\.image_path/u);
  assert.match(capabilitiesHelp, /verified_runtime_behavior/u);
  assert.match(capabilitiesHelp, /params_schema.*may not include|params_schema.*puede no incluir/iu);
  assert.match(capabilitiesHelp, /backend-runtime model|modelo backend-runtime/iu);
  assert.match(capabilitiesHelp, /capability\.execute.*not supported|capability\.execute.*no soport/iu);
  assert.doesNotMatch(capabilitiesHelp, /trellis2\/refine[\s\S]{0,160}processRun\.create/u);

  assert.match(processRunHelp, /No usar Trellis2\/refine|Do not use Trellis2\/refine/iu);
  assert.match(processRunHelp, /backend-runtime model|modelo backend-runtime/iu);
  assert.match(processRunHelp, /process-run no promete|process-run does not promise/iu);
});

test('real CLI help routing renders scene and mesh specific help without backend calls', async () => {
  const sceneStdout = createWritableStreamCapture();
  const sceneExitCode = await main(['scene', '--help'], {
    stdout: sceneStdout.stream,
    createClient() {
      throw new Error('help must not create a backend client');
    },
  });

  assert.equal(sceneExitCode, 0);
  assert.match(sceneStdout.read(), /modly scene import-mesh <mesh-path>/u);
  assert.match(sceneStdout.read(), /Desktop bridge/u);

  const meshStdout = createWritableStreamCapture();
  const meshExitCode = await main(['mesh', '--help'], {
    stdout: meshStdout.stream,
    createClient() {
      throw new Error('help must not create a backend client');
    },
  });

  assert.equal(meshExitCode, 0);
  assert.match(meshStdout.read(), /modly mesh smooth --path <workspace-relative-path>/u);
  assert.match(meshStdout.read(), /export\s+Descarga una malla exportada/u);
});
