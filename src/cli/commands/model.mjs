import { UsageError, ValidationError } from '../../core/errors.mjs';
import { toCurrentModel, toModelList } from '../../core/modly-normalizers.mjs';
import { parseCommandArgs } from './shared.mjs';

const MODEL_SUBCOMMANDS = ['list', 'current', 'params', 'switch', 'unload-all', 'download'];

function formatCell(value) {
  if (value === undefined || value === null || value === '') {
    return '—';
  }

  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }

  return String(value);
}

function getModelId(model) {
  return model?.id ?? model?.model_id ?? model?.modelId ?? '—';
}

function getModelName(model) {
  return model?.name ?? model?.title ?? '—';
}

function renderTable(headers, rows) {
  const widths = headers.map((header, index) => {
    const rowWidth = Math.max(...rows.map((row) => row[index].length), 0);
    return Math.max(header.length, rowWidth);
  });

  const renderRow = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');

  return [renderRow(headers), renderRow(widths.map((width) => '-'.repeat(width))), ...rows.map(renderRow)].join('\n');
}

function assertExactArgs(args, expectedCount, usageMessage) {
  if (args.length !== expectedCount) {
    throw new UsageError(usageMessage);
  }
}

function parseDownloadEventData(raw) {
  const value = raw.trim();

  if (value === '') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toProgressMessage(event) {
  if (!event) {
    return null;
  }

  const source = event.data && typeof event.data === 'object' ? event.data : event;
  const parts = [];

  if (event.event) {
    parts.push(`[${event.event}]`);
  }

  if (typeof source.message === 'string' && source.message.trim() !== '') {
    parts.push(source.message.trim());
  } else if (typeof source.status === 'string' && source.status.trim() !== '') {
    parts.push(source.status.trim());
  }

  const received = source.received ?? source.downloaded_bytes ?? source.bytes_downloaded;
  const total = source.total ?? source.total_bytes ?? source.bytes_total;

  if (Number.isFinite(received) && Number.isFinite(total) && total > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((received / total) * 100)));
    parts.push(`${percent}% (${received}/${total})`);
  } else if (Number.isFinite(source.progress)) {
    parts.push(`${source.progress}%`);
  }

  if (parts.length === 0 && typeof event.data === 'string') {
    parts.push(event.data);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

async function collectSseEvents(response, { onEvent } = {}) {
  if (!response.body) {
    throw new ValidationError('Download stream did not include a readable body.', {
      code: 'INVALID_STREAM',
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';

  const flushBuffer = () => {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const chunks = normalized.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      let eventName;
      const dataLines = [];

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (!eventName && dataLines.length === 0) {
        continue;
      }

      const event = {
        event: eventName ?? null,
        data: parseDownloadEventData(dataLines.join('\n')),
      };

      events.push(event);
      onEvent?.(event);
    }
  };

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      buffer += decoder.decode();
      flushBuffer();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    flushBuffer();
  }

  return events;
}

function summarizeDownload(events) {
  let finalEvent = null;

  for (const event of events) {
    if (event.data !== null && event.data !== undefined) {
      finalEvent = event;
    }
  }

  const result = finalEvent?.data ?? null;
  const resultMessage = toProgressMessage(finalEvent);

  return { result, resultMessage };
}

async function runList(context, args) {
  assertExactArgs(args, 0, 'Usage: modly model list [--api-url <url>] [--json]');

  const response = await context.client.listModels();
  const models = toModelList(response);

  if (models.length === 0) {
    return {
      data: { models },
      humanMessage: 'No models found.',
    };
  }

  const rows = models.map((model) => [
    formatCell(getModelId(model)),
    formatCell(getModelName(model)),
    formatCell(model?.active ?? model?.is_active),
    formatCell(model?.downloaded),
    formatCell(model?.loaded),
    formatCell(model?.vram_gb ?? model?.vramGb),
  ]);

  return {
    data: { models },
    humanMessage: renderTable(['id', 'name', 'active', 'downloaded', 'loaded', 'vram_gb'], rows),
  };
}

async function runCurrent(context, args) {
  assertExactArgs(args, 0, 'Usage: modly model current [--api-url <url>] [--json]');

  const response = await context.client.getCurrentModel();
  const model = toCurrentModel(response);

  if (!model) {
    return {
      data: { model: null },
      humanMessage: 'No active model.',
    };
  }

  return {
    data: { model },
    humanMessage: `Active model: ${getModelId(model)} (downloaded=${Boolean(model.downloaded)}, loaded=${Boolean(model.loaded)})`,
  };
}

async function runParams(context, args) {
  assertExactArgs(args, 1, 'Usage: modly model params <model-id> [--api-url <url>] [--json]');

  const [modelId] = args;
  const params = await context.client.getModelParams(modelId);

  return {
    data: { modelId, params },
    humanMessage: `Model params for ${modelId}:\n${JSON.stringify(params, null, 2)}`,
  };
}

async function runSwitch(context, args) {
  assertExactArgs(args, 1, 'Usage: modly model switch <model-id> [--api-url <url>] [--json]');

  const [modelId] = args;
  const result = await context.client.switchModel(modelId);

  return {
    data: { modelId, result },
    humanMessage: `Active model set to ${modelId}.`,
  };
}

async function runUnloadAll(context, args) {
  assertExactArgs(args, 0, 'Usage: modly model unload-all [--api-url <url>] [--json]');

  const result = await context.client.unloadAllModels();

  return {
    data: { result },
    humanMessage: 'Requested unload for all models.',
  };
}

async function runDownload(context, args) {
  const usage =
    'Usage: modly model download --repo-id <hf-repo> --model-id <model-id> [--skip-prefix <prefix> ...] [--api-url <url>] [--json]';
  const { positionals, options } = parseCommandArgs(args, {
    usage,
    valueFlags: ['--repo-id', '--model-id'],
    repeatableValueFlags: ['--skip-prefix'],
  });

  if (positionals.length !== 0) {
    throw new UsageError(usage);
  }

  const repoId = options['--repo-id'];
  const modelId = options['--model-id'];
  const skipPrefixes = options['--skip-prefix'] ?? [];

  if (!repoId || !modelId) {
    throw new UsageError(usage);
  }

  const response = await context.client.downloadModel({ repoId, modelId, skipPrefixes });
  const events = await collectSseEvents(response, {
    onEvent(event) {
      const message = toProgressMessage(event);
      if (message) {
        process.stderr.write(`${message}\n`);
      }
    },
  });
  const { result, resultMessage } = summarizeDownload(events);

  return {
    data: {
      repoId,
      modelId,
      skipPrefixes,
      eventCount: events.length,
      result,
    },
    humanMessage: resultMessage
      ? `Download finished for ${modelId}. ${resultMessage}`
      : `Download stream finished for ${modelId}.`,
  };
}

export async function runModelCommand(context) {
  const [subcommand = 'list', ...args] = context.args;

  switch (subcommand) {
    case 'list':
      return runList(context, args);
    case 'current':
      return runCurrent(context, args);
    case 'params':
      return runParams(context, args);
    case 'switch':
      return runSwitch(context, args);
    case 'unload-all':
      return runUnloadAll(context, args);
    case 'download':
      return runDownload(context, args);
    default:
      throw new UsageError(
        `Unknown model subcommand: ${subcommand}. Available: ${MODEL_SUBCOMMANDS.join(', ')}.`,
      );
  }
}
