# Planned extension: client-side restriction proxy and benchmark suites

**Status:** planned 18 November 2026. Phases 1 (proxy) and 2 (suites) implemented and checked 18 November 2026 (§6). Phase 0 is postponed.

The current benchmark runs WatDiv on local Oxigraph stores, behind a proxy that advertises and enforces VoRD restrictions. This plan extends vord-bench in two directions:
- The proxy is generalized into a **client-side restriction proxy**. It runs next to the query engine and forwards requests to any SPARQL endpoint, whether a local benchmark store or a public endpoint. Restrictions can then be studied on federations that have none (FedShop, LargeRDFBench), and on real endpoints without overloading them.
- The harness can switch between three **suites**:
  - `watdiv`: small, the current benchmark;
  - `fedshop` and `largerdfbench`: large;
  - `realworld`: the SIB federated query catalogue from the fed-survey study.

The [report](report/REPORT.md) describes the current setup. [PLAN.md](PLAN.md) lists the planned changes to the Comunica fork.

## 1. Research questions and hypotheses

These are fixed before any campaign runs, so that the analysis is not tuned to the results.

| | Question | Hypothesis |
|---|---|---|
| RQ1 | On large federations under emulated restrictions, does knowing the restrictions (engines C and D) give more complete and correct results than regular Comunica (A, B, B′)? | D ≥ C > B ≥ A in the share of complete runs under P1–P7. As in `full-2`, D gives no silently wrong (truncated) results; C, which does not page, may. |
| RQ2 | How does the effect change with the number of federation members? | The gap between B and C/D grows with the number of members, because source selection sends requests to every member and each member has its own rate limit. |
| RQ3 | On real federated queries, do the VoRD engines stay within the endpoints' policies, and do they answer as completely as regular Comunica? | The VoRD engines have no rejected requests and no policy violations, and their completeness is at least that of B. |
| RQ4 | Does it matter whether the restrictions are advertised in the service description or provided with `endpointRestrictions`? | No: C and D behave the same either way. This is a validity check of the new feature, not a finding. |

The costs are measured too: time on queries that complete under both engines, and the overhead without restrictions (P0).

## 2. The client-side restriction proxy

```
harness ── Comunica A/B/B′/C/D (fetch wrapper tags each request with the run)
   │
   ▼
vord-proxy (on the client host, one port per federation member)
   ├─ emulation layer   enforces the profile: 429/503, truncation, timeout, concurrency
   ├─ description layer advertised (SD with VoRD) │ provided (VoRD file) │ none
   ├─ safety layer      per-upstream budget, circuit breaker, User-Agent, kill switch
   └─ measurement       request log: emulated vs upstream outcome, bytes, rows, waits
   │
   ▼
upstream: local store (Oxigraph / Virtuoso / QLever) │ public endpoint (UniProt, Wikidata, …)
```

**Two kinds of limits.**
- The *emulation layer* plays the endpoint that the engine sees: its restrictions are the experimental factor.
- The *safety layer* protects the upstream, independently of the profile. Its limits are always at most the upstream's published policy, and below the emulated limits.

**Invariant.** A request that the emulation layer rejects never reaches the upstream. Misconfigured profiles and naive engines therefore cannot overload a real endpoint.

### Changes to `proxy/vord-proxy.mjs`

Each change comes with unit tests that use a fake clock and a fake upstream, like the existing ones.

1. **Upstream adapter**
   - Send GET or POST per upstream, with configurable headers (User-Agent, `Accept`, auth) and gzip.
   - Stream responses instead of buffering them (`upstream.text()` today), and truncate while streaming for JSON, XML, TSV and CSV results.
   - Pass the emulated evaluation time to upstreams that accept a timeout parameter, so that queries aborted by the proxy also stop upstream where possible.
2. **Members**
   - Every federation member gets its own port, because Comunica keeps its limiter state per host. `endpoints.json` is generated per suite.
   - A member can map to a named graph of a shared store (FedShop) or to a remote URL.
   - URL variants of the same endpoint (`…/sparql` and `…/sparql/` in the catalogue) map to one member with one budget.
