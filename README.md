# vord-bench

This benchmark measures whether Comunica queries endpoints that have restrictions better when it knows those restrictions. The restrictions are described with [VoRD](https://w3id.org/vord) in SPARQL service descriptions.

It compares engines built from the Comunica fork ([`ecrum19/comunica@feature/vord-restrictions`](https://github.com/ecrum19/comunica/tree/feature/vord-restrictions)) against dummy endpoints. The dummy endpoints describe their restrictions with VoRD and also enforce them.

## How it works

```
harness (one Node process per run)
   │  Comunica engine A/B/B′/C/D, fetch wrapped to record every request
   ▼
vord-proxy :3000-3004 ── one port per endpoint; profile in the path: /<profile>/sparql
   │  serves the service description and VoRD restrictions, enforces them, logs every request
   ▼
Oxigraph (read-only) ── all │ users │ products │ offers │ reviews
```

- **Data and queries.** The data is WatDiv at scale 10 (1.09M triples, from [comunica-performance-assets](https://github.com/comunica/comunica-performance-assets)). The queries come from its 20 templates (L, S, F, C), using the first instance of each by default.
  - [data/split.mjs](data/split.mjs) splits the dataset by subject type into 4 endpoints: `users`, `products`, `offers` and `reviews` ([data/partitions.json](data/partitions.json)).
  - Every triple ends up in exactly one partition, so the federated scenario has the same answers as the `all` endpoint.
- **Scenarios.** In `single`, Comunica queries the `all` endpoint. In `federated`, it queries the 4 partitions.
- **[vord-proxy](proxy/vord-proxy.mjs).** A small Node server with no dependencies.
  - A request without a query gets the service description, including the profile's VoRD restrictions. Each profile is defined once in [profiles/](profiles/), and that file drives both what the proxy enforces and what clients read.
  - It enforces the profile's hard restrictions:
    - rate and quota limits, with a sliding window per client (429 with `Retry-After`)
    - concurrency (503)
    - evaluation time (503)
    - result size, by truncation (`X-SPARQL-MaxRows`)
  - Soft restrictions are only advertised, not enforced.
  - Each endpoint has its own port, because Comunica's HTTP actors keep their state per host.
- **Ground truth.** Each query is evaluated directly on the unrestricted `all` store. A run is *complete* if it returns exactly these results, compared as a multiset.

### Restriction profiles

Time windows are compressed, roughly 10×, so that a run takes seconds instead of minutes.

| Profile | Restrictions |
|---|---|
| P0-none | None. A sanity check: every engine should be complete |
| P1-rate | 10 requests per 6 s (Wikidata's 10/min) |
| P2-burst | 60 per 6 s, in bursts of at most 15 |
| P3-truncate | Results truncated at 1,000 bindings |
| P4-concurrency | 3 concurrent requests |
| P5-timeout | 2 s evaluation time |
| P6-combined | 30 per 6 s with bursts of 10, truncation at 1,000, 3 concurrent requests, 2 s timeout, and a soft daily quota |
| P7-mixed | Federated only: `users` P1, `products` P3, `offers` P2 + P4, `reviews` none |
| P8-unadvertised | P6's restrictions are enforced but not described. A control: the VoRD engines get no information |

`burstValue` is interpreted the same way as in the fork's `limit-restrictions` actor: at most `burstValue` requests within `windowDuration × burstValue / maxValue`.

### Engines

The engines are defined in [engines/engines.json](engines/engines.json). All of them are built from the same fork commit and differ only in config and context. [harness/generate-engines.mjs](harness/generate-engines.mjs) derives each config from the fork's `config-default-v5-4-1.json` and compiles it once.

| Engine | Setup |
|---|---|
| A-naive | No `limit-rate`, no retries, no VoRD |
| B-backoff | Comunica's current behaviour: `limit-rate` plus retries (3 retries, honouring `Retry-After`) |
| Bp-backoff-eager | B with `limitByDefault: true`, `correctionMultiplier: 0.3` and `failureMultiplier: 1` |
| C-vord-http | B plus the VoRD extractor and `limit-restrictions`, with `restrictionAwarePlanning: false` |
| D-vord-full | B plus VoRD in the HTTP layer and in planning and execution: paging, request-time metadata and COUNT skipping |

### Measurements

Each run is one query, with one engine, under one profile and scenario, in a fresh process. Before each run, the proxy's limiter state is reset. A run records:

- its status (`ok`, `error`, `timeout` or `crashed`)
- recall and precision against the ground truth
- total time and time to first result
- HTTP requests by status and by host, as recorded on the client side, retries included
- the proxy's view of the same run, including how many responses it truncated

[harness/analyze.mjs](harness/analyze.mjs) aggregates the runs per profile, scenario and engine.

## Running

The setup requires Docker with Compose, Node 20 or later, git, curl and unzip.

```bash
npm run setup          # fork build, data, stores, endpoints, engines, ground truth (idempotent)
npm test               # unit tests; with the fork built, also checks how the fork reads the proxy's descriptions
npm run bench:dry      # prints the run matrix and checks that everything is in place
npm run bench:smoke    # a small subset: 4 queries x 4 profiles x 4 engines, with request traces
npm run bench -- --name full-1
npm run analyze -- results/full-1
```

The `setup` script reads these environment variables:

| Variable | Default |
|---|---|
| `COMUNICA_DIR` | `../comunica-vord` |
| `COMUNICA_REPO` | `https://github.com/ecrum19/comunica.git` |
| `COMUNICA_REF` | `feature/vord-restrictions` |

`harness/run.mjs` takes these options:

- selection: `--profiles`, `--scenarios`, `--engines`, `--templates`, `--instances`, `--replications`
- `--timeout <ms>`
- `--trace`, which writes every request to `results/<name>/traces/`
- `--resume`, which continues an interrupted benchmark

The proxy also writes every request to `results/proxy/requests.jsonl`, tagged with the run id.

## Layout

| Path | Contents |
|---|---|
| `bench.config.json`, `bench.smoke.json` | The run matrix and its settings |
| `docker-compose.yml`, `endpoints.json` | Oxigraph stores and the proxy |
| `profiles/` | The restriction profiles |
| `proxy/` | vord-proxy |
| `engines/` | Engine definitions. Generated configs and compiled engines go in `engines/generated/` |
| `data/` | The split script and partition map. Downloads, partitions and stores go in `data/generated/` and `data/stores/` |
| `harness/` | Engine generation, ground truth, the runner, the per-run worker and the analysis |
| `scripts/` | Setup |
| `test/` | Tests (`node --test`) |
