/**
 * A sorted copy of `items` — ES2023's `Array#toSorted`, written for ES2022.
 *
 * The plugin and the engine run inside Obsidian, where the renderer follows the
 * device's own WebView and can predate `toSorted` (iOS 16.4 / Chrome 110); desktop and
 * mobile share one bundle, so the shipped packages type-check against ES2022 and the
 * floor cannot be raised by accident. The input is never mutated — the copy is what
 * gets sorted.
 */
export function sortedCopy<T>(items: Iterable<T>, compare?: (a: T, b: T) => number): T[] {
  const copy = [...items];
  copy.sort(compare);
  return copy;
}

/** A reversed copy of `items` — ES2023's `Array#toReversed`, written for ES2022. */
export function reversedCopy<T>(items: Iterable<T>): T[] {
  const copy = [...items];
  copy.reverse();
  return copy;
}
