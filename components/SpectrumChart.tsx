"use client";

import { Roi } from "@/lib/types";

interface Props {
  wavelengths: number[];
  rois: Roi[];
  highlightId: string | null;
}

/** Lightweight multi-line spectral plot (mean reflectance vs wavelength). */
export default function SpectrumChart({ wavelengths, rois, highlightId }: Props) {
  const withSpec = rois.filter((r) => r.spectrum && r.spectrum.length);
  const W = 300;
  const H = 180;
  const padL = 34;
  const padB = 22;
  const padT = 8;
  const padR = 6;

  if (withSpec.length === 0) {
    return (
      <div className="hint">
        ROI를 그리면 평균 반사율 스펙트럼이 여기에 표시됩니다.
      </div>
    );
  }

  const B = withSpec[0].spectrum!.length;
  const xs =
    wavelengths.length === B ? wavelengths : Array.from({ length: B }, (_, i) => i);
  const xMin = xs[0];
  const xMax = xs[xs.length - 1];

  let yMax = 0;
  let yMin = Infinity;
  for (const r of withSpec) {
    for (const v of r.spectrum!) {
      if (v > yMax) yMax = v;
      if (v < yMin) yMin = v;
    }
  }
  if (!isFinite(yMin)) yMin = 0;
  yMin = Math.min(yMin, 0);
  yMax = yMax <= 0 ? 1 : yMax * 1.05;

  const px = (x: number) =>
    padL + ((x - xMin) / (xMax - xMin || 1)) * (W - padL - padR);
  const py = (y: number) =>
    H - padB - ((y - yMin) / (yMax - yMin || 1)) * (H - padT - padB);

  const yTicks = 4;
  const xTicks = 4;

  return (
    <svg width={W} height={H} style={{ width: "100%", height: "auto" }}>
      {/* axes */}
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#2a3340" />
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#2a3340" />
      {/* y ticks */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const v = yMin + ((yMax - yMin) * i) / yTicks;
        const y = py(v);
        return (
          <g key={`y${i}`}>
            <line x1={padL - 3} y1={y} x2={W - padR} y2={y} stroke="#1c2230" />
            <text x={padL - 5} y={y + 3} fontSize="9" fill="#8b97a7" textAnchor="end">
              {v.toFixed(2)}
            </text>
          </g>
        );
      })}
      {/* x ticks */}
      {Array.from({ length: xTicks + 1 }, (_, i) => {
        const v = xMin + ((xMax - xMin) * i) / xTicks;
        const x = px(v);
        return (
          <text key={`x${i}`} x={x} y={H - padB + 13} fontSize="9" fill="#8b97a7" textAnchor="middle">
            {Math.round(v)}
          </text>
        );
      })}
      <text x={(W + padL) / 2} y={H - 2} fontSize="9" fill="#8b97a7" textAnchor="middle">
        파장 (nm)
      </text>
      {/* lines */}
      {withSpec.map((r) => {
        const d = r.spectrum!
          .map((v, i) => `${i === 0 ? "M" : "L"}${px(xs[i]).toFixed(1)},${py(v).toFixed(1)}`)
          .join(" ");
        const hot = r.id === highlightId;
        return (
          <path
            key={r.id}
            d={d}
            fill="none"
            stroke={r.color}
            strokeWidth={hot ? 2.2 : 1}
            opacity={highlightId && !hot ? 0.35 : 1}
          />
        );
      })}
    </svg>
  );
}
