export function buildExtDevEvidence({ workspace, classification }) {
  return {
    observed: [
      { key: 'workspace.root', value: workspace.root, source: 'local-workspace' },
      { key: 'workspace.manifest_path', value: workspace.manifestPath, source: 'manifest.json' },
      { key: 'manifest.id', value: workspace.manifest.id ?? null, source: 'manifest.json' },
    ],
    derived: [
      { key: 'bucket', value: classification.bucket, source: 'bucket-heuristics' },
      { key: 'metadata', value: classification.metadata, source: 'classification' },
      { key: 'identity.planned', value: classification.identity.planned, source: 'manifest-derived' },
    ],
    assumed: [
      { key: 'identity.live', value: classification.identity.live, source: 'live-check-not-run' },
    ],
  };
}
