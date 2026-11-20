# Design: the `fedshop` suite with realistic, varied restrictions

**Status:** design, 20 November 2026. It is based on measurements on the SLICES VM:
- FedShop's data and workload;
- the Virtuoso deployment;
- five pilots of Comunica without restrictions, at 20, 40, 60 and 100 members;
- a replay of Comunica's requests to measure where result caps would bite;
- a simulation of every restriction archetype on the pilots' per-member traffic (revised the same day, with the new archetype mix of §5.2).

This refines §3.2 and §5 of [PLAN-SUITES.md](PLAN-SUITES.md).

**Progress, 20 November 2026** (details in §11):
- **Restrictions:** the archetypes of §5 are implemented, and are suite-agnostic.
  - Two default profiles: `simple` and `restrictive` (the mix of §5.2), each with seeds 1–3.
  - One profile per archetype: `archetype-<id>`.
  - Their proxy emulation is implemented and tested on the VM; see [profiles/README.md](profiles/README.md).
- **VoRD 0.3** adds the terms they need. It is in a pull request: [ecrum19/vord#4](https://github.com/ecrum19/vord/pull/4).
- **The fork handles the new restrictions**, in a local commit on `feature/vord-restrictions` that is not pushed yet:
  - it sends identification only to the endpoints that require it;
  - it paces requests on usage budgets;
  - it does not retry zero-tolerance bans.
- **The FedShop suite itself** (provisioning, endpoints file, warm cache, harness reader, pilot) is not implemented yet.

## 1. Recommendation in brief

- **Subset.** The main federation is FedShop batch 1: **40 members** (20 vendors and 20 rating sites, 8.1 M triples). Batch 0 (20 members, 3.6 M triples) is the second point for scaling. Batch 4 (100 members) is a stretch goal for a later phase on bigger hardware. The workload is one instance of each template: 10 queries at batch 1 and 11 at batch 0.
  - At 100 members, Comunica already fails 4 of 11 queries *without* restrictions.
  - From 40 members up, its plans depend on how loaded the shared store is (§3, §4.2).
- **Deployment.** One Virtuoso holds all 200 members as named graphs. The vord-proxy gives each member its own port and sends `default-graph-uri`. A safety cap protects the shared store. A **warm response cache with modeled latency per member** keeps the store's load from changing Comunica's plans (§4.2). This cache is the main new piece; it is not yet tested.
- **Restrictions.** 13 archetypes in three groups, with **only 5% of the members open** (§5.2):
  - **Documented policies:** open endpoints, Virtuoso defaults, DBpedia, Wikidata, a UniProt-like rate limit, a CDN in front of a Virtuoso, and an nginx rate limit.
  - **Access models:**
    - **usage tokens (10%):** a cost model charges each request in units, from a refilling budget, as OpenAlex, GitHub and Shopify do;
    - **identified access (10%):** every request must carry a persistent contact (an email address), as Wikimedia and Nominatim require, with normal limits per user.
  - **Adversarial:**
    - zero tolerance (a ban at the first violation);
    - a tarpit (delays, no errors);
    - an endpoint that silently returns empty answers under pressure;
    - a budget shared with other users.

  They are assigned to members in blocks of 20, so that batches 0 and 1 have exactly these shares. They vary on purpose:
  - between members;
  - with member size and with the query;
  - over time;
  - in what a request costs and what the client must disclose;
  - in the penalty for a violation;
  - in how failures are signalled, or whether they are signalled at all;
  - with other users' load;
  - in what is advertised.
- **What VoRD and the fork need.**
  - The usage tokens fit existing VoRD terms. The identification requirement needs one new class and two new properties.
  - The fork could already comply with the adversarial archetypes. Two fork changes, now made (§5.10), let it comply with tokens and identification as well.
- **Calibration** against the measured workload:
  - The common 10,000-row cap truncates *nothing* in Comunica's FedShop requests, so capped members draw their cap from the measured distribution, and the single-factor truncation profile uses 1,000 rows.
  - Every new archetype was simulated on the pilots' traffic. Each binds on most queries, except the usage tokens, which bind on the heavy ones. Each stays within the 300 s timeout for an engine that paces itself; the tightest case is q04 at batch 1, at 148 s or more.
  - The binding restrictions are per-second and in-flight limits, so **no time compression** is needed.
- **Size.** About 1,850 runs: 14 profiles, 3–7 engines each, 1–3 repetitions or seeds, 2 batches. Estimated at about 20 hours of VM time.
- **Hardware.** The SLICES VM is enough for batches 0 and 1: about 8 GB of RAM and 7 GB of disk at peak. Batch 4 needs more CPU for the store and the engine (16+ cores, as on Virtual Wall), and the VM expires on 12 December 2026.

## 2. FedShop as measured

FedShop ([GDD-Nantes/FedShop](https://github.com/GDD-Nantes/FedShop), ISWC 2023) is a BSBM-style e-commerce federation. Each *vendor* holds offers and each *rating site* holds reviews. Both hold their own local copies of the products they sell or review, linked to the shared catalogue with `owl:sameAs`. All members share one schema, and every IRI of a member starts with its own domain (`http://www.vendor3.fr/…`).

**Version.** Zenodo has 8 versions. The latest is [12204740](https://doi.org/10.5281/zenodo.12204740) (June 2024, 10.4 GB). PLAN-SUITES cited v1, [7919872](https://zenodo.org/records/7919872) (May 2023). Its Virtuoso DB is a different size (2.3 vs 2.4 GB), so the two are not interchangeable. The latest version is on the VM, and all MD5s match the record.

| File | Size | Use |
|---|---|---|
| `fedshop-virtuoso.db` (Virtuoso 7.2) | 2.38 GB | All 200 members, one named graph each. The only file needed to serve the federation. |
| `fedshop-workload.txt` | 139 kB | 119 query instances (q01 has 9, the others 10). UTF-8 with BOM, CRLF. |
| `gen-model.zip` | 65 MB | Reference answers per instance and batch (`results.csv`, 1,200 files), without term types. |
| `eval-model.zip` | 159 MB | FedShop's runs of FedX, CostFed, Semagrow, SPLENDID and ANAPSID: times, ASK counts, failures. |
| `fedshop_dataset.zip` | 2.09 GB | Per-member N-Quads (12.8 GB unpacked). Only for the ground-truth store. |
| `fedshop_batches.zip` | 5.67 GB | The same data, cumulated per batch. Not needed. |

**Batches.** Batch *i* = vendors and rating sites 0 to 10(*i*+1)−1. So every batch contains the previous one, and a member keeps its identity as the federation grows.

| Batch | Members | Triples | N-Quads |
|---|---|---|---|
| 0 | 20 | 3.6 M | 1.0 GB |
| 1 | 40 | 8.1 M | 2.4 GB |
| 2 | 60 | 12.3 M | 3.6 GB |
| 4 | 100 | 20.9 M | 6.2 GB |
| 9 | 200 | 43.2 M | 12.8 GB |

For comparison, the `watdiv` suite has 1.09 M triples on 4 members.

**Members differ in size, and rating sites are larger than vendors.** Triples per member, over all 200:

| Pattern | Vendors: min / median / max | Rating sites: min / median / max |
|---|---|---|
| all triples | 36 k / 96 k / 150 k | 56 k / 340 k / 603 k |
| `?s rdfs:label ?o` | 4.5 k / 10.9 k / 16.0 k | 6.5 k / 28.8 k / 40.2 k |
| `?s rdf:type ?o` | 8.1 k / 21.8 k / 34.4 k | 12.3 k / 78.2 k / 141.6 k |
| offers (`bsbm:product`) / reviews (`bsbm:reviewFor`) | 367 / 1,106 / 1,864 | 571 / 5,017 / 10,616 |

**Queries.** There are 12 templates (q01–q12).
- Their final answers are small: 1–72 rows for instance 0, even with 200 members.
- Almost every triple pattern matches every member, so source selection can prune few members. **What matters for restrictions is the intermediate requests to each member, not the final answer.**

**FedShop's own engines.**
- FedX sends a median of about 10.5 ASK requests per member per query, so its ASK count grows linearly with the number of members.
- At batch 4, FedX fails only q06 and 3 of 10 q04 instances.
- At batch 9, without any restriction, FedShop's engines time out on 32–83% of the queries (CostFed 38/120, FedX 50, Semagrow 52, SPLENDID 100).

## 3. The subset

**Baseline without restrictions (P0)**, for Comunica engine D (and A where noted). The settings: the proxy with the socket retry; a 120 s timeout at batch 4 and 300 s elsewhere; the store with 20 threads and a safety cap of 16 ("cap 16"), or 40 threads and a cap of 32 ("cap 32").

| Query | Batch 0 (20) | Batch 1 (40) | Batch 2 (60) | Batch 4 (100) |
|---|---|---|---|---|
| q01 | ok, 3 s (1,461 req.) | ok, 9 s (5,758) | — | ok, 47 s (35,904) |
| q02 | ok, 3 s | D ok, 13 s; **A timeout** (cap 32) | — | ok, 69 s (40,675) |
| q03 | ok, 6 s (3,345) | **timeout** (276,950 req.) | timeout | timeout |
| q04 | ok, 9 s (8,011) | ok, 44 s (35,802) | timeout (cap 16 and 32) | timeout |
| q05 | **timeout**: the client-side join is CPU-bound | — | — | — |
| q06 | ok, 3 s (260) | ok, 7 s (1,000) at cap 16; **timeout** (about 200,000) at cap 32 | timeout | timeout |
| q07 | ok, 2–5 s | ok, 3–14 s | — | ok, 10 s |
| q08 | ok, 5–8 s | **timeout**, A and D (cap 32) | — | ok, 8 s (2,804) |
| q09, q11 | ok, ≤ 1 s | ok, ≈ 1 s | — | ok, ≈ 3 s |
| q10 | **error**: Virtuoso rejects Comunica's empty `VALUES( ){ ( ) }` | — | — | error |
| q12 | ok, 2 s | ok, 4 s | ok, 74 s | timeout |

**Two failure modes, neither caused by restrictions:**
1. **Request volume grows with the square of the number of members.**
   - Comunica cannot tell that `http://www.vendor3.fr/Product123` can only match at vendor3. So every binding from every member is bind-joined against every other member.
   - q01 needs 1,461 requests at 20 members and 35,904 at 100 (25×). q03 jumps from 3,345 at 20 members to more than 270,000 at 40.
   - FedX prunes these requests with ASK, and its request count grows linearly. Pruning by IRI authority would be a separate improvement to Comunica, outside this suite.
2. **Plans depend on the load of the shared store** (§4.2). q06, q08 and q02 at batch 1 switch from a cheap plan to one with 200,000+ requests, depending on the store setting and the engine.

**Recommendation:**
- **Main federation: batch 1** (40 members, 8.1 M triples), with the warm cache of §4.2.
  - This is 10 times the WatDiv federation.
  - It is the largest size where all but q03 and q05 complete without restrictions.
- **Second point: batch 0** (20 members). All queries except q05 (and q10 without the rewrite) are stable there.
- **Stretch: batch 4** (100 members), later and on bigger hardware (§8). Only q01, q02, q07–q09 and q11 complete there without restrictions.
- **Queries:** instance 0 of each template, as for WatDiv. Batch 0 uses 11 (all but q05), batch 1 uses 10 (also without q03). q10 stays only if decision 4 is the rewrite.
- **Why not batch 9:** without restrictions, FedShop's own engines already time out on a third or more of its queries (32–83%), and Comunica would fare worse.
- **Changing batches is free:** one store serves all of them, and a batch is only a list of sources.

## 4. Deployment

```
harness ── Comunica A/B/B′/C/D ──▶ vord-proxy ─────────────────────────────────────▶ Virtuoso 7.2.13
                                    one port per member                               all 200 members, one named graph each
                                    emulated restrictions per member                  default-graph-uri = the member's graph
                                    warm cache: hit → modeled latency of the member
                                    miss → safety cap (16 in flight) → store, then cached
```

### 4.1 Store and proxy

- **One Virtuoso container** runs FedShop's DB: `openlink/virtuoso-opensource-7:7.2.13-alpine`, FedShop's pinned version, with host networking.
  - Buffers are set for 8 GB (`NumberOfBuffers` 680,000), with `ResultSetMaxRows` 0 and no timeouts. The store itself must never restrict; all restrictions are emulated in the proxy.
  - Ready after 21 s, using 3.7–4.3 GiB.
  - The image applies `VIRT_*` environment variables only when it first creates `virtuoso.ini`, so later changes must be made in the ini itself.
- **Members.** A member is a named graph. The proxy's existing `defaultGraph` option sends `default-graph-uri`, as FedShop's own reference assignment does.
- **Ports.** One port per member, as now, because Comunica keeps its limiter state per host. Vendors use 4100–4199 and rating sites 4300–4399.
- **Safety cap: 16 requests in flight, with 20 Virtuoso HTTP threads.**
  - Without a cap, the store returned 502s under engine A.
  - With 40 threads and a cap of 32, the store's time per COUNT rose from 15 to 45 ms, and plans got worse (§4.2). So the smaller setting is better on 4 vCPUs.
- **Socket retry.** Virtuoso closes idle keep-alive connections, and undici then fails with `UND_ERR_SOCKET`: at batch 4, 126 times in about 300,000 requests. One such failure aborted a whole run. A single retry in the upstream adapter fixed every case: 349 retries over about 2.6 million requests, and no run was lost to it afterwards.

### 4.2 Why a warm cache is needed

Comunica gives each COUNT request (used for cardinality estimates) **3 s**. One store that serves N members must answer N × k COUNTs at the start of each query. On 4 vCPUs, some of them pass the 3 s limit. The planner then lacks those cardinalities, picks a bind join, and the query explodes:

| q06, first ~300 COUNT requests | Batch 1, cap 16 | Batch 1, cap 32 | Batch 2, cap 16 | Batch 2, cap 32 |
|---|---|---|---|---|
| Time in Virtuoso (median) | 15 ms | 42–48 ms | — | — |
| Latency p95 / max | 1.8 / 2.2 s | 2.8–3.0 / 3.0 s | — / 3.0 s | — / 3.0 s |
| COUNTs over 3 s (aborted) | 0 | 11 (A), 15 (D) | 10 | 17 |
| Run | ok, 7 s, 1,000 requests | timeout, about 200,000 | timeout, 209,100 | timeout, 218,820 |

With real, separate endpoints, each server would answer its own k COUNTs in milliseconds. The plan flip is an artefact of emulating many servers with one, and it makes outcomes differ between runs, engines and store settings. Without a fix, the benchmark would measure store load, not restrictions.

**The fix: a warm response cache in the proxy.**
- The data is static, so a stored response is exactly what the store would return.
- **Hit:** served after the member's *modeled latency* (a per-member network latency plus a transfer time per KB), not after the store's time.
- **Miss:** goes to the store through the safety cap, and is then stored.
- The existing recorder already forwards and records misses in its replay mode. Two changes are needed:
  1. replay with modeled latency instead of the recorded store time;
  2. a store that holds millions of entries (an SQLite file or an append-only log with an index, not one JSON file per response).
- **Warm-up.** Before each batch, one pass of every query with every engine under F0 fills the cache. Since outcomes vary between engines, every engine's requests must be in it. The cheap COUNTs are additionally prefilled one by one, so that they are fast from the first run.
- **Validity check (new).** With the cache warm, each engine runs each query 3 times under F0. The request counts must agree within 5%, so that plans are stable. This has not been tested yet; it is the first thing the pilot (§9, step 7) checks.

Two alternatives, if the cache is not wanted:
- a longer COUNT timeout in all engines, which changes the engines rather than the emulation;
- enough CPU for the store (§8), which makes the problem less likely but does not remove it.

## 5. Restrictions: realistic archetypes with deliberate variance

### 5.1 Principles

1. **Real-world values.** Every archetype is modelled on a documented policy, a shipped default or a widely used rate-limiting mechanism (§5.3–5.6). Each profile records its source and retrieval date. The adversarial archetypes (§5.6) use real mechanisms with deliberately harsh settings, and are marked as such.
2. **Variance on purpose.** An engine that ignores restrictions should fail in several different ways, and no single global setting (one back-off, one page size) should fit every member.
3. **Calibrated to the workload.** Each restriction must bind on some (query, member) pairs and not on others. This is checked against the measured request demand and response sizes, by simulating each archetype on the pilots' per-member traffic (§5.7).
4. **Satisfiable.** An engine that respects every *described* restriction must be able to finish each query within the timeout.
   - Two archetypes, T and I, needed fork support (§5.10). It is now implemented, but not pushed yet.
   - Queries that no engine can finish under a profile are reported, not counted against the VoRD engines.
5. **Stable member identity.** Archetypes are assigned per member, in blocks of 20 (§5.2). A member keeps its archetype in every batch.
6. **Replication over assignments.** The mix runs with 3 seeds, i.e. 3 different assignments, instead of 3 repetitions of one.
7. **Presence matters more than share.**
   - Almost every triple pattern matches every member (§2), so every query reaches every member, and one member that rejects an engine is enough to fail the query.
   - So shares set how many members of each kind an engine must handle at once, and how realistic the mix is. They do not scale the failure rate.
   - The harness attributes each failure to the member and archetype that caused it (§5.9).

### 5.2 Archetypes and shares

As you asked, the mix is harsher than the measured web: only 5% of the members are open. There are 13 archetypes in three groups:

| Group | Archetype | Share | Batch 1 (40) | Batch 0 (20) | How it fails an engine that ignores it |
|---|---|---|---|---|---|
| Documented policies (§5.3) | **S** — open | 5% | 2 | 1 | — |
| | **O** — Virtuoso out of the box | 10% | 4 | 2 | Silent truncation (only with a low cap) |
| | **V** — tuned public Virtuoso (DBpedia) | 5% | 2 | 1 | 429/503 and a ban (q04 only) |
| | **W** — Wikidata-like | 10% | 4 | 2 | 429, then a ban |
| | **U** — UniProt-like rate limit | 10% | 4 | 2 | 429 + `Retry-After` |
| | **C** — CDN in front of a Virtuoso | 5% | 2 | 1 | As O, plus 504 |
| | **R** — reverse-proxy rate limit (nginx) | 10% | 4 | 2 | 503 without `Retry-After` |
| Access models (§5.4, §5.5) | **T** — usage tokens | 10% | 4 | 2 | 429 once the budget is spent |
| | **I** — identified access | 10% | 4 | 2 | 403 on every request |
| Adversarial (§5.6) | **Z** — zero tolerance | 5% | 2 | 1 | A 403 ban after the first violation |
| | **L** — tarpit | 5% | 2 | 1 | No error, only growing delays |
| | **E** — empties under pressure | 10% | 4 | 2 | Silently empty answers |
| | **G** — shared budget | 5% | 2 | 1 | 429s that depend on other users |

- **Assignment in blocks of 20.**
  - Every share is a multiple of 5%. So each block of 20 members (vendors and rating sites *i* to *i*+9, for *i* = 0, 10, 20, …) holds one member of each 5% archetype and two of each 10% archetype.
  - So batch 0 (one block) and batch 1 (two blocks) have exactly these shares, and a member keeps its archetype as the federation grows.
- **Stratified by role.**
  - Within a block, each 10% archetype gets one vendor and one rating site.
  - The six 5% archetypes are split three to vendors and three to rating sites, swapped in the next block.
  - The seed permutes the members within each role, and draws the caps of O and C (§5.3).
- **Changes from the first draft:**
  - S drops from 45% to 5%.
  - O, V and U drop by 5 points each.
  - R, T, I and the four adversarial archetypes are new.
- **Restricted on paper, but not in practice.** O, C and V do restrict, but rarely in a way that FedShop's requests reach (§5.7). Their 10,000-row caps and 60–120 s timeouts do not bind.
  - So for every batch-1 query except q08, S, O and C (20% of the members) behave as open. In q08, O and C bind only if the drawn cap is low.
  - V binds only on q04.
  - T binds on the heavy queries, and every other archetype on most queries.
- **Shares file.** The shares live in `archetypes.json`. The first draft's census-like shares (45% open) remain available as a sensitivity mix (`FM-census`, §5.9).

### 5.3 Documented policies

The values come from documented policies, shipped defaults and measurement studies, collected on 20 November 2026. Spot checks against the primary sources:
- Buil-Aranda et al., Table 3;
- Virtuoso's shipped `virtuoso.ini`;
- the WDQS user manual;
- NGINX's rate-limiting guide.

**How common result caps are.** This is the only restriction that has been measured across many endpoints.
- *Buil-Aranda et al., ISWC 2013* ([PDF](https://aidanhogan.com/docs/epmonitorISWC.pdf)): of 427 endpoints, 68 returned a round-number cap. **49 of them capped at 10,000.** The rest: 100,000 (7), 1,000 (3), 50,000 (3), 20,000 (2), and one each at 500, 1,500, 5,000 and 40,000.
- *SPARQLES* (Wayback snapshots, 2017–2022): 22–30% of the available endpoints are capped, and 10,000 is 64–72% of the caps. In 2022, 29 of 96 endpoints were capped, 21 of them at 10,000.

| Archetype | Based on | Restrictions (real time) | How it signals | Share |
|---|---|---|---|---|
| **S — small institutional, open** | Fuseki, Oxigraph and GraphDB defaults (no limits) | none | — | 5% |
| **O — Virtuoso out of the box** | Shipped `virtuoso.ini`: `ResultSetMaxRows` 10,000; `MaxQueryExecutionTime` 60 s (anytime) | Cap drawn from Buil-Aranda's distribution: 10,000 (72%), 100,000 (10%), 20,000–50,000 (9%), 500–5,000 (9%). 60 s timeout | Silent truncation (200); a partial (here empty) answer after the timeout (200 + `X-SQL-State: S1TAT`, formatted as if complete, as Virtuoso's anytime queries are) | 10% |
| **V — tuned public Virtuoso (DBpedia)** | [DBpedia fair use](https://www.dbpedia.org/resources/sparql/): 10,000 rows; 120 s anytime; 50 connections and 100 req/s (burst 120) per IP, then a temporary ban | 10,000 rows; 120 s; 50 in flight; 100 req/s, burst 120 | Truncation with `X-SPARQL-MaxRows`; partial results (200); 429/503; ban | 5% |
| **W — Wikidata-like** | [WDQS manual](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual#Query_limits): 60 s timeout; 5 parallel queries per IP; 30 errors/min; 60 s of processing per 60 s; persistent violators are banned | 5 in flight; 60 s (error); 30 errors/min, then a ban | 429 + `Retry-After`; 403 once banned; no row cap | 10% |
| **U — rate-limited bio endpoint (UniProt-like)** | sparql.uniprot.org: 45 min timeout and "very high" row limits; 429 with `Retry-After: 10` after 30–35 requests within 1 s ([measured in 2026](https://rubensworks.github.io/article-did-llms-kill-sparql-federation); the real limit is not published) | About 30 requests per second (burst); no practical cap | 429 + `Retry-After: 10` | 10% |
| **C — CDN in front of a Virtuoso** | Bgee behind Cloudflare (origin timeout 125 s, then 524); data.europa.eu behind CloudFront (30 s, then 504) | O's restrictions, plus a 30 s front timeout | As O, plus 504 | 5% |
| **R — reverse-proxy rate limit** | nginx `limit_req`, the usual way to rate-limit a Fuseki, GraphDB or Virtuoso behind nginx. [NGINX's guide](https://blog.nginx.org/blog/rate-limiting-nginx) uses `rate=10r/s` and `burst=20`: excess requests within the burst are queued at the rate, the rest are rejected with 503 by default | 10 requests per second; up to 20 more are delayed; beyond that, rejected | 503 without `Retry-After` | 10% |

### 5.4 Usage tokens (T)

**Real-world model.** Several APIs meter usage in cost units rather than in requests:
- **[OpenAlex](https://help.openalex.org/how-to-use-the-api/rate-limits-and-authentication)** (page updated 17 November 2026):
  - a daily budget per API key, priced per request type: single-entity lookups are free, list requests cost 0.0001 USD and searches 0.001 USD;
  - a free key gets 10 times the keyless budget;
  - every response reports `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Credits-Used` and `X-RateLimit-Reset`;
  - a spent budget returns 429.
- **[GitHub's GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)**:
  - 5,000 points per hour per user;
  - a query costs the number of requests its connections need, divided by 100, and at least 1 point;
  - a secondary limit of 2,000 points per minute;
  - `x-ratelimit-remaining` reports the rest.
- **[Shopify's GraphQL Admin API](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)**:
  - a leaky bucket that refills at a rate that depends on the plan (100 points per second on the standard plan);
  - the requested cost must fit before execution, and the difference to the actual cost is refunded afterwards.
- **WDQS** (W) is the time-based variant: 60 s of processing per 60 s.

**Emulation, kept simple on purpose.**
- **Cost of a request:** 1 unit, plus 1 if it is an aggregate (Comunica's COUNTs), plus 1 per full 100 result rows.
  - The aggregate surcharge models that scans cost more.
  - A surcharge of 4 was tried first. But Comunica sends mostly COUNTs (717 of 965 requests per member in q04 at batch 1), so even a perfectly paced engine would need at least 746 s for q04. With a surcharge of 1, it needs 148 s.
- **Budget:** a token bucket per client of **200 units, refilled at 10 units per second** (600 per minute).
- **Charging:**
  - The base cost (1 or 2) is charged on arrival. The request is rejected with 429 if the bucket holds less than that.
  - The row cost is charged on completion. This may take the bucket below zero, as Shopify's actual cost does.
- **Signals:**
  - Every response carries `X-RateLimit-Limit: 600`, `X-RateLimit-Remaining`, `X-RateLimit-Credits-Used` (the cost of this request) and `X-RateLimit-Reset`, as OpenAlex does.
  - A rejection is a 429 with a `Retry-After` of the seconds until the base cost fits.
  - The standards-track equivalent is the IETF `RateLimit` and `RateLimit-Policy` fields ([draft 11](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)), but their quota units are limited to requests, content bytes and concurrent requests.
- **Why the period is a minute, not a day.** A run lasts at most 300 s, and the proxy resets each client for every run. A daily budget would either never bind or carry over between runs.

**In VoRD**, all of this fits existing terms:
```turtle
<#tokens> a vord:CostModelRestriction ;
  vord:metric vord:estimatedCostUnits ;
  vord:costModel <#fedshop-units-v1> ;
  vord:maxValue 600 ; vord:windowDuration "PT60S"^^xsd:duration ; vord:burstValue 200 ;
  vord:hasScope vord:PerClientIP ;
  vord:enforcement vord:RejectRequest ; vord:returnsStatusCode 429 ;
  vord:httpSignalHeader <#x-ratelimit-remaining> ;   # range http:HeaderName
  vord:hardRestriction true .
<#fedshop-units-v1> a vord:CostModel ;
  rdfs:comment "1 unit per request, +1 for an aggregate, +1 per full 100 result rows."@en .
```

**What the fork does** (since the change of §5.10; before, it ignored cost-model restrictions, so D behaved like B on T members):
- Each request reserves the minimum cost of one unit, and waits until the budget can pay for it. The safety margin reduces both the budget and its refill rate.
- The remaining budget reported in the signal header (`X-RateLimit-Remaining`), or a 429, corrects the estimate downwards, so requests that cost more slow down the following ones.
- The budget's status code (429) is retried, honouring `Retry-After`.

**What binds** (unpaced traces, §5.7):
- **Where the bucket rejects requests:** at every member in q02 and q04 at batch 1, and in q03 and q04 at batch 0. In q08, 4 of the 20 members reject, because of large responses.
- **Where it does not bind:** q01, q06, q07, q09, q11 and q12 stay within the bucket.
- **The cost for a perfectly paced engine:** at least 148 s for q04 at batch 1, and 23 s for q02.

### 5.5 Identified access (I)

**Real-world model.**
- **[Wikimedia's User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)** (it also covers WDQS):
  - The User-Agent must identify the client and give a contact: an email address, a website or a wiki user. For example: `CoolBot/0.0 (https://example.org/coolbot/; coolbot@example.org)`.
  - On Wikimedia wikis, requests without a User-Agent or with a generic one get 403.
- **[Nominatim's usage policy](https://operations.osmfoundation.org/policies/nominatim/)** (OSMF):
  - It requires a valid Referer or an identifying User-Agent; stock library User-Agents are not enough.
  - It allows at most 1 request per second, and forbidden use gets clients banned.
- **OpenAlex:** an API key per user gives 10 times the keyless budget.
- **RFC 9110, §10.1.2:** the standard `From` header carries the email address of the person who controls the user agent.

**Emulation.**
- **Every query request must carry a contact.**
  - Half of the I members (the vendor in each block) require an email address in `From`.
  - The other half (the rating site) require a Wikimedia-style User-Agent, with the contact in parentheses.
  - A request without a valid contact gets **403** with a short policy text.
  - The service description is served without identification, so that a client can learn the requirement.
- **The contact is persistent.** It is the user's identity, and every limit is counted per identity. A client that uses a second identity within one run is treated as evading the limits, and gets 403 for the rest of the run.
- **"Normal" limits per identity:**
  - 20 requests per 2 s, so bursts of 20 and 10 per second on average (429 + `Retry-After: 1`);
  - 10 in flight;
  - 10,000 rows (silent truncation);
  - 60 s.
- **The benchmark's contact is synthetic**, on a reserved domain (RFC 2606): `vord-bench@example.org`. The proxy checks only its form, and nothing is sent anywhere.

**In VoRD.**
- The limits use existing terms, with `vord:hasScope vord:PerUser`.
- The requirement itself had no term. VoRD 0.3 ([ecrum19/vord#4](https://github.com/ecrum19/vord/pull/4)) adds:
  - `vord:IdentificationRestriction`, a subclass of `vord:Restriction`: requests must identify the client;
  - `vord:identificationHeader`: the header that must carry the contact (`http:from` or `http:user-agent`);
  - `vord:identificationFormat`: `vord:EmailAddress` or `vord:ProductWithContact`;
  - used with `vord:enforcement vord:RejectRequest` and `vord:returnsStatusCode 403`.

**Without VoRD, every query fails.**
- No engine sends a contact: Comunica has no option to set `From` or to extend its User-Agent.
- So every request to an I member fails, and 403 is not retried.
- With I in the mix, A, B and B′ fail every `FM` run at the first I member they reach, usually within the first second. Nothing else about them is measured in `FM`.
- The single-factor profiles (§5.9) measure them on the other archetypes.

**With VoRD, the fork needed a small change** (§5.10, now made).
- The change: a context entry with the user's contact (`@comunica/bus-http:client-contact`), which the engine sends only to endpoints whose description requires it. Engines C and D get `vord-bench@example.org`.
- An end-to-end check on the VM confirms it, with the WatDiv `all` store behind the new proxy and 4 queries per profile:
  - under `archetype-identified-email` and `archetype-identified-agent`, A got 403 on every query;
  - D completed all of them, including paging through the 10,000-row cap (C3: 48,802 results).
- **This is also a privacy argument for VoRD.** Without a description, the only way to pass I is to send the contact to every endpoint. With one, it goes only where it is required. The harness counts these disclosures per run.

### 5.6 Adversarial archetypes

These are real mechanisms with harsh settings.
- **Each binds on most queries** (§5.7).
- **Each can be described with today's VoRD terms.**
- **The fork can already comply** with Z, L and E, and in part with G.

| Archetype | Mechanism and real basis | Restrictions | Engine that ignores it | VoRD engine (fork as it is) |
|---|---|---|---|---|
| **Z — zero tolerance** | A WAF or fail2ban rule that bans on the first violation. fail2ban's default ban is 10 minutes; DBpedia also bans temporarily | 10 requests per second. The first request over that bans the client for 10 min: 403, beyond the end of the run | Banned in every query except q09 and q11, after a median of 0.02–1 s (4.9 s in q06). The query fails | Paces below 10 per second, so it is never banned. This tests the fork's safety margin, because one violation is fatal |
| **L — tarpit** | Slow-down middleware (e.g. `express-slow-down`) and tarpits: excess requests are delayed instead of rejected | 100 requests per 10 s at full speed. Each further request in the window waits 100 ms × its excess, so the 50th extra request waits 5 s | No error at all, only growing delays, so retry and back-off logic never triggers. It slows q01, q02 and q04 at batch 1, and q03 and q04 at batch 0, by up to tens of seconds per request, which will likely end in timeouts | A rate restriction with `vord:ThrottleResponse`: it paces at 10 per second and is never delayed |
| **E — empties under pressure** | Virtuoso's anytime queries: under load, the time limit cuts the query, and the endpoint returns what it has (possibly nothing) with 200 and `X-SQL-State` | A request that arrives while 3 or more of the client's other requests are in flight gets an empty result: 200 + `X-SQL-State: S1TAT` | Silently wrong answers: 31–88% of the requests are emptied, in every query except q09 and q11 | A hard concurrency restriction of 3, with `vord:DegradeQuality` and `X-SQL-State` as signal header. The engine keeps at most 3 requests in flight, so no request arrives while 3 others are running |
| **G — shared budget** | A public endpoint whose limit is global (`vord:GlobalScope`) and shared with other users | 20 requests per second for everyone. Background tenants use a seeded random walk of 0–15 per second, redrawn every 5 s. 429 + `Retry-After: 1` | 429s and retries. B's three retries run out on the heavy queries | VoRD gives only the ceiling. D paces just below 20 per second, and still meets 429s when the background is high. This tests VoRD combined with adaptive back-off |

- **E must be marked hard** (`vord:hardRestriction true`), so that the fork applies it whatever its soft-restriction setting.
- **G's background is reproducible.** It is seeded per member and per profile seed, and starts at each run's first request, so every engine faces the same background.
- **Same rate, different penalties.** R, I and Z all allow 10 requests per second, but they punish differently:
  - R delays and then returns 503;
  - I returns 429;
  - Z bans.

  So only the description, not the rate, tells an engine how careful it must be.
- **Considered and left out:**
  - *Tiny result pages.* Comunica's FedShop responses are bimodal (§5.7). Every cap between 10 and 1,000 rows truncates the same requests, in q03 and q08 only, so smaller pages add nothing.
  - *Limits on query length or shape*, such as 414 for long GET requests or a maximum number of `VALUES` rows. VoRD cannot describe them, so no engine could avoid them.

### 5.7 Calibration against the workload

**Per-member request demand** at batch 0, engine A, P0 (maxima over members):

| Query | Result | Requests per member | Peak per 1 s | Peak per 6 s | Peak in flight |
|---|---|---|---|---|---|
| q01 | ok, 3.0 s | 75 | 46 | 76 | 28 |
| q02 | ok, 3.3 s | 107 | 66 | 107 | 16 |
| q03 | 502 before the retry fix (D: ok, 5.7 s, 167 per member) | 81 | 36 | 81 | 12 |
| q04 | ok, 8.8 s | 413 | 113 | 354 | 55 |
| q05 | timeout (120 s) | 16 | 15 | 16 | 14 |
| q06 | ok, 2.9 s | 12 | 8 | 12 | 4 |
| q07 | ok, 5.1 s | 41 | 19 | 39 | 17 |
| q08 | ok, 7.9 s | 28 | 10 | 18 | 11 |
| q09 | ok, 0.7 s | 3 | 3 | 3 | 2 |
| q10 | error (empty `VALUES`) | 23 | 23 | 23 | 7 |
| q11 | ok, 0.8 s | 5 | 5 | 5 | 3 |
| q12 | ok, 1.6 s | 41 | 41 | 41 | 10 |

For q01–q06, the median member is within a few requests of the maximum. For q07, q08, q10 and q12, the median member gets 65–85% of the maximum.

**At batch 4** (engine D, 120 s):
- Demand per member rises to 372 (q01) and 409 (q02), and to 510–784 or more in the queries that time out.
- Up to 104 requests are in flight to one member (q04).
- The engine process reaches up to 2.9 GB.

**Truncation exposure.** We replayed every distinct request of D's batch-0 runs (14,574) against Virtuoso and counted the rows:

| Query | Largest response | Requests over 1,000 rows (members) | over 5,000 | over 10,000 |
|---|---|---|---|---|
| q03 | 6,329 | 28 (14) | 4 (2) | 0 |
| q08 | 6,538 | 44 (9) | 8 (2) | 0 |
| q05 (dropped) | 32,591 | 48 (20) | 24 (20) | 14 (14) |
| the other 9 | ≤ 10 | 0 | 0 | 0 |

**Response sizes are bimodal.**
- Comunica starts from selective constants and bind-joins, so almost all of its requests return at most 10 rows.
- The exceptions are q03 and q08, whose large responses all exceed 250 rows.
- So:
  - the common 10,000-row cap truncates *nothing* in the kept queries;
  - only the lower real caps (500–5,000 rows, 6 of the 68 capped endpoints) bite, and only in q03 and q08;
  - capped members draw their cap from the measured distribution, and `F1-cap` uses 1,000 rows;
  - truncation is a secondary threat in FedShop. The main threats are the limits on rate, concurrency, cost and identity.

**Each archetype on the pilots' traffic.** The proxy logs every request with its member, start time, duration, rows and query. We replayed the per-member trace of each P0 run of engine D through a simulation of each archetype (`archetype_calib.py` on the VM, 20 November 2026).
- Under P0, an engine sends the requests it would send if it ignored every restriction. So:
  - **"rejected", "banned", "slowed" and "emptied"** show how hard an archetype hits an engine that ignores it;
  - **"paced ≥"** is a lower bound on the run time of an engine that paces each member perfectly (the maximum over members).
- Rows are batch 1, except q03 (dropped at batch 1) and q08 (no completed batch-1 run), which are batch 0.

| Query | Requests per member (COUNTs) | T: cost per member | T: members rejecting, paced ≥ | 10 per s (R, Z, I): paced ≥ | R: rejected | Z: members banned (median time) | L: requests slowed | E: share emptied (non-empty answers lost) | G: rejected |
|---|---|---|---|---|---|---|---|---|---|
| q01 | 150 (98) | 248 | 0, 5 s | 15 s | 1,962 | 40 (1.0 s) | 1,718 | 62% (2,731) | 2,774 |
| q02 | 297 (131) | 428 | 40, 23 s | 30 s | 6,253 | 40 (0.04 s) | 7,773 | 77% (4,422) | 6,980 |
| q04 | 965 (717) | 1,682 | 40, 148 s | 97 s | 19,362 | 40 (0.02 s) | 33,340 | 88% (27,634) | 23,644 |
| q06 | 24 (13) | 37 | 0, 0 s | 2 s | 0 | 40 (4.9 s) | 0 | 58% (264) | 192 |
| q07 | 52 (33) | 85 | 0, 0 s | 5 s | 186 | 40 (0.02 s) | 0 | 39% (593) | 790 |
| q09 | 3 (2) | 5 | 0, 0 s | 0.3 s | 0 | 0 | 0 | 0% | 0 |
| q11 | 5 (4) | 9 | 0, 0 s | 0.5 s | 0 | 0 | 0 | 0% | 0 |
| q12 | 61 (35) | 96 | 0, 0 s | 6 s | 425 | 40 (0.6 s) | 0 | 77% (954) | 1,076 |
| q03 (batch 0) | 167 (86) | 379 | 20, 18 s | 17 s | 1,945 | 20 (0.02 s) | 1,325 | 31% (727) | 2,373 |
| q08 (batch 0) | 28 (17) | 336 | 4, 14 s | 3 s | 0 | 20 (0.02 s) | 0 | 43% (159) | 68 |

- **What binds where:**
  - Z, E and G bind on every query except q09 and q11.
  - R, and the rate limit of I, bind on q01–q04, q07 and q12.
  - T and L bind on the heavy queries (q02 and q04, plus q01 for L, plus q03 and q08 for T).
  - W (5 in flight) and U (about 30 per second) bind as before: up to 55 in flight and 113 per second per member at batch 0.
- **q09 and q11 are controls.** At most 5 requests per member reach each member, so they pass every archetype except I.
- **Feasibility.** The tightest pair is q04 at batch 1:
  - under T, it needs at least 148 s;
  - at 10 per second, at least 97 s.

  Both are within the 300 s timeout. But planning overhead and dependencies between requests could push a paced run over it, so the pilot checks this first (§9, step 7).
- **These figures come from replaying unpaced traces.** A throttled engine changes its own timing, so they show where an archetype binds and how hard. They do not predict run times.

**No time compression.** Every limit that binds is per second or per number in flight; only W's error budget is per minute, and T's bucket refills per second. So the mix runs in real time. (WatDiv's P profiles needed 10× compression because they are synthetic per-minute policies.)

### 5.8 Sources of variance

| Variance | Built in by | What breaks without VoRD |
|---|---|---|
| **Between members** | 13 archetypes, two to four per block of 20 | One back-off or page size cannot fit all members |
| **With member size** | In q03 and q08, some members return 1,000–6,500 rows and others far fewer. A low cap truncates 14 or 9 of the 20 members in those queries | Some members' answers are silently incomplete, depending on the query and the member |
| **With the query** | Demand per member ranges from 1–5 requests (q09, q11) to about 965 (q04) at batch 1 | Rate, cost and concurrency limits bind on heavy queries only |
| **Over time** | Burst allowances; T's refilling bucket; W's error budget per minute, and the ban after it; G's background | Short queries pass, and long ones are throttled midway. Engines that keep retrying get banned |
| **In what a request costs** | T charges by request kind and result size; the others count requests | A request-rate limiter (B's, or a VoRD rate) misjudges T: COUNT-heavy phases and large results cost more |
| **In what the client must disclose** | I requires a contact, in `From` or in the User-Agent, depending on the member | Without a description, the engine either fails or must send its contact to every member |
| **In the penalty** | R, I and Z all allow 10 per second, but R delays and then returns 503, I returns 429, and Z bans | Back-off tuned for 429 is useless against a ban, and at Z the first violation is fatal |
| **In how failures are signalled** | Silent truncation; partial (empty) results with 200 and `X-SQL-State`; 429 with and without `Retry-After`; 503 without it (R); 403 bans (W, V, Z) and rejections (I); 504 from a CDN | Silent failures give wrong answers instead of errors, and retry logic keyed on 429 misses the rest |
| **Whether anything is signalled at all** | L only slows down. E answers 200 with an empty result | No error ever appears, so back-off never starts, and answers are silently wrong |
| **With other users' load** | G's budget is shared with seeded background tenants | Even a VoRD engine meets 429s: it needs VoRD plus adaptive back-off |
| **In what is advertised** | Only some members advertise. The rest are served at `/none/sparql` and still enforce their restrictions; the harness chooses the path per member | C and D must cope with partial knowledge. Provided restrictions can fill the gaps (RQ4) |

### 5.9 Profiles of the suite

The profiles are suite-agnostic files in [profiles/](profiles/README.md). The Status column says what exists now.

| Profile | Content | Purpose | Status |
|---|---|---|---|
| `F0-none` | No restrictions | Baseline; validity check 1 (all engines equally complete) | `P0-none` serves |
| `F1-cap` | Every member truncates silently at 1,000 rows | Truncation alone, varying with member size | To do (a uniform profile) |
| `F2-rate` | Every member has U's burst limit (about 30 per second, 429 + `Retry-After: 10`) and W's 5 in flight | Rate and concurrency limits alone, as the number of members grows | To do (a uniform profile) |
| `F3-<archetype>` | Every member has the same archetype | Each new archetype alone. This shows how A, B and D fail on it, without I or Z ending the query first | Done: `archetype-<id>`, for all 14 archetypes |
| `FM-S1`, `FM-S2`, `FM-S3` | The mix of §5.2, assigned with seeds 1–3, all advertised | Main condition (RQ1, RQ2) | Done: `restrictive`, `restrictive-s2`, `restrictive-s3` |
| `FM-S1-partial` | Mix S1, with only half of the members advertising | Partial knowledge. C and D also run here with the missing restrictions provided (RQ4) | To do: an advertised share for mixes |
| `FM-simple` (optional) | The documented-policy archetypes only, 10% open | A milder, realistic condition, and how much the conclusions depend on the shares | Done: `simple`, `simple-s2`, `simple-s3` |

**Assignment.** The mixes are assigned by [proxy/lib/archetypes.mjs](proxy/lib/archetypes.mjs) in blocks of 20, as §5.2 describes. The FedShop endpoints file must therefore:
- list the members in batch order: vendors 0–9, rating sites 0–9, vendors 10–19, and so on;
- give each member its `group` (`vendor` or `ratingsite`).

The proxy reports the assignment at `GET <admin>/assignment?profile=<id>`.

**Failure attribution** (to do). For each failed or incomplete run, the harness names the first member, and its archetype, that did one of the following:
- returned a fatal status (403; 429 or 503 after the last retry; 504);
- returned an empty or partial answer.

Without this, `FM` would show only that A and B fail, not why.

### 5.10 What the proxy, VoRD and the fork need

**The proxy before this work had:**
- per-member profiles;
- rate, burst, concurrency, result-size, timeout and quota emulation, with any status code;
- description modes in the path;
- the safety layer;
- record and replay.

**New in the proxy, done** (tested on the VM, uncommitted in vord-bench):
- **Rate limits per restriction:** each rate restriction has its own enforcement:
  - reject;
  - queue, with a queue limit beyond which requests get 503 without `Retry-After` (R, V);
  - tarpit delays (L);
  - seeded background tenants (G).
- **Bans:** after repeated violations (W), or after the first one (Z), via `penaltyThreshold` and `penaltyDuration`.
- **Identification checks** on `From` or the User-Agent (I):
  - a ban on switching identity;
  - a service description that needs no identification.
- **A cost-unit token bucket (T):**
  - charges on arrival and on completion;
  - reports the `X-RateLimit-*` headers on every response.
- **Empty partial answers** with the signal header (E, and O, V and C after their anytime timeout):
  - above a concurrency threshold;
  - after an anytime timeout.
- **Truncation** can be silent or carry `X-SPARQL-MaxRows`.
- **Result caps** are drawn per endpoint.
- **Archetype mixes** are resolved per suite.

**New in the proxy, still to do** (§9, step 3):
- the socket retry;
- compact logs;
- the warm cache;
- latency per member;
- optionally, a service-time model.

**The VoRD vocabulary, done** in 0.3 ([ecrum19/vord#4](https://github.com/ecrum19/vord/pull/4)). It also updates the SHACL and ShEx shapes, the tests, a strict-endpoints example, and the ReSpec usage specification.

| Terms | For |
|---|---|
| `vord:IdentificationRestriction`, `vord:identificationHeader`, `vord:identificationFormat` (`vord:EmailAddress`, `vord:ProductWithContact`) | I |
| `vord:costUnitsPerWindow`; `vord:burstValue` now allowed on any restriction | T |
| `vord:penaltyThreshold`, `vord:penaltyDuration` | Z, W |
| `vord:concurrentRequests` | W, E |

The service descriptions that the proxy generates for all 13 restricted archetypes conform to its SHACL shapes.

**The fork, done** in a local commit on `feature/vord-restrictions`, not pushed. It was checked on the VM: build, lint, type check, and the full jest suite (8,370 tests, 100% coverage), including two new end-to-end engine tests.

| Change | For |
|---|---|
| A `@comunica/bus-http:client-contact` context entry. The limit actor sends it in the required header (`From`, or appended to the User-Agent) only to endpoints that require it; the extractor and provided restrictions read the new terms | I |
| Pacing on usage budgets: each request reserves one unit; the remaining budget reported in the signal header, or a 429, corrects the estimate; the budget's status code is retried | T |
| Status codes of restrictions with `penaltyThreshold` 1 are not retried | Z |
| Partial results after a timeout with a success status; processing-time budgets (existing gaps) | O, V, W: not planned. They rarely trigger here, and are reported separately if they do (PLAN.md) |

## 6. Ground truth

- **FedShop's reference.** `results.csv` exists per instance and batch, but it lacks term types. It can check counts only.
- **Virtuoso with one `FROM` per member does not scale.** q02 takes 3 s at 20 members and 35 s at 60, and had not finished after 10 minutes at 100.
- **Recommended:**
  - load each batch's union into one Oxigraph store (as for WatDiv's `all` store) and compute the answers there;
  - check every count against `results.csv`.
  - Batches 0 and 1 need about 0.3 and 0.6 GB of store (75 bytes per triple, measured on the WatDiv store).
- **Ties.** Every instance-0 answer is shorter than its `LIMIT`. Only q04 uses `OFFSET 5` under `ORDER BY ?label`, so its comparison accepts any valid result (tie-aware).

## 7. Campaign size and duration

**Runs per batch**, with Q kept queries (Q = 11 for batch 0, 10 for batch 1):

| Profiles | Engines | Repetitions | Runs |
|---|---|---|---|
| `F0`, `F1`, `F2` | A, B, B′, C, D | 3 | 45 Q |
| `F3-T` … `F3-G` (7 archetypes alone) | A, B, D | 1 | 21 Q |
| `FM-S1`–`S3` | A, B, B′, C, D | 1 per seed | 15 Q |
| `FM-S1-partial` | A, B, B′, C, D, plus C and D with provided restrictions | 1 | 7 Q |
| **Total** | | | **88 Q** |
| `FM-simple` (optional) | A, B, B′, C, D | 1 | 5 Q |

Batch 0 gives 968 runs and batch 1 gives 880, so **1,848 runs** in total, plus the warm-up pass and the cache validity check. The optional `FM-simple` adds 105 runs.

**Duration** (estimated; the pilot measures it):
- **Batch 0:** F0 runs take about 4 s, and restricted runs perhaps 20 s. That is about 5.5 hours.
- **Batch 1:** F0 runs take about 10 s (D: 1–45 s per query). Restricted runs average perhaps 60 s, for three reasons:
  - D paces: q04 needs at least 148 s under T and 97 s at 10 requests per second (§5.7).
  - B, by the WatDiv experience, often reaches the 300 s timeout, and L's delays push it there too.
  - On the other hand, A and B fail within seconds at I and Z members.

  That is about 15 hours.
- **About 20 hours in total**, plus warm-up and reruns: 2–3 days of VM time.
- Batch 4 would take several days, with runs of minutes each.

**Logs.** About 7 million requests in total, mostly batch 1 at about 7,000 per run.
- At today's 550 bytes per entry, that is about 4 GB.
- With compact entries (about 120 bytes) and gzip, it is well under 1 GB.

## 8. Hardware and space

Measured on the SLICES VM: 4 vCPUs (Xeon Silver 4309Y), 15.6 GB RAM without swap, 95 GB disk.

**Disk, for batches 0 and 1**

| Item | Size |
|---|---|
| Virtuoso DB (all 200 members) and image | 2.4 GB + 0.1 GB |
| `fedshop_dataset.zip`, only while building the ground-truth stores | 2.1 GB (removable afterwards) |
| Oxigraph ground-truth stores, batches 0 and 1 | about 0.9 GB |
| Warm cache | about 0.5 GB (estimated) |
| Proxy logs (compact, gzipped) | under 1 GB |
| **Peak** | **about 7 GB** (about 5 GB after removing the zip) |

**Memory**

| Process | Measured |
|---|---|
| Virtuoso (8 GB buffer setting) | 3.7–4.3 GiB |
| Comunica, one query per process | 0.5–1.3 GB on completing queries; up to 2.9 GB on queries that time out at batch 4 |
| vord-proxy, 200 members | 116–412 MB |
| **Total** | **about 8 GB of 15.6 GB.** Keep `--max-old-space-size` at 4 GB per query process, because there is no swap. |

**CPU — the real limit.**
- During a batch-4 run, Comunica used 1.3 cores (single-threaded JavaScript plus GC), Virtuoso 0.9 and the proxy 0.3.
- The store is the problem, not the average load: one 4-vCPU store cannot answer many members' COUNT bursts within Comunica's 3 s limit (§4.2).
- With the warm cache, batches 0 and 1 fit on this VM.
- Batch 4 needs about 16 or more cores, so that both the store (on misses) and the engine keep up, and about 32 GB of RAM, with a larger engine heap for 300 s runs. That points to a Virtual Wall node, or a larger SLICES flavour.

**State of the VM (20 November 2026)**
- `~/fedshop-probe` holds 13 GB: the downloads, a working copy of the DB, the unpacked archives (4.3 GB, removable) and the pilot logs (1.5 GB).
- The `fedshop-virtuoso` container is running (about 4 GB of RAM).
- Docker's build cache holds 32.7 GB that could be reclaimed; that is your call.
- **The VM expires on 12 December 2026.** Batches 0 and 1 need about two more weeks: the rest of the implementation (the archetypes and the fork changes are done), the pilot and the campaign.

## 9. Implementation steps

Phase 3 of PLAN-SUITES, made concrete. Each step comes with unit tests and is checked on the VM.

1. **Provisioning** (`suites/fedshop/setup.sh`, `docker-compose.yml`)
   - Download the pinned files and check their MD5s.
   - Run Virtuoso with the settings of §4.1, written to `virtuoso.ini`.
   - Record the image digest.
2. **Endpoints file**, generated: 200 members on fixed ports with their `defaultGraph`, on one upstream with the safety cap (16).
3. **Proxy changes**
   - a. Retry once after an upstream socket error, and log the retry.
   - b. Compact logs: a query hash in each entry, the query texts once per run, and gzip.
   - c. The warm cache (§4.2): replay with modeled latency, a store that holds millions of entries, warm-up and COUNT prefill tools, and hit and miss counts per run.
   - d. Latency per member.
   - e. **Done.** A ban after repeated violations (W) or after the first one (Z), reset with each run. V has none, because DBpedia does not publish its rule.
   - f. Optional: a service-time model, so that timeouts can bind.
   - g. **Done.** Empty partial answers with 200 and `X-SQL-State` after an anytime timeout; `X-SPARQL-MaxRows` on truncated responses, unless the truncation is silent.
   - h. Only if decided (§10): a logged rewrite that removes empty `VALUES( ){ ( ) }` blocks.
   - i–n. **Done:**
     - i. T: a cost-unit token bucket and the `X-RateLimit-*` headers;
     - j. I: identity checks;
     - k. R: a queue limit with 503;
     - l. L: tarpit delays;
     - m. E: empty answers above a concurrency threshold;
     - n. G: seeded background tenants.
4. **VoRD and the fork**
   - a. **Done, in review:** VoRD 0.3 with shapes, tests, an example and the specification ([ecrum19/vord#4](https://github.com/ecrum19/vord/pull/4)).
   - b–c. **Done:** the fork's identification and usage-budget support (§5.10).
   - d. **Done:** checks on the VM. **To do:** push to `feature/vord-restrictions`.
5. **Harness**
   - A `fedshop` query reader (BOM, CRLF, instance selection, dropped templates).
   - A `batch` source strategy.
   - The description mode per member.
   - Ground truth from Oxigraph union stores, checked against `results.csv`, with a tie-aware q04.
   - Failure attribution: the first member, and its archetype, that returned a fatal status or an empty or partial answer (§5.9).
   - Per run, the number of members that received the contact, and how many of them required it (I).
6. **Profiles: done, suite-agnostic.** There is no FedShop-specific generator; any suite can use these:
   - `profiles/archetypes/*.json`: the archetypes, with their values and sources;
   - `simple.json` and `restrictive.json`: the mixes, with their shares and seeds;
   - [proxy/lib/archetypes.mjs](proxy/lib/archetypes.mjs): resolves the mixes and the per-endpoint caps for the suite's endpoints file. The proxy and the harness both use it.
   - The FedShop endpoints file only needs to list the members in batch order, with their groups (§5.9).
7. **Pilot**
   - a. With the cache warm, check plan stability (§4.2): every engine, every kept query, 3 times under F0, request counts within 5%.
   - b. Under F0, every `F3` profile and FM-S1, with engines B and D: check that every archetype binds where §5.7 predicts, and that D can finish each query. q04 at batch 1 under T and Z is the tightest case.
   - c. Measure the duration per run. Values are adjusted once, then frozen.
8. **Campaign**, as in §7: batch 0 first, then batch 1.

## 10. Decisions for you

| # | Decision | Recommendation | Alternative |
|---|---|---|---|
| 1 | FedShop version | The latest record, 12204740 (on the VM, MD5s checked) | v1 (7919872), as cited in PLAN-SUITES |
| 2 | Federation sizes | Batch 1 (40 members) as the main federation, plus batch 0 (20); batch 4 later, on bigger hardware | Batch 4 now, accepting that only 6 of 11 queries run and that Virtual Wall is needed |
| 3 | Time compression | None, because the realistic limits act in real time | 10×, as for WatDiv |
| 4 | q10 (Virtuoso rejects Comunica's empty `VALUES`) | A logged rewrite in the proxy, and a bug report to Comunica or OpenLink | Drop q10 |
| 5 | Keeping the store's load out of the plans (§4.2) | The warm cache with modeled latency | A longer COUNT timeout in all engines, or more CPU |
| 6 | Archetype shares (§5.2): 5% open; 10% each for O, W, U, R, T, I and E; 5% each for V, C, Z, L and G | **Implemented** as `restrictive`, with `simple` (documented policies only, 10% open) as the milder mix | Your own shares. For example, force a low cap on one O member per block, so that O binds more often than the real 9% of low caps allows |
| 7 | Members that advertise in `FM-S1-partial` | Half | Another share, or a sweep |
| 8 | Hosting | The SLICES VM for batches 0–1, extended beyond 12 December 2026; Virtual Wall for batch 4 | Everything on Virtual Wall |
| 9 | Clean-up on the VM | Remove the unpacked archives (4.3 GB) once this design is accepted, and the pilot logs once the archetype values are frozen; the Docker build cache (32.7 GB) is your call | Keep everything |
| 10 | Identification in VoRD (§5.5) | **Done, in review:** `vord:IdentificationRestriction`, `vord:identificationHeader` and `vord:identificationFormat` ([ecrum19/vord#4](https://github.com/ecrum19/vord/pull/4)) | Describe I only in prose (`rdfs:comment`), and treat it as a restriction no engine can read |
| 11 | Fork changes for I (small) and T (medium) (§5.10) | **Done** in a local commit, checked on the VM. Push to `feature/vord-restrictions` when you approve | Run them without the changes, and report them as gaps of the fork. Then C and D also fail every `FM` run at I members, so I would have to stay out of `FM` |
| 12 | How engines without VoRD meet I | **Implemented:** without a contact, as Comunica today, so they fail at I members; failure attribution and the `archetype-*` profiles show the rest | Give every engine the contact out of band. A and B then send it to every member, and I measures disclosures instead of failures |
| 13 | Single-factor profiles for the new archetypes (`F3`, 21 Q per batch) | The profiles exist (`archetype-<id>`). Run them with A, B and D, once each | Rely on failure attribution in `FM` only (saves about 440 runs) |

## 11. Progress

**20 November 2026: restriction profiles, VoRD 0.3 and fork support**

| Piece | Where | State |
|---|---|---|
| 14 archetypes; `simple` and `restrictive` mixes with seeds 1–3; `archetype-<id>` profiles; documentation | vord-bench [profiles/](profiles/README.md) | Uncommitted |
| Proxy emulation for the archetypes (§5.10), mix resolution, `/assignment`, the client contact for engines C and D | vord-bench `proxy/`, `harness/run.mjs`, `engines/engines.json` | Uncommitted; 142 tests pass on the VM |
| VoRD 0.3: identification, usage budgets, penalties, the `concurrentRequests` metric | [ecrum19/vord#4](https://github.com/ecrum19/vord/pull/4) | In review. 14 tests pass, and `ocg:check` and `ocg:build` succeed, on the VM |
| Fork: identification, usage-budget pacing, no retries for zero-tolerance bans | `feature/vord-restrictions`, local commit 3c44d5a413 | Not pushed. Build, lint, types and the full jest suite pass on the VM |

**Checks on the VM:**
- **Shapes:** the proxy's service descriptions for the 13 restricted archetypes conform to the VoRD 0.3 SHACL shapes.
- **End to end:** the new proxy ran in front of the WatDiv `all` store, with engines compiled from the fork, single scenario and 4 queries:
  - **Identification:** A got 403 on every query under both identification archetypes, and D completed them all.
  - **The other archetypes:** they hardly bind with a single endpoint, which gets one or two requests per query. The federated FedShop pilot (§9, step 7) is where they are meant to bind.

**Next:**
- the rest of §9: steps 1, 2, 3a–d, 5 and 7;
- the uniform `F1-cap` and `F2-rate` profiles;
- an advertised share for `FM-S1-partial`.
