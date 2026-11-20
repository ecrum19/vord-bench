/**
 * Restriction archetypes and mixes: suite-agnostic restriction profiles.
 *
 * An archetype (profiles/archetypes/<id>.json) is a named set of restrictions, modelled on a real endpoint policy.
 * A mix profile assigns archetypes to the endpoints of whatever suite it is used with:
 *   { "id": "restrictive", "mix": { "blockSize": 20, "seed": 1, "shares": { "<archetype>": <count per block>, … } } }
 * The endpoints of the suite's endpoints file are taken in order and cut into blocks of blockSize. Each full block
 * holds every archetype exactly as often as its count says; a smaller block (a small suite, or the last block)
 * gets counts in proportion, by largest remainder. Within a block, endpoints with a `group` (such as vendor or
 * rating site) are interleaved, so that archetypes that occur twice per block go to two different groups.
 * The seed decides which endpoint gets which archetype; the same seed always gives the same assignment.
 *
 * Restrictions may draw a value per endpoint from a distribution (emulation.maxValueDistribution), so that, for
 * example, capped endpoints get the caps that real endpoints use, in their measured proportions.
 */

/**
 * A 32-bit FNV-1a hash of a string.
 * @param {string} text
 */
export function hashString(text) {
  let hash = 0x81_1C_9D_C5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash;
}

/**
 * A seeded pseudo-random generator (mulberry32) that returns numbers in [0, 1).
 * @param {...(string|number)} parts The parts of the seed.
 */
