const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?$/;

export function parseDuration(input: string): number {
  const match = DURATION.exec(input);
  if (!input || !match) {
    throw new RangeError(`Invalid duration: "${input}"`);
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  return hours * 3600 + minutes * 60;
}