3. **Safety layer**, always on for `realworld`, configured per upstream host (aggregated over its members):
   - a token bucket and a concurrency cap;
   - a campaign budget (total requests);
   - a circuit breaker that pauses the campaign after repeated 403/429/5xx responses from the upstream;
   - a required User-Agent;
   - a kill switch on the admin port.

   Requests delayed or refused by the safety layer are logged separately, so that they are not counted as emulated restrictions.
4. **Description modes** per run:
   - `advertised`: the proxy serves a service description with VoRD, as today.
   - `provided`: the service description describes no restrictions, and the proxy serves a VoRD file per profile and member on the admin port, `/vord/<profile>/<member>.ttl`. The harness passes it as `endpointRestrictions` (or `[]` for members without restrictions). The VoRD engines are built from the main engine config, which cannot read local files, so the files are served over HTTP. The service description is generated, or for upstreams configured with `serviceDescription: "passthrough"`, it is the upstream's own.
   - `none`: as P8.
5. **Record and replay** (optional, mainly for `realworld`):
   - `record` stores the response and upstream latency per (member, normalized query, `Accept`).
   - `replay` answers from the store with the recorded latency, and forwards on a miss.
   - Replay is used for debugging and to estimate client-side variance. It is not used for the primary results, because it hides upstream variance.
6. **Measurement**
   - Each log entry gets: the run (from a request header set by the harness's fetch wrapper, instead of the admin's global run state), the member, the emulated outcome and the upstream outcome, bytes in and out, rows, the time queued in the proxy, and the upstream latency.
   - Politeness metric: the requests of A and B that the real policy would have refused.

## 3. Suites

A suite bundles:
- provisioning (stores and the data to download);
- the federation members and their upstreams;
- the queries and how they are read;
- the source list that engines get per query;
- the ground truth strategy;
- the profiles, timeouts and replications.

The harness takes `--suite <name>` and reads `suites/<name>/suite.json`. The engines, the proxy, the analysis and the plots are shared.

```
suites/
  watdiv/          suite.json, endpoints.json, docker-compose.yml, setup.sh (moved from the root)
  fedshop/         suite.json, docker-compose.yml (Virtuoso), setup.sh, members.json
  largerdfbench/   suite.json, deployment notes (QLever per dataset), setup.sh
  realworld/       suite.json, upstreams.json (policies and budgets), catalogue.lock.json
profiles/          shared profile definitions, with profile sets per suite
```

