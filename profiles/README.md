# Restriction profiles

A **profile** says which restrictions the [vord-proxy](../proxy/vord-proxy.mjs) emulates for each endpoint, and how it describes them with [VoRD](https://w3id.org/vord) (version 0.3) in the endpoint's service description. The profile is chosen per request, in the path: `http://localhost:<port>/<profile>/sparql`.

There are three kinds of profiles:

| Kind | Example | Applies to |
|---|---|---|
| **Uniform:** the same `restrictions` for every endpoint | `P1-rate` | Any suite |
| **Per endpoint:** `endpoints` lists restrictions per endpoint name | `P7-mixed` | Only the suite whose endpoint names it uses (WatDiv) |
| **Archetype mix:** `mix` assigns [archetypes](#archetypes) to the endpoints of whatever suite it runs with | `simple`, `restrictive` | Any suite |

The P0–P8 profiles belong to the WatDiv suite and compress time about 10× (see the [main README](../README.md#restriction-profiles)). The archetypes and mixes described here are **suite-agnostic** and run in **real time**: every limit that binds acts per second or on the number of requests in flight, so no compression is needed.

## The two default benchmark profiles

| Profile | What it is | Archetypes per block of 20 endpoints |
|---|---|---|
| **`simple`** | What popular public endpoints do: rate limits with bursts and queues, concurrency limits, result caps, timeouts | open 2, Virtuoso defaults 3, DBpedia 3, Wikidata 4, UniProt 4, CDN 1, nginx 3 |
| **`restrictive`** | Hard mode: every archetype, with only 5% of the endpoints open | open 1, Virtuoso defaults 2, DBpedia 1, Wikidata 2, UniProt 2, CDN 1, nginx 2, usage tokens 2, identified (email) 1, identified (User-Agent) 1, zero tolerance 1, tarpit 1, degrade under load 2, shared budget 1 |

- **Seeds.** Each mix exists with seeds 1, 2 and 3: `simple`, `simple-s2` and `simple-s3`, and the same for `restrictive`. The seed decides which endpoint gets which archetype, and draws per-endpoint values, such as the result caps of Virtuoso endpoints.
- **One archetype alone.** Every archetype is also a uniform profile, `archetype-<id>`, for example `archetype-zero-tolerance`. These show how an engine copes with one kind of restriction on every endpoint.
- **Every suite can use them.** The harness offers the mixes and the `archetype-*` profiles for every suite, whether or not the suite lists them: `node harness/run.mjs --suite <name> --profiles restrictive,archetype-tarpit`.

## How archetypes are assigned to endpoints

The proxy and the harness resolve a mix for the endpoints of the suite's endpoints file, in the same way, so they always agree:

1. **Blocks of 20.** The endpoints are taken in the order of the endpoints file and cut into blocks of `blockSize` (20). A full block holds every archetype exactly as often as its count says. So a suite whose federations are whole blocks (for FedShop: batch 0 = 20 endpoints, batch 1 = 40) has exactly the mix's shares, and an endpoint keeps its archetype as the federation grows.
2. **Smaller blocks** (a small suite, or a last partial block) get counts in proportion, by largest remainder, with seeded tie-breaking. WatDiv's 5 endpoints, for example, get 5 of the archetypes that occur twice per block. Suites with fewer than 20 endpoints therefore never see the rarest archetypes in a mix; use the `archetype-*` profiles for those.
3. **Groups.** If endpoints have a `group` in the endpoints file (such as `vendor` and `ratingsite`), each block interleaves the groups. Archetypes that occur twice per block then go to one endpoint of each group, and archetypes that occur once alternate between groups from block to block.
4. **Seeded.** The seed shuffles the endpoints within each group, and the order of archetypes with the same count. The same seed always gives the same assignment.

`GET <admin>/assignment?profile=<id>` returns the assignment that the proxy uses, for example to attribute failures to archetypes.

## Archetypes

Each archetype is a file in [`archetypes/`](archetypes/), with its sources (`basedOn`) and the date they were checked. The values follow documented policies or shipped defaults where these exist; the adversarial archetypes use real mechanisms with harsh settings.

| Archetype (code) | Restrictions | How it signals | Based on |
|---|---|---|---|
| `open` (S) | none | — | Fuseki, Oxigraph and GraphDB defaults |
| `virtuoso-default` (O) | Result cap drawn per endpoint from Buil-Aranda et al.'s measured caps (10,000 for 72%); 60 s anytime timeout | Silent truncation; empty partial answer with `X-SQL-State` | Virtuoso's shipped `virtuoso.ini`; ISWC 2013 measurement |
| `dbpedia` (V) | 10,000 rows; 120 s anytime; 50 in flight; 100 requests/s, 120 more queued | `X-SPARQL-MaxRows`; `X-SQL-State`; 503 | DBpedia fair-use policy |
| `wikidata` (W) | 60 s timeout; 5 in flight; 30 violations within a minute block the client for a minute | 500; 429 + `Retry-After` | WDQS user manual (the blocking rule is assumed) |
| `uniprot` (U) | 30 requests/s | 429 + `Retry-After: 10` | Measured on sparql.uniprot.org |
| `cdn-virtuoso` (C) | As `virtuoso-default`, behind a 30 s CDN timeout | As O, plus 504 | CloudFront's default origin response timeout |
| `nginx` (R) | 10 requests/s; up to 20 more are queued | 503 without `Retry-After` | NGINX's `limit_req` example |
| `usage-tokens` (T) | 600 cost units per minute, at most 200 at once; a request costs 1, +1 for an aggregate, +1 per full 100 rows | `X-RateLimit-*` on every response; 429 + `Retry-After` | OpenAlex, GitHub GraphQL, Shopify GraphQL |
| `identified-email` (I) | An email address in `From`; per user: 20 requests per 2 s, 10 in flight, 10,000 rows, 60 s | 403; switching identity blocks the client | RFC 9110; Wikimedia User-Agent policy |
| `identified-agent` (I) | A User-Agent with contact information; limits as above | 403 | Wikimedia User-Agent policy; Nominatim usage policy |
| `zero-tolerance` (Z) | 10 requests/s; the first violation blocks the client for 10 minutes | 403 | fail2ban's default ban time |
| `tarpit` (L) | 100 requests per 10 s; each request over that waits 100 ms per excess request | Delays only, no errors | Slow-down middleware (`express-slow-down`) |
| `degrade-under-load` (E) | With 3 requests in flight, further requests get an empty answer | 200 + `X-SQL-State: S1TAT` | Virtuoso's anytime queries |
| `shared-budget` (G) | 20 requests/s for all users; background tenants use 0–75% of it, a seeded random walk redrawn every 5 s | 429 + `Retry-After: 1` | `vord:GlobalScope` limits of shared endpoints |

**What binds on FedShop.** PLAN-FEDSHOP.md §5.7 simulates every archetype on the per-endpoint traffic of Comunica's pilot runs. All but the open, Virtuoso, CDN and DBpedia archetypes bind on most queries. The usage tokens bind on the heavy ones. All stay within a 300 s timeout for an engine that paces itself.

## Restriction format

Restrictions mirror the VoRD terms, which the proxy serializes into the service description:

| Field | VoRD property | Notes |
|---|---|---|
| `id` | the restriction's IRI fragment | URL-safe |
| `type` | `rdf:type` | `RateRestriction`, `QuotaRestriction`, `ResultSizeRestriction`, `CostModelRestriction`, `ServerLoadRestriction`, `ConcurrentRequestsRestriction`, `ResponseTimeRestriction`, `IdentificationRestriction` |
| `metric` | `vord:metric` | e.g. `requestsPerWindow`, `concurrentRequests`, `costUnitsPerWindow` |
| `maxValue`, `burstValue`, `minValue` | same | `burstValue` of a rate restriction: at most this many requests within `windowDuration × burstValue / maxValue`; of a usage budget: the units that can be spent at once |
| `windowDuration`, `retryAfterHint` | same | xsd:duration, e.g. `PT1S` |
| `unit`, `scope`, `enforcement`, `hardRestriction`, `returnsStatusCode` | same | Soft restrictions (`hardRestriction: false`) are described but not enforced |
| `httpSignalHeader` | `vord:httpSignalHeader` | A header name, such as `retry-after` |
| `penaltyThreshold`, `penaltyDuration` | same | Violations within `penaltyDuration` that block the client for `penaltyDuration`; blocked requests get `returnsStatusCode` (403 by default) |
| `identificationHeader`, `identificationFormat` | same | `from` or `user-agent`; `EmailAddress` or `ProductWithContact` |
| `costModel`, `costModelDescription` | `vord:costModel` | A local name is described next to the restriction, with `dcterms:description` |

`emulation` holds the parameters that the proxy needs but does not advertise:

| Restriction | Parameter | Effect |
|---|---|---|
| Rate or quota, `QueueRequest` | `queueLimit` | Requests beyond this many waiting ones are rejected with `returnsStatusCode`, without `Retry-After` |
| Rate, `ThrottleResponse` | `delayPerExcessMs` | Delay per request over the limit (a tarpit) |
| Rate | `background: { maxShare, stepMs }` | Background tenants use a varying share of the limit |
| Result size | `silent` | Truncate without `X-SPARQL-MaxRows` |
| Result size | `maxValueDistribution: [[value, weight], …]` | Draw the cap per endpoint |
| Usage budget | `cost: { base, aggregate, rowsPerUnit }` | The cost of a request on arrival, and of its results on completion |
| Concurrency or response time, `DegradeQuality` or `TruncateResult` | `degradedState` | The value of the signal header on empty partial answers (`S1TAT`) |

## What engines need

| Archetype | Without VoRD | VoRD engine (`feature/vord-restrictions`) |
|---|---|---|
| Rate, burst, queue, concurrency, result size, timeout (S, O, V, W, U, C, R) | Throttled, rejected or truncated | Paces, limits concurrency, pages |
| Zero tolerance (Z) | Blocked within the first second of most queries | Paces below the limit. Retrying a 403 is pointless, so it is not retried |
| Tarpit (L) | Delays only, and no error to react to | Paces below the limit |
| Degrade under load (E) | Silently empty answers | Limits its requests in flight |
| Shared budget (G) | 429s | Paces at the ceiling, and still needs retries when the background is high |
| Usage tokens (T) | 429 once the budget is spent | Paces on the remaining budget that the endpoint reports |
| Identified (I) | 403 on every request | Sends the `@comunica/bus-http:client-contact` context entry, only to endpoints that require it |

Engines C and D get a synthetic contact (`vord-bench@example.org`) in [engines.json](../engines/engines.json). Engines A, B and B′ have no way to send one, so they fail every query that reaches an identified endpoint.
