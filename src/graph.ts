/**
 * Incremental lane layout for a commit graph.
 *
 * Commits are fed in display order (children before parents). Each row gets a
 * column for its node plus line segments split into a top half (row top → node
 * middle) and a bottom half (node middle → row bottom). Lanes keep a stable
 * column while alive, so pass-through lines are always vertical.
 */

export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface Segment {
  /** Column at the start of the half-row (top edge for 'top', node middle for 'bottom'). */
  from: number;
  /** Column at the end of the half-row. */
  to: number;
  color: number;
  half: 'top' | 'bottom';
}

export interface RowLayout {
  col: number;
  color: number;
  segments: Segment[];
  /** Number of columns this row needs to draw. */
  width: number;
}

interface Lane {
  hash: string;
  color: number;
}

export class GraphLayout {
  private lanes: (Lane | null)[] = [];
  private nextColor = 0;

  add(commit: GraphCommit): RowLayout {
    const segments: Segment[] = [];
    const before = this.lanes.length;

    const matching: number[] = [];
    this.lanes.forEach((lane, i) => {
      if (lane?.hash === commit.hash) matching.push(i);
    });

    let col: number;
    let color: number;
    if (matching.length > 0) {
      col = matching[0];
      color = this.lanes[col]!.color;
    } else {
      col = this.freeSlot();
      color = this.nextColor++;
    }

    // Top half: lanes converging into this node, everything else passes through.
    const passing = new Set<number>();
    this.lanes.forEach((lane, i) => {
      if (!lane) return;
      if (lane.hash === commit.hash) {
        segments.push({ from: i, to: col, color: lane.color, half: 'top' });
      } else {
        segments.push({ from: i, to: i, color: lane.color, half: 'top' });
        passing.add(i);
      }
    });
    for (const i of matching) this.lanes[i] = null;

    // Bottom half: the first parent continues this lane; extra parents join an
    // existing lane when one already expects them, otherwise open a new lane.
    const [first, ...rest] = commit.parents;
    if (first !== undefined) {
      this.setLane(col, { hash: first, color });
      segments.push({ from: col, to: col, color, half: 'bottom' });
    }
    for (const parent of rest) {
      const existing = this.lanes.findIndex(l => l?.hash === parent);
      if (existing !== -1) {
        segments.push({ from: col, to: existing, color: this.lanes[existing]!.color, half: 'bottom' });
      } else {
        const slot = this.freeSlot();
        const laneColor = this.nextColor++;
        this.setLane(slot, { hash: parent, color: laneColor });
        segments.push({ from: col, to: slot, color: laneColor, half: 'bottom' });
      }
    }
    for (const i of passing) {
      const lane = this.lanes[i]!;
      segments.push({ from: i, to: i, color: lane.color, half: 'bottom' });
    }

    while (this.lanes.length > 0 && this.lanes[this.lanes.length - 1] === null) this.lanes.pop();

    return { col, color, segments, width: Math.max(before, this.lanes.length, col + 1) };
  }

  private freeSlot(): number {
    const i = this.lanes.indexOf(null);
    if (i !== -1) return i;
    this.lanes.push(null);
    return this.lanes.length - 1;
  }

  private setLane(i: number, lane: Lane): void {
    while (this.lanes.length <= i) this.lanes.push(null);
    this.lanes[i] = lane;
  }
}
