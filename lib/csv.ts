import { Cube, Roi } from "./types";

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * CSV of mean reflectance spectra.
 * Rows = ROIs, columns = roi_id, label, pixel_count, then one column per band
 * (header is the wavelength in nm).
 */
export function exportSpectraCSV(cube: Cube, rois: Roi[], baseName: string) {
  const wl = cube.header.wavelengths;
  const B = cube.header.bands;
  const bandHeaders =
    wl.length === B
      ? wl.map((w) => w.toFixed(2))
      : Array.from({ length: B }, (_, i) => `band_${i + 1}`);

  const header = ["roi_id", "label", "pixel_count", ...bandHeaders].join(",");
  const lines = [header];
  for (const r of rois) {
    if (!r.spectrum) continue;
    const row = [
      r.id,
      JSON.stringify(r.label ?? ""),
      String(r.pixelCount ?? ""),
      ...r.spectrum.map((v) => v.toFixed(6)),
    ];
    lines.push(row.join(","));
  }
  triggerDownload(lines.join("\n"), `${baseName}_spectra.csv`, "text/csv");
}

/** Long-format CSV: one row per (ROI, band) — handy for plotting in pandas/R. */
export function exportSpectraLongCSV(cube: Cube, rois: Roi[], baseName: string) {
  const wl = cube.header.wavelengths;
  const B = cube.header.bands;
  const header = ["roi_id", "label", "band_index", "wavelength_nm", "reflectance"].join(",");
  const lines = [header];
  for (const r of rois) {
    if (!r.spectrum) continue;
    for (let b = 0; b < B; b++) {
      lines.push(
        [
          r.id,
          JSON.stringify(r.label ?? ""),
          b + 1,
          wl.length === B ? wl[b].toFixed(2) : "",
          r.spectrum[b].toFixed(6),
        ].join(",")
      );
    }
  }
  triggerDownload(lines.join("\n"), `${baseName}_spectra_long.csv`, "text/csv");
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
      pixel_count: r.pixelCount,
    })),
  };
  triggerDownload(
    JSON.stringify(payload, null, 2),
    `${baseName}_rois.json`,
    "application/json"
  );
}
