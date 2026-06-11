"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AnnotationCanvas, { Tool } from "@/components/AnnotationCanvas";
import SpectrumChart from "@/components/SpectrumChart";
import { Cube, Point, Roi, ShapeKind } from "@/lib/types";
import { compositeRGB, loadCube, meanSpectrum } from "@/lib/envi";
import { maskToPolygon } from "@/lib/geometry";
import * as sam from "@/lib/sam";
import {
  exportRoiJSON,
  exportSpectraCSV,
  exportSpectraLongCSV,
} from "@/lib/csv";

const PALETTE = [
  "#2f81f7",
  "#3fb950",
  "#db61a2",
  "#f0883e",
  "#a371f7",
  "#56d4dd",
  "#e3b341",
  "#ff7b72",
  "#7ee787",
  "#79c0ff",
];

let roiCounter = 0;
const nextId = () => `roi_${++roiCounter}`;

export default function Page() {
  const [cube, setCube] = useState<Cube | null>(null);
  const [baseName, setBaseName] = useState("capture");
  const [bands, setBands] = useState<[number, number, number]>([70, 53, 19]);
  const [baseImage, setBaseImage] = useState<ImageData | null>(null);

  const [tool, setTool] = useState<Tool>("polygon");
  const [zoom, setZoom] = useState(1);
  const [rois, setRois] = useState<Roi[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState("");

  const [status, setStatus] = useState<{ msg: string; err?: boolean } | null>(null);
  const [samBusy, setSamBusy] = useState(false);
  const [samReadyFor, setSamReadyFor] = useState<string | null>(null);

  const nativeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const W = cube?.header.samples ?? 512;
  const H = cube?.header.lines ?? 512;

  // ---- Build native-resolution canvas (for SAM) whenever base image changes ----
  useEffect(() => {
    if (!baseImage) {
      nativeCanvasRef.current = null;
      return;
    }
    const c = document.createElement("canvas");
    c.width = baseImage.width;
    c.height = baseImage.height;
    c.getContext("2d")!.putImageData(baseImage, 0, 0);
    nativeCanvasRef.current = c;
    sam.clearImage();
    setSamReadyFor(null);
  }, [baseImage]);

  // ---- Recompute RGB composite when cube or bands change ----
  useEffect(() => {
    if (!cube) return;
    try {
      setBaseImage(compositeRGB(cube, bands));
    } catch (e) {
      setStatus({ msg: `RGB 합성 실패: ${(e as Error).message}`, err: true });
    }
  }, [cube, bands]);

  // ---- File loading ----
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    const hdr = arr.find((f) => f.name.toLowerCase().endsWith(".hdr"));
    const dat =
      arr.find((f) => /reflectance.*\.(dat|img|raw)$/i.test(f.name)) ||
      arr.find((f) => /\.(dat|img|raw)$/i.test(f.name));
    if (!hdr || !dat) {
      setStatus({
        msg: ".hdr 파일과 데이터 파일(.dat / .raw / .img)을 함께 선택하세요.",
        err: true,
      });
      return;
    }
    setStatus({ msg: `${dat.name} 로딩 중… (${(dat.size / 1e6).toFixed(0)} MB)` });
    try {
      const [hdrText, buf] = await Promise.all([hdr.text(), dat.arrayBuffer()]);
      const name = dat.name.replace(/\.(dat|img|raw)$/i, "");
      const c = loadCube(hdrText, buf, name);
      setCube(c);
      setBaseName(name);
      setBands(c.header.defaultBands ?? [70, 53, 19]);
      setRois([]);
      setSelectedId(null);
      setStatus({
        msg: `로드 완료 · ${c.header.samples}×${c.header.lines} · ${c.header.bands} 밴드 · ${c.header.interleave.toUpperCase()}`,
      });
    } catch (e) {
      setStatus({ msg: (e as Error).message, err: true });
    }
  }, []);

  // ---- Lazily set the SAM image when entering SAM tool ----
  useEffect(() => {
    if (tool !== "sam" || !nativeCanvasRef.current || !cube) return;
    if (samReadyFor === baseName) return;
    let cancelled = false;
    (async () => {
      try {
        setSamBusy(true);
        setStatus({ msg: "SAM 준비 중… (모델 로딩 + 이미지 임베딩)" });
        await sam.setImage(nativeCanvasRef.current!);
        if (!cancelled) {
          setSamReadyFor(baseName);
          setStatus({ msg: "SAM 준비 완료 — 객체 위를 클릭하면 자동으로 따집니다." });
        }
      } catch (e) {
        if (!cancelled)
          setStatus({ msg: `SAM 로딩 실패: ${(e as Error).message}`, err: true });
      } finally {
        if (!cancelled) setSamBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tool, cube, baseName, samReadyFor]);

  const computeSpectrum = useCallback(
    (points: Point[]) => {
      if (!cube) return { spectrum: undefined, pixelCount: undefined };
      const { spectrum, pixelCount } = meanSpectrum(cube, points);
      return { spectrum, pixelCount };
    },
    [cube]
  );

  const addRoi = useCallback(
    (kind: ShapeKind, points: Point[]) => {
      const { spectrum, pixelCount } = computeSpectrum(points);
      const id = nextId();
      const color = PALETTE[(roiCounter - 1) % PALETTE.length];
      const roi: Roi = {
        id,
        kind,
        points,
        label: labelInput.trim() || kind,
        color,
        spectrum,
        pixelCount,
      };
      setRois((rs) => [...rs, roi]);
      setSelectedId(id);
    },
    [computeSpectrum, labelInput]
  );

  const handleSamClick = useCallback(
    async (p: Point) => {
      if (samBusy || samReadyFor !== baseName) return;
      try {
        setSamBusy(true);
        setStatus({ msg: "SAM 분할 중…" });
        const res = await sam.segment([p]);
        if (!res) throw new Error("마스크 없음");
        const poly = maskToPolygon(res.mask, res.width, res.height, 1.5);
        if (poly.length < 3) {
          setStatus({ msg: "분할 결과가 너무 작습니다. 다른 지점을 클릭해보세요.", err: true });
        } else {
          addRoi("polygon", poly);
          setStatus({ msg: `SAM 분할 완료 (${poly.length}개 꼭짓점)` });
        }
      } catch (e) {
        setStatus({ msg: `SAM 분할 실패: ${(e as Error).message}`, err: true });
      } finally {
        setSamBusy(false);
      }
    },
    [samBusy, samReadyFor, baseName, addRoi]
  );

  const moveVertex = useCallback(
    (roiId: string, index: number, p: Point) => {
      setRois((rs) =>
        rs.map((r) => {
          if (r.id !== roiId) return r;
          const points = r.points.slice();
          points[index] = p;
          return { ...r, points };
        })
      );
    },
    []
  );

  // Recompute spectrum after a vertex drag ends (selectedId-based, debounced-ish)
  const recomputeSelected = useCallback(() => {
    if (!selectedId || !cube) return;
    setRois((rs) =>
      rs.map((r) => {
        if (r.id !== selectedId) return r;
        const { spectrum, pixelCount } = meanSpectrum(cube, r.points);
        return { ...r, spectrum, pixelCount };
      })
    );
  }, [selectedId, cube]);

  const deleteRoi = useCallback((id: string) => {
    setRois((rs) => rs.filter((r) => r.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }, []);

  const selected = rois.find((r) => r.id === selectedId) || null;

  // Sync label input with selection
  useEffect(() => {
    setLabelInput(selected ? selected.label : "");
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyLabel = () => {
    if (!selected) return;
    setRois((rs) =>
      rs.map((r) => (r.id === selected.id ? { ...r, label: labelInput.trim() || r.kind } : r))
    );
  };

  // Delete key removes selected ROI
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId)
        deleteRoi(selectedId);
      if (e.key === "1") setTool("select");
      if (e.key === "2") setTool("polygon");
      if (e.key === "3") setTool("bbox");
      if (e.key === "4") setTool("sam");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, deleteRoi]);

  const wavelengths = cube?.header.wavelengths ?? [];
  const hasSpectra = rois.some((r) => r.spectrum);

  const tools: { id: Tool; name: string; key: string }[] = useMemo(
    () => [
      { id: "select", name: "선택/편집", key: "1" },
      { id: "polygon", name: "폴리곤", key: "2" },
      { id: "bbox", name: "박스", key: "3" },
      { id: "sam", name: "SAM 자동", key: "4" },
    ],
    []
  );

  return (
    <div className="app">
      <div className="topbar">
        <h1>충남농업기술원 · 초분광 ROI 추출기</h1>
        <span className="sub">Specim IQ · Polygon / BBox / SAM → 평균 반사율 CSV</span>
        <div className="spacer" />
        {cube && (
          <span className="sub">
            {baseName} · {W}×{H} · {cube.header.bands} bands
          </span>
        )}
      </div>

      {/* LEFT SIDEBAR */}
      <div className="sidebar">
        <div className="section">
          <h3>1. 데이터 불러오기</h3>
          <div
            className="dropzone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFiles(e.dataTransfer.files);
            }}
          >
            <div style={{ fontSize: 13 }}>.hdr + .dat 선택 / 드롭</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>
              results/REFLECTANCE_*.dat 와 .hdr를 함께
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".hdr,.dat,.raw,.img"
            style={{ display: "none" }}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {cube && (
          <div className="section">
            <h3>RGB 표시 밴드</h3>
            {(["R", "G", "B"] as const).map((ch, i) => (
              <div className="field" key={ch}>
                <label>
                  {ch} 밴드: {bands[i]} (
                  {wavelengths[bands[i] - 1]?.toFixed(0) ?? "?"} nm)
                </label>
                <input
                  type="range"
                  min={1}
                  max={cube.header.bands}
                  value={bands[i]}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    setBands((b) => {
                      const nb = [...b] as [number, number, number];
                      nb[i] = v;
                      return nb;
                    });
                  }}
                />
              </div>
            ))}
            <div className="row">
              <label className="hint">확대</label>
              <select value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))}>
                {[1, 1.5, 2, 3, 4].map((z) => (
                  <option key={z} value={z}>
                    {z}×
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="section">
          <h3>2. 도구</h3>
          <div className="tool-grid">
            {tools.map((t) => (
              <button
                key={t.id}
                className={tool === t.id ? "active" : ""}
                disabled={!cube}
                onClick={() => setTool(t.id)}
              >
                <span className="tname">{t.name}</span>
                <span className="tkey">[{t.key}]</span>
              </button>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            {tool === "polygon" &&
              "클릭으로 점 추가, 첫 점 클릭/더블클릭/Enter로 완성, Esc 취소."}
            {tool === "bbox" && "드래그하여 사각형 영역을 그립니다."}
            {tool === "sam" &&
              "객체 위를 클릭하면 SAM이 자동으로 영역을 따서 폴리곤으로 만듭니다."}
            {tool === "select" &&
              "ROI를 클릭해 선택, 꼭짓점을 드래그해 수정, Delete로 삭제."}
          </p>
        </div>

        <div className="section">
          <h3>다음 ROI 라벨</h3>
          <input
            placeholder="예: 잎, 병징, 배경…"
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onBlur={applyLabel}
            onKeyDown={(e) => e.key === "Enter" && applyLabel()}
            style={{ width: "100%" }}
          />
          {selected && (
            <button style={{ marginTop: 6, width: "100%" }} onClick={applyLabel}>
              선택된 ROI에 적용
            </button>
          )}
        </div>
      </div>

      {/* CENTER STAGE */}
      <div className="stage">
        {!cube ? (
          <div className="hint" style={{ maxWidth: 360, textAlign: "center" }}>
            왼쪽에서 Specim IQ 캡처의 <b>.hdr</b> 와 <b>.dat</b> 파일을 함께 선택하면
            영상이 표시됩니다.
            <br />
            <br />
            모든 처리는 브라우저 안에서만 이뤄지며 데이터는 서버로 전송되지 않습니다.
          </div>
        ) : (
          <AnnotationCanvas
            baseImage={baseImage}
            width={W}
            height={H}
            zoom={zoom}
            tool={tool}
            rois={rois}
            selectedId={selectedId}
            samBusy={samBusy}
            draftColor={PALETTE[roiCounter % PALETTE.length]}
            onCommitShape={addRoi}
            onSamClick={handleSamClick}
            onSelect={(id) => {
              setSelectedId(id);
              if (tool !== "select") return;
            }}
            onMoveVertex={(rid, idx, p) => {
              moveVertex(rid, idx, p);
            }}
          />
        )}
      </div>

      {/* RIGHT SIDEBAR */}
      <div className="sidebar right">
        <div className="section">
          <h3>ROI 목록 ({rois.length})</h3>
          {rois.length === 0 && <div className="hint">아직 ROI가 없습니다.</div>}
          {rois.map((r) => (
            <div
              key={r.id}
              className={`roi-item ${r.id === selectedId ? "sel" : ""}`}
              onClick={() => setSelectedId(r.id)}
            >
              <span className="roi-swatch" style={{ background: r.color }} />
              <span className="meta">
                <div className="lab">{r.label}</div>
                <div className="px">
                  {r.kind} · {r.pixelCount ?? 0} px
                </div>
              </span>
              <span
                className="x"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteRoi(r.id);
                }}
              >
                ✕
              </span>
            </div>
          ))}
          {selected && (
            <button
              style={{ marginTop: 6, width: "100%" }}
              onClick={recomputeSelected}
              title="꼭짓점 편집 후 스펙트럼 다시 계산"
            >
              선택 ROI 스펙트럼 재계산
            </button>
          )}
        </div>

        <div className="section">
          <h3>평균 반사율 스펙트럼</h3>
          <SpectrumChart wavelengths={wavelengths} rois={rois} highlightId={selectedId} />
        </div>

        <div className="section">
          <h3>3. 내보내기</h3>
          <div className="field">
            <button
              className="primary"
              disabled={!cube || !hasSpectra}
              onClick={() => exportSpectraCSV(cube!, rois, baseName)}
            >
              스펙트럼 CSV (wide)
            </button>
          </div>
          <div className="field">
            <button
              disabled={!cube || !hasSpectra}
              onClick={() => exportSpectraLongCSV(cube!, rois, baseName)}
            >
              스펙트럼 CSV (long)
            </button>
          </div>
          <div className="field">
            <button
              disabled={!cube || rois.length === 0}
              onClick={() => exportRoiJSON(cube!, rois, baseName)}
            >
              ROI 좌표 JSON
            </button>
          </div>
        </div>

        {status && (
          <div className={`status ${status.err ? "err" : ""}`}>{status.msg}</div>
        )}
      </div>
    </div>
  );
}
