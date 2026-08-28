import http from 'node:http';

const port = Number.parseInt(process.env.MCP_RAG_MOCK_PORT || '18192', 10);
const host = '0.0.0.0';
const audioHash =
  'ab00005eaf000000000000000000000000000000000000000000000000000000';
const chunkId = 'mcp-smoke-chunk-1';

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return json(response, 200, { ok: true });
    }
    if (request.method !== 'POST') {
      return json(response, 405, { error: 'method_not_allowed' });
    }

    const body = await readJson(request);
    if (request.url === '/resolve') {
      return json(response, 200, {
        colbert_index_dir: '/tmp/besedy-mcp-smoke/colbert_index',
      });
    }
    if (request.url === '/query') {
      if (body.query !== 'Besedy MCP deterministic search') {
        return json(response, 400, { error: 'unexpected_query' });
      }
      return json(response, 200, {
        hits: [{ chunk_id: chunkId, score: 0.97 }],
      });
    }
    if (request.url === '/lookup') {
      return json(response, 200, {
        chunks: [
          {
            chunk_id: chunkId,
            audio_hash: audioHash,
            start_sec: 5,
            end_sec: 10,
            text: 'Deterministic Besedy MCP search evidence.',
            run_id: 'mcp-smoke-run',
            chunk_version: 'mcp-smoke-v1',
          },
        ],
      });
    }
    if (request.url === '/lexical-search') {
      if (body.query !== 'deterministic evidence') {
        return json(response, 400, { error: 'unexpected_query' });
      }
      if (!body.allowed_audio_hashes?.includes(audioHash)) {
        return json(response, 403, { error: 'missing_authorized_recording' });
      }
      return json(response, 200, {
        total_matches: 1,
        matches: [
          {
            chunk_id: chunkId,
            audio_hash: audioHash,
            start_sec: 5,
            end_sec: 10,
            text: 'Deterministic Besedy MCP search evidence.',
            run_id: 'mcp-smoke-run',
            chunk_version: 'mcp-smoke-v1',
            score: -1.25,
          },
        ],
      });
    }
    if (request.url === '/neighbors') {
      return json(response, 200, {
        neighbors: {
          [chunkId]: {
            before: [
              {
                chunk_id: 'mcp-smoke-chunk-0',
                audio_hash: audioHash,
                start_sec: 0,
                end_sec: 5,
                text: 'Neighbor context before the deterministic evidence.',
              },
            ],
            after: [],
          },
        },
      });
    }

    return json(response, 404, { error: 'not_found' });
  } catch (error) {
    return json(response, 500, {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
});

server.listen(port, host, () => {
  console.log(`MCP RAG mock listening on ${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
