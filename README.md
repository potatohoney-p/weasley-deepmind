<!-- mcp-name: io.github.potatohoney-p/weasley-deepmind -->

![Weasley DeepMind](assets/weasley-deepmind-hero.png)

# Weasley DeepMind

Weasley DeepMind is a self-hosted memory server for AI agents. It stores small, typed memory fragments, links related evidence, and recalls the right context through MCP without forcing an entire conversation history back into every prompt.

It is part of the **Weasley Open Source** family and is released under Apache-2.0.

## Why DeepMind

- **Useful recall, not a transcript dump.** Keyword, PostgreSQL GIN, graph-neighbor, and optional pgvector search are merged and ranked within a token budget.
- **Memory with structure.** Facts, decisions, procedures, preferences, episodes, and errors keep provenance, importance, links, and lifecycle state.
- **MCP-native.** Use a local stdio process or the Streamable HTTP endpoint at `/mcp`.
- **Fail-closed HTTP security.** The HTTP server rejects requests when no access key is configured. Authentication can only be disabled explicitly for local development.
- **Self-hosted data.** PostgreSQL is the system of record. Redis and external embedding or LLM providers are optional.
- **Operationally ready.** Migrations are serialized with a PostgreSQL advisory lock, secrets are redacted from logs, and updates refuse dirty Git checkouts.

## Requirements

- Node.js 20.19 or newer
- PostgreSQL 15 or newer with the `pgvector` extension
- Redis 7 (optional, for cache and low-latency keyword lookup)

## Install from npm

```bash
npm install --global weasley-deepmind
```

Create a PostgreSQL database with pgvector, then configure the connection:

```bash
export DATABASE_URL='postgresql://postgres:password@localhost:5432/weasley_deepmind'
export WEASLEY_DEEPMIND_ACCESS_KEY='replace-with-a-long-random-secret'

weasley-deepmind migrate
weasley-deepmind serve
```

The HTTP server listens on `http://127.0.0.1:57332` by default. Its MCP endpoint is `http://127.0.0.1:57332/mcp`.

## Add it to an MCP client

The npm package includes a newline-delimited stdio transport. A generic MCP client configuration looks like this:

```json
{
  "mcpServers": {
    "weasley-deepmind": {
      "command": "npx",
      "args": ["-y", "weasley-deepmind", "stdio"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:password@localhost:5432/weasley_deepmind",
        "WEASLEY_DEEPMIND_AUTO_MIGRATE": "true"
      }
    }
  }
}
```

For an already-running HTTP deployment, point the client at `/mcp` and send `Authorization: Bearer <WEASLEY_DEEPMIND_ACCESS_KEY>`.

## Run the repository locally

```bash
git clone https://github.com/potatohoney-p/weasley-deepmind.git
cd weasley-deepmind
npm ci
docker compose -f docker-compose.dev.yml up -d
cp .env.example.minimal .env
npm run migrate
npm start
```

The development Compose file exposes PostgreSQL at `localhost:35432` and Redis at `localhost:36379`. Update `.env` to match those ports before starting the server.

## Core flow

```mermaid
flowchart LR
    Agent["AI agent"] --> MCP["stdio or Streamable HTTP"]
    MCP --> Tools["remember · recall · reflect · context"]
    Tools --> Rank["keyword + graph + vector ranking"]
    Rank --> Postgres["PostgreSQL + pgvector"]
    Rank -. optional cache .-> Redis["Redis"]
```

The main tool set includes `remember`, `batch_remember`, `recall`, `forget`, `amend`, `link`, `reflect`, `context`, `memory_stats`, `memory_consolidate`, `graph_explore`, `fragment_history`, `reconstruct_history`, and `search_traces`. Tool availability can be limited by API-key permissions and operating mode.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL | derived from `POSTGRES_*` |
| `WEASLEY_DEEPMIND_ACCESS_KEY` | Required bearer secret for HTTP mode | none; HTTP fails closed |
| `WEASLEY_DEEPMIND_AUTH_DISABLED` | Explicit loopback-only authentication opt-out; startup rejects non-loopback listeners | `false` |
| `WEASLEY_DEEPMIND_AUTO_MIGRATE` | Run migrations before stdio startup | `false` (`server.json` suggests `true`) |
| `WEASLEY_DEEPMIND_HOME` | CLI cache and local state directory | `~/.weasley/deepmind` |
| `WEASLEY_DEEPMIND_HOST` | HTTP listen address | `127.0.0.1` |
| `PORT` | HTTP port | `57332` |
| `REDIS_ENABLED` | Enable Redis-backed features | `false` |
| `EMBEDDING_PROVIDER` | `openai`, `gemini`, `ollama`, `localai`, `cloudflare`, `transformers` (optional install), or `custom` | `openai` |
| `EMBEDDING_API_KEY` | Optional embedding provider secret | none |

See [.env.example](.env.example), [configuration](docs/configuration.en.md), and the [installation guide](docs/INSTALL.en.md) for the complete matrix.

Local transformer embeddings are intentionally excluded from the default install so the core MCP server does not inherit an optional native-image dependency. Follow the pinned setup in [docs/embedding-local.md](docs/embedding-local.md) before selecting `EMBEDDING_PROVIDER=transformers`.

## CLI

```text
weasley-deepmind serve       Start the HTTP MCP server
weasley-deepmind stdio       Start the local stdio MCP server
weasley-deepmind migrate     Apply pending database migrations
weasley-deepmind health      Check database, Redis, and embeddings
weasley-deepmind recall      Search memory from the terminal
weasley-deepmind remember    Store a memory fragment
weasley-deepmind update      Preview or apply an update
```

Run `weasley-deepmind --help` or see the [CLI reference](docs/cli.en.md) for every command.

## Security defaults

- Keep the HTTP listener on loopback unless you have a trusted reverse proxy and an explicit origin allowlist.
- Use a unique, high-entropy `WEASLEY_DEEPMIND_ACCESS_KEY` and never commit `.env`.
- Stdio mode trusts the local MCP host process; protect the host account and database credentials accordingly.
- Report vulnerabilities privately using the instructions in [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm test
npm run lint
npm run lint:migrations
npm pack --dry-run
```

Architecture and operations details live in [docs/architecture.en.md](docs/architecture.en.md) and [docs/operations](docs/operations). Contributions are welcome through [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright 2026 Weasley Open Source.

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution information.
