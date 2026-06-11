import { Cube, Point, Roi } from "./types";

const BOM = "﻿"; // makes Excel read the file as UTF-8 (fixes Korean mojibake)

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Quote a CSV cell if it contains a comma, quote or newline (RFC 4180). */
function cell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function centroid(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 };
  let sx = 0,
    sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

function bbox(points: Point[]) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/** Encode polygon vertices compactly: "x0 y0;x1 y1;..." (no commas). */
function encodePoints(points: Point[]): string {
  return points.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(";");
}
function decodePoints(s: string): Point[] {
  if (!s) return [];
  return s
    .split(";")
    .map((pair) => pair.trim().split(/\s+/).map(Number))
    .filter((xy) => xy.length === 2 && xy.every((n) => !Number.isNaN(n)))
    .map(([x, y]) => ({ x, y }));
}

const META_COLS = [
  "roi_id",
  "label",
  "kind",
  "pixel_count",
  "centroid_x",
  "centroid_y",
  "bbox_x0",
  "bbox_y0",
  "bbox_x1",
  "bbox_y1",
  "points_xy",
];

/**
 * Wide CSV of mean reflectance spectra, including identification columns
 * (label, kind, centroid, bbox) and the full polygon geometry (points_xy) so
 * the annotations can be re-imported and re-drawn later.
 */
export function exportSpectraCSV(cube: Cube, rois: Roi[], baseName: string) {
  const wl = cube.header.wavelengths;
  const B = cube.header.bands;
  const bandHeaders =
    wl.length === B
      ? wl.map((w) => w.toFixed(2))
      : Array.from({ length: B }, (_, i) => `band_${i + 1}`);

  const header = [
    "roi_id",
    "label",
    "kind",
    "pixel_count",
    "centroid_x",
    "centroid_y",
    "bbox_x0",
    "bbox_y0",
    "bbox_x1",
    "bbox_y1",
    ...bandHeaders,
    "points_xy",
  ];
  const lines = [header.map(cell).join(",")];

  for (const r of rois) {
    if (!r.spectrum) continue;
    const c = centroid(r.points);
    const bb = bbox(r.points);
    const row = [
      r.id,
      r.label ?? "",
      r.kind,
      r.pixelCount ?? "",
      Math.round(c.x),
      Math.round(c.y),
      Math.round(bb.x0),
      Math.round(bb.y0),
      Math.round(bb.x1),
      Math.round(bb.y1),
      ...r.spectrum.map((v) => v.toFixed(6)),
      encodePoints(r.points),
    ];
    lines.push(row.map(cell).join(","));
  }
  triggerDownload(BOM + lines.join("\n"), `${baseName}_spectra.csv`, "text/csv;charset=utf-8");
}

/** Long-format CSV: one row per (ROI, band) with id/label/centroid for context. */
export function exportSpectraLongCSV(cube: Cube, rois: Roi[], baseName: string) {
  const wl = cube.header.wavelengths;
  const B = cube.header.bands;
  const header = [
    "roi_id",
    "label",
    "kind",
    "centroid_x",
    "centroid_y",
    "band_index",
    "wavelength_nm",
    "reflectance",
  ];
  const lines = [header.map(cell).join(",")];
  for (const r of rois) {
    if (!r.spectrum) continue;
    const c = centroid(r.points);
    for (let b = 0; b < B; b++) {
      lines.push(
        [
          r.id,
          r.label ?? "",
          r.kind,
          Math.round(c.x),
          Math.round(c.y),
          b + 1,
          wl.length === B ? wl[b].toFixed(2) : "",
          r.spectrum[b].toFixed(6),
        ]
          .map(cell)
          .join(",")
      );
    }
  }
  triggerDownload(
    BOM + lines.join("\n"),
    `${baseName}_spectra_long.csv`,
    "text/csv;charset=utf-8"
  );
}

/** Save the currently-rendered composite (RGB / gray / NDVI) as a PNG. */
export function exportImagePNG(image: ImageData, filename: string) {
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  c.getContext("2d")!.putImageData(image, 0, 0);
  c.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

/** Export ROI geometry + labels as JSON (re-loadable / archival). */
export function exportRoiJSON(cube: Cube, rois: Roi[], baseName: string) {
  const payload = {
    image: baseName,
    width: cube.header.samples,
    height: cube.header.lines,
    bands: cube.header.bands,
    wavelengths: cube.header.wavelengths,
    rois: rois.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      points: r.points,
      centroid: centroid(r.points),
      pixel_count: r.pixelCount,
    })),
  };
  triggerDownload(
    JSON.stringify(payload, null, 2),
    `${baseName}_rois.json`,
    "application/json"
  );
}

export interface ImportedRoi {
  id?: string;
  label: string;
  kind: "polygon" | "bbox";
  points: Point[];
  spectrum?: number[];
  pixelCount?: number;
}

function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse a previously-exported wide spectra CSV back into ROIs (geometry +
 * label + spectrum) so they can be re-drawn on the image.
 */
export function parseSpectraCSV(text: string): ImportedRoi[] {
  const clean = text.replace(/^﻿/, "").replace(/\r/g, "");
  const rows = clean.split("\n").filter((l) => l.trim().length);
  if (rows.length < 2) return [];
  const headers = splitCSVLine(rows[0]);
  const idx = (name: string) => headers.indexOf(name);

  const iId = idx("roi_id");
  const iLabel = idx("label");
  const iKind = idx("kind");
  const iPx = idx("pixel_count");
  const iPts = idx("points_xy");
  const ibb = ["bbox_x0", "bbox_y0", "bbox_x1", "bbox_y1"].map(idx);

  // band columns = every header that is not a known meta column
  const bandIdx: number[] = [];
  headers.forEach((h, i) => {
    if (!META_COLS.includes(h)) bandIdx.push(i);
  });

  const out: ImportedRoi[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = splitCSVLine(rows[r]);
    let points: Point[] = iPts >= 0 ? decodePoints(cols[iPts] ?? "") : [];
    if (points.length < 3 && ibb.every((c) => c >= 0)) {
      const [x0, y0, x1, y1] = ibb.map((c) => Number(cols[c]));
      if ([x0, y0, x1, y1].every((n) => !Number.isNaN(n))) {
        points = [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ];
      }
    }
    if (points.length < 3) continue;
    const spectrum = bandIdx.length
      ? bandIdx.map((c) => Number(cols[c])).filter((n) => !Number.isNaN(n))
      : undefined;
    out.push({
      id: iId >= 0 ? cols[iId] : undefined,
      label: iLabel >= 0 ? cols[iLabel] : "",
      kind: (iKind >= 0 && cols[iKind] === "bbox" ? "bbox" : "polygon") as
        | "polygon"
        | "bbox",
      points,
      spectrum: spectrum && spectrum.length ? spectrum : undefined,
      pixelCount: iPx >= 0 ? Number(cols[iPx]) || undefined : undefined,
    });
  }
  return out;
}
