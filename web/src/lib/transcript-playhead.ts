/** Index once per transcript; model output may be unsorted or overlapping. */
export function createTranscriptPlayhead(segments: readonly { start: number; end: number }[]) {
  const ordered = segments
    .map(({ start, end }, index) => ({ start, end, index }))
    .sort((a, b) => a.start - b.start || a.index - b.index);
  interface IntervalNode {
    position: number;
    maxEnd: number;
    left: IntervalNode | null;
    right: IntervalNode | null;
  }
  const build = (low: number, high: number): IntervalNode | null => {
    if (low > high) return null;
    const position = (low + high) >> 1;
    const left = build(low, position - 1);
    const right = build(position + 1, high);
    return {
      position,
      maxEnd: Math.max(ordered[position].end, left?.maxEnd ?? -Infinity, right?.maxEnd ?? -Infinity),
      left,
      right,
    };
  };
  const root = build(0, ordered.length - 1);

  const lastStarted = (time: number) => {
    let low = 0;
    let high = ordered.length - 1;
    let index = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (ordered[middle].start <= time) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return index;
  };

  return {
    playheadIndex(time: number) {
      return ordered[lastStarted(time)]?.index ?? -1;
    },
    activeKey(time: number) {
      const active: number[] = [];
      // Skip expired subtrees. One long segment covering many short ones
      // must not turn every time update into a scan of those expired rows.
      const collect = (node: IntervalNode | null) => {
        if (!node || node.maxEnd <= time) return;
        collect(node.left);
        const segment = ordered[node.position];
        if (segment.start > time) return;
        if (segment.end > time) active.push(segment.index);
        collect(node.right);
      };
      collect(root);
      // Stable keys and original row indices preserve display order.
      return active.sort((a, b) => a - b).join(",");
    },
  };
}
