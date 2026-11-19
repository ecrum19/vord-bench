# Planned changes

Changes to the Comunica fork ([`ecrum19/comunica@feature/vord-restrictions`](https://github.com/ecrum19/comunica/tree/feature/vord-restrictions)) that follow from the benchmark. They are planned only, not implemented. The evidence for each is in the [report](report/REPORT.md).
The planned extension of the benchmark itself is in [PLAN-SUITES.md](PLAN-SUITES.md).

## 1. Count the requests of nested operations in join planning (X7)

**Status:** planned, 16 November 2026.

### Problem

With restriction-aware planning, engine D needs far more requests than engine C for the challenge query X7, and times out on it under P1 and P6:

| Profile | C (requests, outcome) | D (requests, outcome) |
|---|---|---|
| P1 rate | 371, complete in 234 s | 420 by the 300 s timeout, half the results |
| P6 combined | 371, complete in 78 s | 1,256 by the 300 s timeout |
| P7 mixed | 371, complete in 234 s | 1,895, complete in 241 s |

X7 joins the 97 users of one country with a `UNION` of their likes and their purchases:

```sparql
?user sorg:nationality wsdbm:Country5 .
{ ?user wsdbm:likes ?product . }
UNION
{ ?user wsdbm:makesPurchase ?purchase . ?purchase wsdbm:purchaseFor ?product . }
```

C binds each user into the `UNION`, which takes a few requests per user. D instead uses a hash join, which evaluates the `UNION` without bindings. Its purchase branch then becomes a bind join over all 15,000 purchases, sent to the rate-limited offers endpoint in VALUES blocks of 8. That is about 1,875 requests (physical plans recorded under P1 on the VM, 16 November 2026).

### Cause

D's SPARQL sources report a request time of `windowDuration / maxValue` (600 ms under P1) in their metadata, so join planning weighs requests. Three gaps in Comunica's cost model then make the expensive plan look cheapest:

1. **A bind-source join charges its bound side one request, however many blocks it sends.** `actor-rdf-join-inner-multi-bind-source` estimates `requestTime = requestInitialTimes[0] + … + requestInitialTimes[1] + cardinalityRemaining × requestItemTimes[1]`. For the purchase branch that is 1.2 s, for about 1,875 requests.
2. **Join results carry no request time.** `ActorRdfJoin.constructResultMetadata` (`bus-rdf-join`) returns the state, cardinality and variables of a join, but not its estimated request time. `actor-rdf-metadata-accumulate-requesttime` then sums the request time of the `UNION`'s branches and counts the join branch as 0. The `UNION` therefore reports one request: 600 ms, for its `likes` pattern.
3. **Bind joins charge every binding the full request time of the remaining operations.** `actor-rdf-join-inner-multi-bind` uses the `requestTime` of the remaining entries per binding. This is right for a single pattern. For a nested operation, though, it is the cost of evaluating it without bindings, not with one.

Under P1 the planner thus compares a hash join of 0.6 + 0.6 = 1.2 s with a bind join of 0.6 + 97 × 0.6 ≈ 59 s, and picks the hash join. Engines without request times (A, B, Bp and C) are not affected: for them, all request times are 0.

Fixing gap 2 alone would make things worse. The `UNION` would then report its unbound cost, and gap 3 would charge that cost to every one of the 97 bindings, so the bind join would still lose.

### Planned changes

1. **Charge bind-source joins per block.** In `actor-rdf-join-inner-multi-bind-source`, charge the bound side `ceil(cardinality of the first entry / blockSize)` requests: `requestInitialTimes[1] × ceil(metadatas[0].cardinality.value / this.blockSize)`.
2. **Let join results report the request time of their plan.** In `bus-rdf-join`, add the chosen physical join's `requestTime` coefficient (from `getJoinCoefficients`, which `ActorRdfJoin.run` already computes for the plan logger) to the join's result metadata. Do this only when at least one entry reports a request time, so that engines without request times stay unchanged. Unions then sum it through the existing accumulate actor.
3. **Separate the cost of one bound evaluation.** Add an optional metadata entry with the request time of evaluating an operation once with a binding (working name: `requestTimeBound`):
   - Sources set it to their `requestTime`, which is one request.
   - Joins and unions set it to the sum over their entries, which is one request per pattern or source subquery. This needs an accumulate actor for unions.
   - The bind-join formulas use it for the remaining entries instead of `requestTime`, through a helper such as `ActorRdfJoin.getRequestBoundTimes(metadatas)`. That applies to `actor-rdf-join-inner-multi-bind` (`receiveInitialCostRemaining`) and `actor-rdf-join-optional-bind` (`requestInitialTimes[1]`).

### Expected effect on X7 under P1

| Plan | Estimated request time |
|---|---|
| Hash join | 0.6 s (users) + 0.6 s (likes) + 0.6 s + ⌈15,000 / 8⌉ × 0.6 s (purchases) ≈ 1,127 s |
| Bind join | 0.6 s + 97 × (0.6 s likes + 0.6 s makesPurchase + 0.6 s purchaseFor) ≈ 175 s |

D would choose the bind join, like C. That plan needs about 371 requests and completed in 234 s under P1 for C.

### Risks

- Other sources also report request times: Comunica measures them for hypermedia sources such as TPF/QPF and link traversal, together with a page size. Their join plans may change.
- The block-size correction (change 1) also applies to those sources.
- This is a change to Comunica's general cost model. It should be discussed with the Comunica maintainers before it goes into an upstream pull request, and could become a separate pull request from the VoRD feature.

### Validation

1. **Unit tests:** in `bus-rdf-join`, the changed join actors and the accumulate actors. Add a test with X7's shape in which the bind join wins.
2. **Comunica's own tests:** the full suite, including the integration tests of `engines/query-sparql`.
3. **Physical plan of X7:** recorded on the VM, under P1, for D (Comunica's physical plan logger).
4. **Re-run:** P1, P6 and P7, federated, for C and D, all 27 queries, 3 replications, on the VM.
5. **Done when:**
   - D completes X7 under P1 and P6 with about 371 requests;
   - no query loses completeness;
   - no query needs clearly more requests than in `full-2`.

## Other open items

These are described in section 6 of the [report](report/REPORT.md). They have no detailed plan yet:

- **Respect `Retry-After` for advertised status codes.** Adding `vord:returnsStatusCode` to the retry actor's status codes makes it retry 429 and 503 after the fixed fallback delay, skipping its `Retry-After` handling. Codes that the retry actor already handles should not be added.
- **Use `vord:retryAfterHint` even when the engine sets a fallback delay**, for the endpoints that advertise one.
- **Reduce the cost of the safety margin** for queries that just fit a rate limit (L1: 6.9 s instead of 0.3 s under P1).
- **Paging:** OFFSET pages re-evaluate the query, which is slow for large results (C3: 112 s) and does not help against evaluation time limits.
