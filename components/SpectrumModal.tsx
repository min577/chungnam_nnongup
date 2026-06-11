"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Roi } from "@/lib/types";

interface Props {
  wavelengths: number[];
  rois: Roi[];
  highlightId: string | null;
  onClose: () => void;
}

const W = 940;
const H = 520;
const padL = 64;
const padR = 24;
const padT = 22;
const padB = 48;

/**
 * Large, interactive mean-reflectance spectrum viewer.
 * - Ctrl-free mouse wheel zooms the wavelength (X) axis around the cursor.
 * - The reflectance (Y) axis auto-rescales to whatever is visible.
 * - Drag to pan, double-click / reset to fit everything.
 */
export default function SpectrumModal({
  wavelengths,
  rois,
  highlightId,
  onClose,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  const withSpec = useMemo(
    () => rois.filter((r) => r.spectrum && r.spectrum.length),
    [rois]
  );
  const B = withSpec[0]?.spectrum?.length ?? 0;
  const xs = useMemo(
    () =>
      wavelengths.length === B
        ? wavelengths
        : Array.from({ length: B }, (_, i) => i + 1),
    [wavelengths, B]
  );
  const dataMin = xs[0] ?? 0;
  const dataMax = xs[xs.length - 1] ?? 1;

  const [xRange, setXRange] = useState<[number, number]>([dataMin, dataMax]);
  const [hoverWl, setHoverWl] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; lo: number; hi: number } | null>(null);

  // reset range if the data changes
  useEffect(() => {
    setXRange([dataMin, dataMax]);
  }, [dataMin, dataMax, B]);

  const [xLo, xHi] = xRange;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Y range auto-fit to the currently visible wavelength window
  const [yLo, yHi] = useMemo(() => {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < B; i++) {
      if (xs[i] < xLo || xs[i] > xHi) continue;
      for (const r of withSpec) {
        const v = r.spectrum![i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    const pad = (hi - lo) * 0.06 || 0.02;
    return [Math.min(lo - pad, lo), hi + pad];
  }, [xs, withSpec, xLo, xHi, B]);

  const wlToPx = (wl: number) => padL + ((wl - xLo) / (xHi - xLo || 1)) * innerW;
  const pxToWl = (px: number) => xLo + ((px - padL) / innerW) * (xHi - xLo);
  const vToPy = (v: number) => H - padB - ((v - yLo) / (yHi - yLo || 1)) * innerH;

  const clientToSvgX = (clientX: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  };

  // wheel zoom (cursor-anchored) — non-passive listener so we can preventDefault
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const px = clientToSvgX(e.clientX);
      const anchor = Math.max(xLo, Math.min(xHi, pxToWl(px)));
      const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85;
      const fullSpan = dataMax - dataMin;
      const minSpan = Math.max(fullSpan / 80, fullSpan > 50 ? 8 : 1);
      let span = (xHi - xLo) * factor;
      span = Math.max(minSpan, Math.min(fullSpan, span));
      if (span >= fullSpan) {
        setXRange([dataMin, dataMax]);
        return;
      }
      let lo = anchor - ((anchor - xLo) * span) / (xHi - xLo);
      let hi = lo + span;
      if (lo < dataMin) {
        lo = dataMin;
        hi = lo + span;
      }
      if (hi > dataMax) {
        hi = dataMax;
        lo = hi - span;
      }
      setXRange([lo, hi]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [xLo, xHi, dataMin, dataMax]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: clientToSvgX(e.clientX), lo: xLo, hi: xHi };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const sx = clientToSvgX(e.clientX);
    setHoverWl(pxToWl(sx));
    const d = dragRef.current;
    if (!d) return;
    const dxWl = ((sx - d.startX) / innerW) * (d.hi - d.lo);
    let lo = d.lo - dxWl;
    let hi = d.hi - dxWl;
    const span = d.hi - d.lo;
    if (lo < dataMin) {
      lo = dataMin;
      hi = lo + span;
    }
    if (hi > dataMax) {
      hi = dataMax;
      lo = hi - span;
    }
    setXRange([lo, hi]);
  };
  const endDrag = () => (dragRef.current = null);

  const reset = () => setXRange([dataMin, dataMax]);

  // nearest band index to hovered wavelength (for the readout)
  const hoverIdx = useMemo(() => {
    if (hoverWl == null) return -1;
    let best = -1,
      bd = Infinity;
    for (let i = 0; i < B; i++) {
      if (xs[i] < xLo || xs[i] > xHi) continue;
      const d = Math.abs(xs[i] - hoverWl);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }, [hoverWl, xs, xLo, xHi, B]);

  const yTicks = 5;
  const xTicks = 6;
  const zoomPct = Math.round(((dataMax - dataMin) / (xHi - xLo || 1)) * 100);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card spectrum-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>평균 반사율 스펙트럼</h2>
          <div className="modal-tools">
            <span className="zoom-tag">{zoomPct}%</span>
            <button onClick={reset}>맞춤(전체)</button>
            <button className="ghost" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {withSpec.length === 0 ? (
          <div className="hint" style={{ padding: 40, textAlign: "center" }}>
            표시할 스펙트럼이 없습니다.
          </div>
        ) : (
          <>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              className="spectrum-svg"
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={() => {
                endDrag();
                setHoverWl(null);
              }}
              onDoubleClick={reset}
            >
              <defs>
                <clipPath id="plot">
                  <rect x={padL} y={padT} width={innerW} height={innerH} />
                </clipPath>
              </defs>

              {/* grid + y ticks */}
              {Array.from({ length: yTicks + 1 }, (_, i) => {
                const v = yLo + ((yHi - yLo) * i) / yTicks;
                const y = vToPy(v);
                return (
                  <g key={`y${i}`}>
                    <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#e7ebf1" />
                    <text x={padL - 8} y={y + 4} fontSize="12" fill="#8a94a3" textAnchor="end">
                      {v.toFixed(3)}
                    </text>
                  </g>
                );
              })}
              {/* x ticks */}
              {Array.from({ length: xTicks + 1 }, (_, i) => {
                const wl = xLo + ((xHi - xLo) * i) / xTicks;
                const x = wlToPx(wl);
                return (
                  <g key={`x${i}`}>
                    <line x1={x} y1={padT} x2={x} y2={H - padB} stroke="#f0f2f6" />
                    <text x={x} y={H - padB + 18} fontSize="12" fill="#8a94a3" textAnchor="middle">
                      {Math.round(wl)}
                    </text>
                  </g>
                );
              })}

              {/* axes */}
              <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#c8d0db" />
              <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#c8d0db" />
              <text x={(W + padL) / 2} y={H - 10} fontSize="12.5" fill="#5a6676" textAnchor="middle">
                파장 (nm)
              </text>

              {/* spectra */}
              <g clipPath="url(#plot)">
                {withSpec.map((r) => {
                  const hot = r.id === highlightId;
                  let d = "";
                  for (let i = 0; i < B; i++) {
                    // only emit points near/within the window for speed
                    d += `${i === 0 ? "M" : "L"}${wlToPx(xs[i]).toFixed(1)},${vToPy(
                      r.spectrum![i]
                    ).toFixed(1)}`;
                  }
                  return (
                    <path
                      key={r.id}
                      d={d}
                      fill="none"
                      stroke={r.color}
                      strokeWidth={hot ? 2.6 : 1.5}
                      opacity={highlightId && !hot ? 0.3 : 1}
                    />
                  );
                })}

                {/* hover crosshair */}
                {hoverIdx >= 0 && (
                  <line
                    x1={wlToPx(xs[hoverIdx])}
                    y1={padT}
                    x2={wlToPx(xs[hoverIdx])}
                    y2={H - padB}
                    stroke="#9aa6b5"
                    strokeDasharray="4 3"
                  />
                )}
                {hoverIdx >= 0 &&
                  withSpec.map((r) => (
                    <circle
                      key={`pt${r.id}`}
                      cx={wlToPx(xs[hoverIdx])}
                      cy={vToPy(r.spectrum![hoverIdx])}
                      r={r.id === highlightId ? 4 : 3}
                      fill={r.color}
                      stroke="#fff"
                      strokeWidth="1.2"
                    />
                  ))}
              </g>
            </svg>

            {/* hover readout */}
            {hoverIdx >= 0 && (
              <div className="readout">
                <b>{Math.round(xs[hoverIdx])} nm</b>
                {withSpec.map((r) => (
                  <span key={r.id} className="ro-item">
                    <span className="ro-sw" style={{ background: r.color }} />
                    {r.label}: {r.spectrum![hoverIdx].toFixed(4)}
                  </span>
                ))}
              </div>
            )}

            {/* legend */}
            <div className="legend-row">
              {withSpec.map((r) => (
                <span key={r.id} className="lg">
                  <span className="lg-sw" style={{ background: r.color }} />
                  {r.label}
                </span>
              ))}
            </div>
            <p className="hint" style={{ textAlign: "center", marginTop: 4 }}>
              마우스 휠: 확대·축소(축 자동 조정) · 드래그: 이동 · 더블클릭: 전체 보기
            </p>
          </>
        )}
      </div>
    </div>
  );
}