export function seededRandom(...parts) {
  let state = hashString(parts.join('|'));
  return () => {
    state = (state + 0x6D_2B_79_F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Shuffle a copy of a list (Fisher-Yates).
 * @param {any[]} list
 * @param {() => number} random
 */
export function shuffle(list, random) {
  const copy = [ ...list ];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ copy[i], copy[j] ] = [ copy[j], copy[i] ];
  }
  return copy;
}

/**
 * Divide n endpoints over archetypes in proportion to their counts per block, by largest remainder.
 * Ties between equal remainders are broken by the random generator.
 * @param {Record<string, number>} shares Counts per block of `blockSize` endpoints.
 * @param {number} blockSize
 * @param {number} n The number of endpoints to divide (at most blockSize).
 * @param {() => number} random
 * @returns {Record<string, number>}
 */
export function apportion(shares, blockSize, n, random) {
  const ids = Object.keys(shares);
  const quotas = Object.fromEntries(ids.map(id => [ id, shares[id] * n / blockSize ]));
  const counts = Object.fromEntries(ids.map(id => [ id, Math.floor(quotas[id]) ]));
  let left = n - Object.values(counts).reduce((a, b) => a + b, 0);
  const tieBreak = new Map(shuffle(ids, random).map((id, i) => [ id, i ]));
  const byRemainder = [ ...ids ].sort((a, b) =>
    (quotas[b] - counts[b]) - (quotas[a] - counts[a]) || tieBreak.get(a) - tieBreak.get(b));
  for (const id of byRemainder) {
    if (left <= 0) {
      break;
    }
    counts[id]++;
    left--;
  }
  return counts;
}

/**
 * Assign archetypes to endpoints, as described at the top of this module.
 * @param {{ blockSize?: number, shares: Record<string, number> }} mix
 * @param {{ name: string, group?: string }[]} endpoints In the order of the suite's endpoints file.
 * @param {number} seed
 * @returns {Record<string, string>} The archetype of every endpoint.
 */
export function assignArchetypes(mix, endpoints, seed) {
  const blockSize = mix.blockSize ?? 20;
  const assignment = {};
  for (let start = 0, block = 0; start < endpoints.length; start += blockSize, block++) {
    const members = endpoints.slice(start, start + blockSize);
    const counts = members.length === blockSize ?
      mix.shares :
      apportion(mix.shares, blockSize, members.length, seededRandom(seed, 'apportion', block));
    // Archetypes that occur several times come first, in pairs, so that interleaving spreads them over groups;
    // the order of archetypes with the same count is shuffled, so that the seed decides their groups too.
    const random = seededRandom(seed, 'order', block);
    const byCount = new Map();
    for (const [ id, count ] of Object.entries(counts)) {
      if (count > 0) {
        byCount.set(count, [ ...byCount.get(count) ?? [], id ]);
      }
    }
    const archetypes = [ ...byCount.keys() ].sort((a, b) => b - a)
      .flatMap(count => shuffle(byCount.get(count), random).flatMap(id => Array.from({ length: count }, () => id)));

    // Interleave the groups of the block, starting with a different group in every block.
    const groups = [ ...new Set(members.map(member => member.group ?? '')) ];
    const rotated = groups.map((_, i) => groups[(i + block) % groups.length]);
    const queues = rotated.map(group => shuffle(
      members.filter(member => (member.group ?? '') === group).map(member => member.name),
      seededRandom(seed, 'members', block, group),
    ));
    const ordered = [];
    while (queues.some(queue => queue.length > 0)) {
      for (const queue of queues) {
        if (queue.length > 0) {
          ordered.push(queue.shift());
        }
      }
    }
    ordered.forEach((name, i) => {
      assignment[name] = archetypes[i];
    });
  }
  return assignment;
}

/**
 * Draw a value from a weighted distribution, given as [ value, weight ] pairs.
 * @param {[number, number][]} distribution
 * @param {() => number} random
 */
export function drawWeighted(distribution, random) {
  const total = distribution.reduce((sum, [ , weight ]) => sum + weight, 0);
  let point = random() * total;
  for (const [ value, weight ] of distribution) {
    point -= weight;
    if (point < 0) {
      return value;
    }
  }
  return distribution.at(-1)[0];
}

/**
 * Give an endpoint its own copy of a list of restrictions, with the values that are drawn per endpoint.
 * @param {object[]} restrictions
 * @param {string} endpointName
 * @param {number} seed
 */
export function materialize(restrictions, endpointName, seed) {
  return restrictions.map(restriction => {
    const distribution = restriction.emulation?.maxValueDistribution;
    if (!distribution) {
      return restriction;
    }
    return { ...restriction, maxValue: drawWeighted(distribution, seededRandom(seed, endpointName, restriction.id)) };
  });
}

/**
 * Whether the restrictions of a profile depend on the endpoints of the suite: mixes, and profiles with drawn values.
 * @param {object} profile
 */
export function needsEndpoints(profile) {
  return Boolean(profile.mix) || (profile.restrictions ?? [])
    .some(restriction => restriction.emulation?.maxValueDistribution);
}

/**
 * Resolve the profiles that depend on the suite's endpoints into per-endpoint profiles.
 * A resolved mix profile has `endpoints` (the restrictions of every endpoint) and `assignment` (its archetype).
 * @param {Map<string, object>} profiles
 * @param {{ name: string, group?: string }[]} endpoints In the order of the suite's endpoints file.
 * @returns {Map<string, object>}
 */
export function resolveProfiles(profiles, endpoints) {
  const resolved = new Map();
  for (const [ id, profile ] of profiles) {
    if (!needsEndpoints(profile)) {
      resolved.set(id, profile);
      continue;
    }
    const seed = profile.mix?.seed ?? profile.seed ?? 1;
    if (profile.mix) {
      const assignment = assignArchetypes(profile.mix, endpoints, seed);
      resolved.set(id, {
        ...profile,
        assignment,
        endpoints: Object.fromEntries(endpoints.map(({ name }) =>
          [ name, materialize(profile.archetypes[assignment[name]].restrictions, name, seed) ])),
      });
    } else {
      resolved.set(id, {
        ...profile,
        restrictions: undefined,
        endpoints: Object.fromEntries(endpoints.map(({ name }) =>
          [ name, materialize(profile.restrictions, name, seed) ])),
      });
    }
  }
  return resolved;
}

/**
 * The endpoints of a suite's endpoints file (or a normalized proxy configuration), in order, with their groups.
 * @param {Record<string, { group?: string }>} endpoints
 */
export function endpointList(endpoints) {
  return Object.entries(endpoints).map(([ name, entry ]) => ({ name, group: entry.group }));
}
