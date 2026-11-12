const PATTERN = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u;

/**
 * Convert a positive xsd:duration (such as "PT1M") into milliseconds.
 * Years and months are approximated as 365 and 30 days, as in Comunica's VoRD extractor.
 * Numbers are taken to be milliseconds already.
 * @param {string | number | undefined} value
 * @returns {number | undefined} The duration in milliseconds, or undefined if invalid or not positive.
 */
export function durationToMs(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'number') {
    return value > 0 ? value : undefined;
  }
  const match = PATTERN.exec(value);
  if (!match || value === 'P' || value.endsWith('T')) {
    return undefined;
  }
  const [ , years, months, days, hours, minutes, seconds ] = match.map(part => Number(part ?? 0));
  const totalDays = (years * 365) + (months * 30) + days;
  const totalSeconds = (((totalDays * 24) + hours) * 60 + minutes) * 60 + seconds;
  return totalSeconds > 0 ? totalSeconds * 1_000 : undefined;
}