| | `watdiv` | `fedshop` | `largerdfbench` | `realworld` |
|---|---|---|---|---|
| Data | WatDiv scale 10, 1.09 M triples, split over 4 members | FedShop200 ([Zenodo 7919872](https://zenodo.org/records/7919872)): 3.9 GB, with a Virtuoso DB of 2.3 GB holding all 200 members | Interoperable Edition ([Zenodo 22140177](https://doi.org/10.5281/zenodo.22140177)): 13 datasets, 1.0 B triples, 12.9 GB as N-Triples and HDT | Live public endpoints |
| Members | 4 (+ `all`) | 20 to 200 (batches of 20) | 13 | 27 distinct endpoint URLs in the catalogue |
| Queries | 19 WatDiv templates (C1 has no results) + 8 challenge queries (X1–X8) | 12 templates × 10 instances | 40: S1–14, C1–10, L1–8, CH1–8 | 61 without `SERVICE` (`queries/no-service`) and 67 with `SERVICE` |
| Sources per query | all members | all members of the batch | all 13 | the query's `# Datasources:` header |
| Ground truth | computed on the `all` store | computed over the union of the batch's members | provided, in SPARQL JSON | a reference captured per campaign (§3.4) |
| Runs on | the SLICES VM | the SLICES VM | Virtual Wall (13 endpoints + client), or a subset on the VM | the VM, with the safety layer |

### 3.1 `watdiv` (small)

The current setup, moved into `suites/watdiv` without changes in behaviour. It is the regression test of the refactoring and stays the place for quick iteration.

**Done when:** a subset of `full-2` (P0, P1, P3 and P7; all engines; one replication) gives the same outcomes per query as before.

### 3.2 `fedshop` (large, scaling the number of members)

- **Data.** FedShop200 from Zenodo, pinned by version and MD5 (a newer version of the record exists; we choose one and record it). One Virtuoso container loads `fedshop-virtuoso.db`.
- **Members.** Each vendor and rating site is a virtual endpoint on that Virtuoso. The exact mechanism (named graph, or `default-graph-uri`) is to be confirmed from the FedShop wiki. The proxy gives every member its own port and maps it to its graph.
- **Queries.**
  - The 120 instances of `fedshop-workload.txt`. For the campaign, one instance per template (12 queries), as for WatDiv. A second instance is used only if the pilot shows that one instance per template is too noisy.
  - Batches 0, 4 and 9 (20, 100 and 200 members) form the scaling factor for RQ2.
- **Ground truth.** Each query is evaluated directly on Virtuoso over the union of the batch's member graphs. The FedShop README publishes the reference source assignment (`fedshop-service.txt`) but does not say that result sets are published, so we compute them ourselves and document how.
- **Confounder.** One Virtuoso serves all members, so members are not independent under load. We record its CPU and memory use and keep its concurrency well above the emulated limits.

### 3.3 `largerdfbench` (large, real data and queries)

- **Data and queries.** We use the Interoperable Edition by Tam, Saleem and Taelman (our team) rather than the original dumps:
  - every dataset parses strictly;
  - the expected results are in SPARQL JSON, with S7, C7 and C8 recomputed.

  Their setup is open source ([ask-count-fedx-large-rdf-bench](https://github.com/shape-federated-queries/ask-count-fedx-large-rdf-bench)): Comunica's FedX over one QLever endpoint per dataset, on 14 Virtual Wall machines. They ran S and C with a 30-minute timeout.
- **Hosting.** The SLICES VM (4 CPUs, 15 GB RAM) cannot host all 13 datasets: LinkedTCGA-M and -E alone have 760 M triples. There are two options:
  - **a.** Reuse the Virtual Wall deployment (recommended). We ask Bryan-Elliott Tam and Ruben Taelman.
  - **b.** On the VM, only the queries whose datasets fit. A pilot first determines, per query, which datasets it needs and how much memory the QLever indexes need.
- **Ground truth caveats.** Tam et al. show that the hosting engine can change answers (QLever canonicalizes numbers, which affects C7). S7 differs between set and bag semantics. We therefore report recall under both, and classify disagreements with the reference separately from engine errors.

### 3.4 `realworld` (the SIB federated query catalogue)

- **Catalogue.** It is imported from `fed-survey-results/queries`:
  - 61 queries in `no-service/` with a `# Datasources:` header, and 67 originals with `SERVICE`;
  - the metadata from `SIB_queries.csv` (toy example, known problems).

  The import records the source commit (today `7d72612`) in `catalogue.lock.json`. Which version counts as the updated catalogue is still to be decided (§7).
- **Endpoints.** The most frequent are UniProt (49 references, including URL variants), Rhea (23), EMI on biosoda (14), SwissLipids (13), Bgee (13), OMA (11), the QLever Wikidata mirror (9) and Wikidata Query Service (6).
- **Feasibility comes first.** In the survey runs of April and June 2026, none of the 60 queries returned results with Comunica.
  - The errors were mostly HTTP 403. In `EX1-12-06-26`: 68 from UniProt and 22 from Bgee.
  - In September 2025 there were no 403s, and a few queries returned results.

  Before any campaign, Phase 0 (§6) establishes why: blocked IP, User-Agent policy, or rate policy. It also finds the queries that still work. Without that, real-world results would measure blocking rather than restrictions.
- **Profiles.** Per endpoint, we write down its published policy with a source and a date. For example, the Wikidata Query Service is reported to allow 60 s of processing per 60 s per client, a 60 s timeout per query and 30 errors per minute; this is to be checked against the official user manual.
  - The emulated profile is derived from that policy, and is stricter.
  - Endpoints without a known policy get a conservative default, e.g. 1 request per second and 2 concurrent requests.
  - The safety budget sits below both.
- **Ground truth.** Live data changes, so no fixed reference exists:
  - **Reference.** The endpoint itself evaluates the original `SERVICE` query, as in the survey's `service-control` runs. This is captured at the start of each campaign window and repeated at the end, to detect drift.
  - **Interleaving.** For each query, all engines run back to back, in random order, within a short window.
  - **Classification.** A run is *complete* if it matches the reference. A query whose reference changed during the window is reported as *drifted*, not as an engine error.
- **Politeness and ethics.**
  - A descriptive User-Agent with the project URL. The contact address is decided by you; personal details are not added without that.
  - Runs at off-peak hours.
  - The planned total number of requests per endpoint is computed from the pilot and stays within the budget. If there is any doubt, the SIB operators are informed beforehand.

## 4. Changes to the harness and engines

1. **Suites.** `--suite` loads the suite configuration and plugins for:
   - provisioning;
   - reading queries (WatDiv `.txt`, the FedShop workload, LargeRDFBench `.sparql`, catalogue `.rq` with a `Datasources` header);
   - the sources per query;
   - ground truth (`compute`, `provided` or `reference-capture`).
2. **Engine isolation.** The fork's v5.4.1 config now contains the endpoint-restrictions context actor. The regular engines (A, B, B′) must replace `context-preprocess/actors-v5-4-1.json` by `actors.json`, so that provided restrictions can never reach them. A test checks this per engine.
3. **Description mode as a factor.** For C and D, `advertised` or `provided` (RQ4), via the proxy mode and the `endpointRestrictions` context entry. The fork is updated to `3259c326c2`, which has `endpointRestrictions` and the iterative paging.
4. **Comparison.** Recall and precision under bag semantics, as today, and also under set semantics for LargeRDFBench (S7).
5. **Run order.**
   - Within each block (suite, profile, query), engines run in a random order with a recorded seed. The proxy is reset between runs.
   - The upstream stores are warmed up once per query (an unrecorded run), and the stores are not restarted between runs. This choice is documented.
6. **Resource monitoring.** CPU and memory of the stores and of the client are sampled during runs, so that saturation can be recognized as a confounder.
7. **Campaign manifest.** Written with every campaign:
   - the git SHAs of the fork, vord-bench and the catalogue;
   - dataset DOIs and MD5s, and Docker image digests;
   - profile and suite hashes;
   - the Node version and the machine specification.

## 5. Experimental design and analysis

- **Factors.** Engine (A, B, B′, C, D), profile, description mode (C and D only), query, and the batch for `fedshop`. Replications: 3 for the benchmark suites; for `realworld`, 1 live run per engine, plus replays.
- **Profiles per suite.**
  - The benchmark suites use the P0–P8 family. Time compression stays at about 10× and is reported, so that campaigns fit on the VM.
  - For `fedshop` and `largerdfbench`, P7 becomes a seeded random assignment of *policy archetypes* to members: Wikidata-like, UniProt-like, a Virtuoso default (result limit and timeout), and unrestricted. The archetypes are derived from the policies documented for `realworld`, so the benchmark heterogeneity resembles real federations.
- **Outcomes per run.**
  - The status: complete, partial, wrong (false results), error, timeout, or drifted (`realworld` only);
  - recall and precision;
  - time and time to first result;
  - requests on the client side and at the proxy;
  - rejected requests and bytes;
  - for `realworld`, upstream requests and policy violations.
- **Primary metrics** (fixed in advance):
  - the share of complete runs per engine and profile;
  - the number of wrong runs;
  - rejected requests;
  - for `realworld`, policy violations, which must be 0 for C and D.
- **Statistics.** Queries are paired between engines:
  - McNemar's test for complete or not;
  - the Wilcoxon signed-rank test for time, on queries that complete under both engines;
  - bootstrap 95% confidence intervals of the differences;
  - Holm correction across profiles.

  With 12–61 queries per suite, the power is limited, so effect sizes and the per-query outcome matrices (as in Figure 3 of the report) are reported for every comparison, not only the significant ones.
- **Validity checks**, which must pass before a campaign is analyzed:
  1. Under P0, all engines are equally complete.
  2. The proxy's overhead: direct versus proxied under P0 on 5 queries.
  3. RQ4: advertised and provided give the same outcomes.
  4. A replay run gives the same outcomes as its recording.
- **Threats to validity**, discussed in the report:
  - emulated versus real enforcement;
  - time compression;
  - a single store serving all FedShop members;
  - answers that depend on the hosting engine (LargeRDFBench);
  - data drift and network variance (`realworld`);
  - other tenants on the VM;
  - different plans between runs.

## 6. Phases

Each phase ends with a checked done criterion before the next starts.

| Phase | Work | Done when |
|---|---|---|
| 0. Decisions and feasibility | Settle §7. Diagnose the 403s (one polite manual request per endpoint, with a proper User-Agent, from the VM and from elsewhere). Document the policies of the catalogue endpoints. Check VM capacity, and the VM's expiry date (12 December 2026) | Every catalogue endpoint is classified as usable, blocked or down, and a hosting decision exists for each suite |
| 1. Proxy | Changes 1–6 of §2 with unit tests | The tests pass, the overhead check passes, and the existing proxy tests still pass |
| 2. Suites | The suite abstraction; move WatDiv into `suites/watdiv`; engine isolation (§4.2) | The `watdiv` regression of §3.1 passes |
| 3. FedShop | Provisioning, members, ground truth. Pilot: batch 0, P0 and P1, engines B and D, 12 queries | The pilot's validity checks pass, and the campaign size and duration are estimated |
| 4. FedShop campaign | Batches 0, 4 and 9, all engines and profiles | Every run is recorded, and the analysis and figures are generated |
| 5. LargeRDFBench | Deployment (Virtual Wall, or a subset on the VM), suite, pilot with S and C queries, campaign | As for FedShop |
| 6. Real world | Catalogue import, upstream policies and budgets, pilot with 3 usable queries and engines B and D, campaign | 0 policy violations in the pilot, the budget is respected, and the reference is captured |
| 7. Report | A new report section per suite, and an update of PLAN.md with any Comunica changes that follow | The report has been reviewed |

**Checks of phases 1 and 2** (18 November 2026, on the SLICES VM, fork `3259c326c`):
- Unit tests: 115 of 115 pass, including the check that only C and D compile the actor that reads provided restrictions.
- Proxy overhead (`npm run overhead`, 5 queries × 20 repetitions): passed. Results were identical. The median overhead was 1.1–1.7 ms per request, and 15 ms (0.3%) for a query with 48,802 results.
- WatDiv regression (`regression-1`: P0, P1, P3 and P7, all 27 queries and 5 engines, 945 runs): all 945 runs have an outcome that full-2 also had. Complete runs took a median of 4–6% longer than in full-2. Two things changed at once (the proxy and the fork, from `aa8f9f0bc` to `3259c326c`), so the cause cannot be attributed.
- Description modes (`descriptions-1`: C and D under P1, P3, P6 and P7 on 6 queries): all 84 pairs have the same outcome with advertised and with provided restrictions. The number of queries sent (7,995) and of rejections (14) is identical in both. This is a first check of RQ4. The provided runs also fetch the VoRD files (216 requests to the admin port), which the analysis must leave out of the request counts.
- Run attribution by request header: per run, the proxy's request count equals the client's, except for requests that the client aborted or left pending. The safety layer refused no requests.

**Rough size.** For FedShop: 12 queries × 5 engines (+ 2 for the provided mode) × 7 profiles × 3 batches × 3 replications ≈ 5,300 runs, and its pilot gives the duration per run. That is too long for the VM without cutting profiles, so the pilot also decides which profiles are kept.

## 7. Open decisions

1. **Which large benchmark first.** The recommendation is FedShop: it fits on the VM, and the number of members matters directly for rate limits. LargeRDFBench would follow on Virtual Wall.
2. **Hosting.** Extend the SLICES VM beyond 12 December 2026, or move to Virtual Wall.
3. **Catalogue version.** Which commit or export counts as the updated query catalogue.
4. **Wikidata.** The Wikidata Query Service, the QLever mirror, or both, since the catalogue uses both.
5. **User-Agent contact,** and whether to inform the SIB and Wikimedia operators before the real-world campaign.
6. **Real-world replications.** One live run per engine with replays, or more live runs if the budget allows.
