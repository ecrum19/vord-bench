# vord-bench

This benchmark measures whether Comunica queries endpoints that have restrictions better when it knows those restrictions. The restrictions are described with [VoRD](https://w3id.org/vord) in SPARQL service descriptions.

It compares engines built from the Comunica fork ([`ecrum19/comunica@feature/vord-restrictions`](https://github.com/ecrum19/comunica/tree/feature/vord-restrictions)) against dummy endpoints. The dummy endpoints describe their restrictions with VoRD and also enforce them.

The [report](report/REPORT.md) describes the implementation, this setup, the exact VoRD terms tested, and the results of the run `full-2`. [PLAN.md](PLAN.md) lists the planned changes to the Comunica fork that follow from it.

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

- **Data and queries.** The data is WatDiv at scale 10 (1.09M triples, from [comunica-performance-assets](https://github.com/comunica/comunica-performance-assets)). The queries are the WatDiv templates (L, S, F, C) and eight challenge queries (X), see [Queries](#queries).
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

### Queries

WatDiv fills the placeholders of its templates with values that are sampled independently of the data, so at scale 10 many of its instances have no results. [`harness/generate-queries.mjs`](harness/generate-queries.mjs) therefore instantiates the templates again, with values that give results on the full dataset:

- The placeholders of a template are the entity constants whose value differs between its WatDiv instances. Constants that are equal in all instances, such as `wsdbm:Role2` in S2, are part of the template.
- For every combination of placeholder values, the generator counts the results on the unrestricted store. It picks up to five combinations with results, at the 50th, 25th, 75th, 10th and 90th percentile of the result counts. The first instance, which the benchmark uses by default, has the median count.
- If no placeholder values give results, the template's own constants are also replaced (*relaxed*; this is the case for C2, whose `wsdbm:Country5` gives no results).
- Templates without results for any values are excluded: C1 has no constants and no results at this scale.

The generator records the placeholders, picked values and result counts in `data/generated/queries/instances.json`.

The challenge queries in [`data/challenge/`](data/challenge/) go beyond the basic graph patterns of WatDiv. Each one stresses a way in which restrictions can silently change or slow down results in a federation:

| Query | Results | What it tests |
|---|---|---|
| X1 | 4470 | A large result from one endpoint: truncated by result size limits unless the client pages |
| X2 | 238 | A small result that joins a large intermediate result (reviews of products) with a selective one (top-rated reviews with a title) across endpoints |
| X3 | 854 | `OPTIONAL` across endpoints: products of a genre with their reviews and ratings, if any |
| X4 | 13 | Aggregation (`COUNT`, `SUM`) over a join across endpoints: truncated input gives wrong counts and sums |
| X5 | 10 | Top-k (`ORDER BY` and `LIMIT`) over thousands of offers: truncated input gives a wrong top 10, and the join needs many requests |
| X6 | 66 | A numeric `FILTER` over a chain across three endpoints |
| X7 | 323 | `UNION` of likes and purchases, whose patterns are spread over two endpoints |
| X8 | 100 | A chain over all four endpoints, from a retailer to the ages of reviewers |

Ratings and prices are plain literals in WatDiv, so the challenge queries cast them to `xsd:integer` where they compare or sum them.

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
npm run setup          # fork build, data, stores, endpoints, engines, queries, ground truth (idempotent)
npm test               # unit tests; with the fork built, also checks how the fork reads the proxy's descriptions
npm run bench:dry      # prints the run matrix and checks that everything is in place
npm run bench:smoke    # a small subset: 4 queries x 4 profiles x 4 engines, with request traces
npm run bench -- --name full-1
npm run analyze -- results/full-1
npm run plot -- results/full-1   # figures in results/full-1/figures/ (needs Python 3 with matplotlib)
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
| `data/` | The split script, partition map and challenge queries. Downloads, partitions, generated queries and stores go in `data/generated/` and `data/stores/` |
| `harness/` | Engine and query generation, ground truth, the runner, the per-run worker, the analysis and the plots |
| `scripts/` | Setup |
| `test/` | Tests (`node --test`) |
