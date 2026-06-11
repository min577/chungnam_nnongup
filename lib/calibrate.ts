import { Cube, EnviHeader } from "./types";
import { sampleIndex } from "./envi";

/**
 * Radiometric (flat-field) calibration of a raw Specim IQ cube into reflectance:
 *
 *   R[y,x,b] = (sample[y,x,b] - dark[x,b]) / (white[x,b] - dark[x,b])
 *
 * White / dark references are single-line (or few-line) captures; per (x, band)
 * we average over their available lines and broadcast across every sample line,
 * exactly matching the reference Python pipeline. Result is clipped to [0, 1].
 *
 * Output is a new BIL float32 Cube with the sample's geometry and wavelengths,
 * so the rest of the app (RGB composite, mean spectrum) is unchanged.
 */
export function calibrateCube(sample: Cube, white: Cube, dark: Cube): Cube {
  const hs = sample.header;
  const S = hs.samples;
  const L = hs.lines;
  const B = hs.bands;

  if (white.header.samples !== S || white.header.bands !== B)
    throw new Error(
      `WHITEREF 차원이 sample과 다릅니다 (white ${white.header.samples}×${white.header.bands}, sample ${S}×${B}).`
    );
  if (dark.header.samples !== S || dark.header.bands !== B)
    throw new Error(
      `DARKREF 차원이 sample과 다릅니다 (dark ${dark.header.samples}×${dark.header.bands}, sample ${S}×${B}).`
    );

  // Per-(band, sample) averaged reference lines -> index r = b*S + x
  const refLineMean = (cube: Cube): Float64Array => {
    const out = new Float64Array(S * B);
    const n = cube.header.lines;
    for (let b = 0; b < B; b++) {
      for (let x = 0; x < S; x++) {
        let acc = 0;
        for (let y = 0; y < n; y++) acc += cube.data[sampleIndex(cube.header, x, y, b)];
        out[b * S + x] = acc / n;
      }
    }
    return out;
  };

  const whiteM = refLineMean(white);
  const darkM = refLineMean(dark);

  const eps = 1e-6;
  // denom[b*S + x]
  const denom = new Float64Array(S * B);
  for (let i = 0; i < denom.length; i++) {
    const d = whiteM[i] - darkM[i];
    denom[i] = Math.abs(d) < eps ? eps : d;
  }

  const out = new Float32Array(S * L * B);
  const sd = sample.data;
  for (let y = 0; y < L; y++) {
    for (let b = 0; b < B; b++) {
      const refBase = b * S;
      const outBase = (y * B + b) * S; // BIL output
      for (let x = 0; x < S; x++) {
        const v =
          (sd[sampleIndex(hs, x, y, b)] - darkM[refBase + x]) / denom[refBase + x];
        out[outBase + x] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
  }

  const header: EnviHeader = {
    ...hs,
    dataType: 4,
    interleave: "bil",
    headerOffset: 0,
  };
  return { header, data: out, name: sample.name };
}
