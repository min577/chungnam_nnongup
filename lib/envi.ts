import { Cube, EnviHeader, Point } from "./types";

/**
 * Minimal ENVI parser for Specim IQ data cubes (and compatible ENVI files).
 * Handles BIL / BIP / BSQ interleave and the common ENVI data types.
 */

// ENVI "data type" -> bytes per sample
const DTYPE_BYTES: Record<number, number> = {
  1: 1, // 8-bit unsigned int
  2: 2, // 16-bit signed int
  3: 4, // 32-bit signed int
  4: 4, // 32-bit float
  5: 8, // 64-bit float
  12: 2, // 16-bit unsigned int
};

function parseList(raw: string): number[] {
  const m = raw.match(/\{([^}]*)\}/s);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !Number.isNaN(n));
}

export function parseHeader(text: string): EnviHeader {
  // Collapse brace blocks onto single logical lines so key=value parsing is easy.
  const lines = text.replace(/\r/g, "").split("\n");
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("=")) {
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim().toLowerCase();
      let val = line.slice(eq + 1).trim();
      if (val.includes("{") && !val.includes("}")) {
        // multi-line braced value
        while (i + 1 < lines.length && !val.includes("}")) {
          i += 1;
          val += "\n" + lines[i];
        }
      }
      fields[key] = val;
    }
    i += 1;
  }

  const interleaveRaw = (fields["interleave"] || "bil").toLowerCase();
  const interleave = (["bil", "bip", "bsq"].includes(interleaveRaw)
    ? interleaveRaw
    : "bil") as EnviHeader["interleave"];

  const defaultBandsList = parseList(fields["default bands"] || "");
  const defaultBands =
    defaultBandsList.length >= 3
      ? ([defaultBandsList[0], defaultBandsList[1], defaultBandsList[2]] as [
          number,
          number,
          number
        ])
      : null;

  return {
    samples: parseInt(fields["samples"], 10),
    lines: parseInt(fields["lines"], 10),
    bands: parseInt(fields["bands"], 10),
    dataType: parseInt(fields["data type"], 10),
    interleave,
    byteOrder: parseInt(fields["byte order"] || "0", 10),
    headerOffset: parseInt(fields["header offset"] || "0", 10),
    wavelengths: parseList(fields["wavelength"] || ""),
    defaultBands,
    description: (fields["description"] || "").replace(/[{}]/g, "").trim(),
  };
}

export function makeTypedArray(
  buffer: ArrayBuffer,
  header: EnviHeader
): Cube["data"] {
  const { dataType, headerOffset } = header;
  const offset = headerOffset || 0;
  switch (dataType) {
    case 1:
      return new Uint8Array(buffer, offset);
    case 2:
      return new Int16Array(buffer, offset);
    case 3:
      return new Int32Array(buffer, offset);
    case 4:
      return new Float32Array(buffer, offset);
    case 5:
      return new Float64Array(buffer, offset);
    case 12:
      return new Uint16Array(buffer, offset);
    default:
      throw new Error(`Unsupported ENVI data type: ${dataType}`);
  }
}

export function bytesPerSample(dataType: number): number {
  return DTYPE_BYTES[dataType] ?? 4;
}

export function loadCube(
  hdrText: string,
  dataBuffer: ArrayBuffer,
  name: string
): Cube {
  const header = parseHeader(hdrText);
  if (!header.samples || !header.lines || !header.bands) {
    throw new Error("헤더에서 samples/lines/bands를 읽지 못했습니다.");
  }
  const expected =
    header.samples * header.lines * header.bands * bytesPerSample(header.dataType);
  const actual = dataBuffer.byteLength - (header.headerOffset || 0);
  if (actual < expected) {
    throw new Error(
      `데이터 크기 불일치: 예상 ${expected} 바이트, 실제 ${actual} 바이트. ` +
        `(.hdr와 .dat 파일이 같은 캡처인지 확인하세요)`
    );
  }
  const data = makeTypedArray(dataBuffer, header);
  return { header, data, name };
}

/** Flat index of a single (x, y, band) sample given the interleave layout. */
export function sampleIndex(
  h: EnviHeader,
  x: number,
  y: number,
  b: number
): number {
  const { samples: S, lines: L, bands: B } = h;
  switch (h.interleave) {
    case "bip": // band interleaved by pixel: [line][sample][band]
      return (y * S + x) * B + b;
    case "bsq": // band sequential: [band][line][sample]
      return b * L * S + y * S + x;
    case "bil": // band interleaved by line: [line][band][sample]
    default:
      return (y * B + b) * S + x;
  }
}

function percentileStretch(vals: Float64Array): [number, number] {
  const sorted = Float64Array.from(vals).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  return [lo, hi === lo ? lo + 1e-6 : hi];
}

/**
 * Build an 8-bit RGB image (Uint8ClampedArray, RGBA) from three bands of the cube
 * using a 2–98 percentile contrast stretch per channel.
 */
export function compositeRGB(
  cube: Cube,
  bandsRGB: [number, number, number]
): ImageData {
  const { header: h, data } = cube;
  const S = h.samples;
  const L = h.lines;
  const n = S * L;
  const channels = bandsRGB.map((band1) => {
    // default bands are 1-indexed in ENVI; clamp to range
    const b = Math.min(Math.max(Math.round(band1) - 1, 0), h.bands - 1);
    const out = new Float64Array(n);
    for (let y = 0; y < L; y++) {
      for (let x = 0; x < S; x++) {
        out[y * S + x] = data[sampleIndex(h, x, y, b)];
      }
    }
    return out;
  });

  const rgba = new Uint8ClampedArray(n * 4);
  channels.forEach((chan, ci) => {
    const [lo, hi] = percentileStretch(chan);
    const scale = 255 / (hi - lo);
    for (let p = 0; p < n; p++) {
      rgba[p * 4 + ci] = (chan[p] - lo) * scale;
    }
  });
  for (let p = 0; p < n; p++) rgba[p * 4 + 3] = 255;

  return new ImageData(rgba, S, L);
}

/** True if point (px, py) lies inside the polygon (ray casting). */
export function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersect =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Mean reflectance spectrum over all cube pixels inside the polygon.
 * Returns { spectrum: number[bands], pixelCount }.
 */
export function meanSpectrum(
  cube: Cube,
  poly: Point[]
): { spectrum: number[]; pixelCount: number } {
  const { header: h, data } = cube;
  const B = h.bands;
  const sums = new Float64Array(B);

  // Bounding box of polygon to limit scan
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  minX = Math.max(0, Math.floor(minX));
  minY = Math.max(0, Math.floor(minY));
  maxX = Math.min(h.samples - 1, Math.ceil(maxX));
  maxY = Math.min(h.lines - 1, Math.ceil(maxY));

  // Collect inside-pixel coordinates first (so band loop is cache-friendly for BIL)
  const xsByRow: number[][] = [];
  let count = 0;
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let x = minX; x <= maxX; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, poly)) xs.push(x);
    }
    xsByRow[y] = xs;
    count += xs.length;
  }
  if (count === 0) return { spectrum: new Array(B).fill(0), pixelCount: 0 };

  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let y = minY; y <= maxY; y++) {
      const xs = xsByRow[y];
      for (let k = 0; k < xs.length; k++) {
        s += data[sampleIndex(h, xs[k], y, b)];
      }
    }
    sums[b] = s;
  }

  const spectrum = Array.from(sums, (s) => s / count);
  return { spectrum, pixelCount: count };
}
