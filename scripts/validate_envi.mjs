// Standalone sanity check of the ENVI BIL layout + reflectance scaling
// against the real Specim IQ cucumber cube. Mirrors lib/envi.ts math.
import { readFileSync } from "node:fs";

const dir = "/data/Minwoo/cucumber/100_1_robot_311/results";
const hdrText = readFileSync(`${dir}/REFLECTANCE_robot_311.hdr`, "utf8");
const buf = readFileSync(`${dir}/REFLECTANCE_robot_311.dat`);

function parseList(raw) {
  const m = raw.match(/\{([^}]*)\}/s);
  return m ? m[1].split(",").map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n)) : [];
}
const fields = {};
{
  const lines = hdrText.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("=")) continue;
    const eq = lines[i].indexOf("=");
    const k = lines[i].slice(0, eq).trim().toLowerCase();
    let v = lines[i].slice(eq + 1).trim();
    if (v.includes("{") && !v.includes("}")) while (i + 1 < lines.length && !v.includes("}")) v += "\n" + lines[++i];
    fields[k] = v;
  }
}
const S = +fields["samples"], L = +fields["lines"], B = +fields["bands"];
const dtype = +fields["data type"], interleave = (fields["interleave"] || "bil").toLowerCase();
const wl = parseList(fields["wavelength"]);
console.log({ S, L, B, dtype, interleave, wlCount: wl.length });

const expected = S * L * B * 4;
console.log("expected bytes:", expected, "actual:", buf.byteLength, expected === buf.byteLength ? "MATCH" : "MISMATCH");

const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const idx = (x, y, b) => (y * B + b) * S + x; // BIL

// Mean spectrum over the white reference tile region (top-left bright square ~ x:40-90, y:30-80)
function regionMean(x0, y0, x1, y1) {
  const spec = new Float64Array(B);
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { for (let b = 0; b < B; b++) spec[b] += data[idx(x, y, b)]; n++; }
  return [Array.from(spec, (s) => s / n), n];
}
const [tile, nt] = regionMean(45, 30, 90, 75);
const [center, nc] = regionMean(230, 230, 280, 280);
const tileMin = Math.min(...tile), tileMax = Math.max(...tile);
const cMin = Math.min(...center), cMax = Math.max(...center);
console.log(`white tile  (n=${nt}): refl min=${tileMin.toFixed(3)} max=${tileMax.toFixed(3)}  @550nm=${tile[55].toFixed(3)}`);
console.log(`center spec (n=${nc}): refl min=${cMin.toFixed(3)} max=${cMax.toFixed(3)}  @550nm=${center[55].toFixed(3)} @750nm=${center[120].toFixed(3)}`);
console.log("white tile flat & high (≈1.0)?", tileMax < 1.5 && tileMin > 0.6);
