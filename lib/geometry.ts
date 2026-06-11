import { Point } from "./types";

/** Perpendicular distance from p to the line a-b. */
function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  let maxDist = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDist(points[i], points[0], points[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = simplify(points.slice(0, index + 1), epsilon);
    const right = simplify(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

/**
 * Trace the outer boundary of the largest connected blob in a binary mask
 * (Moore neighbour tracing), then simplify to a polygon.
 *
 * mask: Uint8Array of width*height, non-zero = foreground.
 */
export function maskToPolygon(
  mask: Uint8Array,
  width: number,
  height: number,
  epsilon = 1.5
): Point[] {
  const idx = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x];

  // Keep only the largest connected component to avoid speckle.
  const labels = largestComponent(mask, width, height);
  if (!labels) return [];
  const fg = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : labels[y * width + x];

  // Find a start pixel (top-left-most foreground)
  let sx = -1,
    sy = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (fg(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return [];

  // Moore-neighbour boundary tracing
  const dirs = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const contour: Point[] = [];
  let cx = sx,
    cy = sy;
  let dir = 6; // start searching from "up"
  const maxSteps = width * height * 4;
  let steps = 0;
  do {
    contour.push({ x: cx, y: cy });
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (dir + k) % 8;
      const nx = cx + dirs[nd][0];
      const ny = cy + dirs[nd][1];
      if (fg(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = (nd + 6) % 8; // back up to keep boundary on the left
        found = true;
        break;
      }
    }
    if (!found) break;
    steps++;
  } while ((cx !== sx || cy !== sy) && steps < maxSteps);

  void idx;
  if (contour.length < 3) return contour;
  const simplified = simplify(contour, epsilon);
  // RDP can leave a duplicate closing point; drop it.
  if (
    simplified.length > 1 &&
    simplified[0].x === simplified[simplified.length - 1].x &&
    simplified[0].y === simplified[simplified.length - 1].y
  ) {
    simplified.pop();
  }
  return simplified;
}

/** Returns a mask of the single largest 4-connected foreground component. */
function largestComponent(
  mask: Uint8Array,
  width: number,
  height: number
): Uint8Array | null {
  const visited = new Uint8Array(width * height);
  const comp = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  let nComp = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let size = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp[p] = nComp;
      size++;
      const x = p % width;
      const y = (p / width) | 0;
      const nbrs = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ];
      for (const np of nbrs) {
        if (np >= 0 && mask[np] && !visited[np]) {
          visited[np] = 1;
          stack.push(np);
        }
      }
    }
    sizes.push(size);
    nComp++;
  }
  if (nComp === 0) return null;
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = comp[i] === best ? 1 : 0;
  return out;
}

/** Build the 4 corner points of an axis-aligned bbox from two opposite corners. */
export function bboxPoints(a: Point, b: Point): Point[] {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}
