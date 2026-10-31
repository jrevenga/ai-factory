const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(v: string): [number, number, number] {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`invalid semver: ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}

/** Supports only `>=x.y.z <x.y.z`; any other range throws. */
export function satisfies(version: string, range: string): boolean {
  const m = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range);
  if (!m) throw new Error(`unsupported semver range: ${JSON.stringify(range)} (only ">=x.y.z <x.y.z")`);
  return compareSemver(version, m[1]!) >= 0 && compareSemver(version, m[2]!) < 0;
}
