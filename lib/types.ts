export type ShapeKind = "polygon" | "bbox";

export interface Point {
  x: number;
  y: number;
}

export interface Roi {
  id: string;
  kind: ShapeKind;
  /** Polygon vertices in image pixel coordinates. A bbox is stored as 4 corner points. */
  points: Point[];
  label: string;
  color: string;
  /** Cached mean reflectance spectrum (one value per band), computed lazily. */
  spectrum?: number[];
  pixelCount?: number;
}

export interface EnviHeader {
  samples: number;
  lines: number;
  bands: number;
  dataType: number;
  interleave: "bil" | "bip" | "bsq";
  byteOrder: number;
  headerOffset: number;
  wavelengths: number[];
  defaultBands: [number, number, number] | null;
  description: string;
}

export interface Cube {
  header: EnviHeader;
  /** Typed-array view over the raw cube data. */
  data: Float32Array | Uint16Array | Uint8Array | Int16Array | Int32Array | Float64Array;
  name: string;
}
