/** Map full-string lowercase matches back to original code-point boundaries. */
export function* lowercaseMatches(text: string, query: string) {
  const lower = text.toLowerCase(), term = query.toLowerCase();
  if (!term || !lower.includes(term)) return;
  const starts: number[] = [], ends: number[] = [];
  let folded = "", offset = 0;
  for (const point of text) {
    const loweredPoint = point.toLowerCase();
    for (let unit = 0; unit < loweredPoint.length; unit++) {
      starts.push(offset); ends.push(offset + point.length);
    }
    folded += loweredPoint;
    offset += point.length;
  }
  if (folded.length !== lower.length) return;
  let from = 0, index: number;
  while ((index = lower.indexOf(term, from)) !== -1) {
    const last = index + term.length - 1;
    // Partial code points and contextual lowering (such as final sigma) stay unmarked.
    const highlightable = (index === 0 || starts[index] !== starts[index - 1])
      && (last + 1 === lower.length || ends[last] !== ends[last + 1])
      && folded.slice(index, last + 1) === term;
    yield { start: starts[index], end: ends[last], highlightable };
    from = last + 1;
  }
}
