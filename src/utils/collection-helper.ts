/**
 * Use as compareFn in sort
 */
export const sorter = <T, U extends number | string>(
  toOrdered: (t: T) => U,
  order: "asc" | "desc" = "asc"
) => {
  return (a: T, b: T) =>
    order === "asc"
      ? toOrdered(a) > toOrdered(b)
        ? 1
        : toOrdered(b) > toOrdered(a)
        ? -1
        : 0
      : toOrdered(a) < toOrdered(b)
      ? 1
      : toOrdered(b) < toOrdered(a)
      ? -1
      : 0;
};

export const groupBy = <T>(
  values: T[],
  toKey: (t: T) => string
): { [key: string]: T[] } =>
  values.reduce(
    (prev, cur, _1, _2, k = toKey(cur)) => (
      (prev[k] || (prev[k] = [])).push(cur), prev
    ),
    {} as { [key: string]: T[] }
  );

export const keyBy = <T>(
  values: T[],
  toKey: (t: T) => string
): { [key: string]: T } =>
  values.reduce(
    (prev, cur, _1, _2, k = toKey(cur)) => ((prev[k] = cur), prev),
    {} as { [key: string]: T }
  );

export const count = (values: string[]): { [value: string]: number } => {
  const ret: { [value: string]: number } = {};
  for (const value of values) {
    if (ret[value]) {
      ret[value]++;
    } else {
      ret[value] = 1;
    }
  }
  return ret;
};

export function flatten<T>(matrix: T[][]): T[] {
  return matrix.reduce((a, c) => [...a, ...c], []);
}

export function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function uniqFlatMap<T, U>(values: T[], mapper: (x: T) => U[]): U[] {
  return uniq(flatten(values.map(mapper)));
}

export function intersection<T>(matrix: T[][]): T[] {
  return matrix.length === 0
    ? []
    : matrix.reduce((acc, xs) => acc.filter((x) => xs.includes(x)));
}

export function intersectionMap<T, U>(values: T[], mapper: (x: T) => U[]): U[] {
  return intersection(values.map(mapper));
}

export const minBy = <T>(collection: T[], toNum: (t: T) => number) => {
  const select = (a: T, b: T) => (toNum(a) <= toNum(b) ? a : b);
  return collection.reduce(select);
};

export function includeItems<T>(
  items: T[],
  patterns: string[],
  toPath: (t: T) => string
): T[] {
  return patterns.length === 0
    ? items
    : items.filter((x: T) => patterns.some((p) => toPath(x).startsWith(p)));
}

export function excludeItems<T>(
  items: T[],
  patterns: string[],
  toPath: (t: T) => string
): T[] {
  return patterns.length === 0
    ? items
    : items.filter((x: T) => !patterns.some((p) => toPath(x).startsWith(p)));
}

export function mirrorMap<T>(
  collection: T[],
  toValue: (t: T) => string
): { [key: string]: string } {
  return collection.reduce((p, c) => ({ ...p, [toValue(c)]: toValue(c) }), {});
}
