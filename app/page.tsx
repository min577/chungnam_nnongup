"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AnnotationCanvas, { CanvasHandle, Tool } from "@/components/AnnotationCanvas";
import SpectrumChart from "@/components/SpectrumChart";
import { Cube, Point, Roi, ShapeKind } from "@/lib/types";
import {
  compositeRGB,
  compositeGray,
  compositeNDVI,
  nearestBand,
  loadCube,
  meanSpectrum,
} from "@/lib/envi";
import { calibrateCube } from "@/lib/calibrate";
import { maskToPolygon } from "@/lib/geometry";
import * as sam from "@/lib/sam";
import {
  exportImagePNG,
  exportRoiJSON,
  exportSpectraCSV,
  exportSpectraLongCSV,
  parseSpectraCSV,
} from "@/lib/csv";

type ViewMode = "rgb" | "gray" | "ndvi";

// One independent workspace per uploaded capture (shown as a tab).
type DocState = {
  cube: Cube | null;
  baseName: string;
  calib: "applied" | "pre" | "raw" | null;
  bands: [number, number, number];
  viewMode: ViewMode;
  grayBand: number;
  redBand: number;
  nirBand: number;
  rois: Roi[];
  selectedId: string | null;
  past: Roi[][];
  future: Roi[][];
  labelInput: string;
  zoom: number;
};

let tabCounter = 0;

const PALETTE = [
  "#2f81f7",
  "#12a150",
  "#db61a2",
  "#f0883e",
  "#a371f7",
  "#0ea5b7",
  "#e3b341",
  "#ef4444",
  "#16a34a",
  "#3b82f6",
];

let roiCounter = 0;
const nextId = () => `roi_${++roiCounter}`;

const ToolIcon = ({ id }: { id: Tool }) => {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (id) {
    case "select":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M5 4l6 15 2-6 6-2z" />
        </svg>
      );
    case "polygon":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M12 4l7 5-2.5 8.5h-9L5 9z" />
          <circle cx="12" cy="4" r="1.4" fill="currentColor" />
          <circle cx="19" cy="9" r="1.4" fill="currentColor" />
          <circle cx="5" cy="9" r="1.4" fill="currentColor" />
        </svg>
      );
    case "bbox":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <rect x="4.5" y="6" width="15" height="12" rx="1" strokeDasharray="3 2.5" />
        </svg>
      );
    case "sam":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
          <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />
        </svg>
      );
  }
};

export default function Page() {
  const [cube, setCube] = useState<Cube | null>(null);
  const [baseName, setBaseName] = useState("capture");
  const [bands, setBands] = useState<[number, number, number]>([70, 53, 19]);
  const [viewMode, setViewMode] = useState<ViewMode>("rgb");
  const [grayBand, setGrayBand] = useState(100);
  const [redBand, setRedBand] = useState(91);
  const [nirBand, setNirBand] = useState(135);
  const [baseImage, setBaseImage] = useState<ImageData | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [logoOk, setLogoOk] = useState(true);
  const panRef = useRef({ active: false, startX: 0, startY: 0, sl: 0, st: 0 });

  const [tool, setTool] = useState<Tool>("polygon");
  const [zoom, setZoom] = useState(1);
  const [rois, setRois] = useState<Roi[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState("");
  const [labelingId, setLabelingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const labelToastRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<{ msg: string; err?: boolean } | null>(null);
  const [calib, setCalib] = useState<"applied" | "pre" | "raw" | null>(null);
  const [samBusy, setSamBusy] = useState(false);
  const [samReadyFor, setSamReadyFor] = useState<string | null>(null);
  const [hasDraft, setHasDraft] = useState(false);

  // Undo / redo history (snapshots of the ROI list)
  const [past, setPast] = useState<Roi[][]>([]);
  const [future, setFuture] = useState<Roi[][]>([]);

  // Tabs: each upload is an independent document. Inactive docs are parked in
  // archiveRef; the live state above always mirrors the active tab.
  const [tabs, setTabs] = useState<{ id: string; name: string }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const archiveRef = useRef<Map<string, DocState>>(new Map());

  const roisRef = useRef<Roi[]>([]);
  useEffect(() => {
    roisRef.current = rois;
  }, [rois]);
  const pushHistory = useCallback(() => {
    setPast((p) => [...p.slice(-49), roisRef.current]);
    setFuture([]); // a new action invalidates the redo stack
  }, []);
  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [roisRef.current, ...f].slice(0, 50));
      setRois(prev);
      setSelectedId((s) => (prev.some((r) => r.id === s) ? s : null));
      return p.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p.slice(-49), roisRef.current]);
      setRois(next);
      setSelectedId((s) => (next.some((r) => r.id === s) ? s : null));
      return f.slice(1);
    });
  }, []);

  // ---- Tab document management ----
  const captureLive = (): DocState => ({
    cube,
    baseName,
    calib,
    bands,
    viewMode,
    grayBand,
    redBand,
    nirBand,
    rois,
    selectedId,
    past,
    future,
    labelInput,
    zoom,
  });
  const applyDoc = (d: DocState) => {
    setCube(d.cube);
    setBaseName(d.baseName);
    setCalib(d.calib);
    setBands(d.bands);
    setViewMode(d.viewMode);
    setGrayBand(d.grayBand);
    setRedBand(d.redBand);
    setNirBand(d.nirBand);
    setRois(d.rois);
    setSelectedId(d.selectedId);
    setPast(d.past);
    setFuture(d.future);
    setLabelInput(d.labelInput);
    setZoom(d.zoom);
    setLabelingId(null);
  };
  const resetLive = () => {
    setCube(null);
    setBaseName("capture");
    setCalib(null);
    setRois([]);
    setSelectedId(null);
    setPast([]);
    setFuture([]);
    setLabelInput("");
    setLabelingId(null);
    setBaseImage(null);
  };
  const switchTab = (id: string) => {
    if (id === activeId) return;
    if (activeId) archiveRef.current.set(activeId, captureLive());
    const d = archiveRef.current.get(id);
    archiveRef.current.delete(id);
    if (d) applyDoc(d);
    setActiveId(id);
    if (!fittedRef.current.has(id)) {
      fittedRef.current.add(id);
      setTimeout(fitZoom, 30);
    }
  };
  const closeTab = (id: string) => {
    archiveRef.current.delete(id);
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    if (id === activeId) {
      if (next.length === 0) {
        resetLive();
        setActiveId(null);
      } else {
        const fb = next[Math.min(idx, next.length - 1)];
        const d = archiveRef.current.get(fb.id);
        archiveRef.current.delete(fb.id);
        if (d) applyDoc(d);
        setActiveId(fb.id);
      }
    }
    setTabs(next);
  };

  const nativeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasApi = useRef<CanvasHandle>(null);
  const fittedRef = useRef<Set<string>>(new Set());

  // Enable directory picking on the folder input (non-standard attribute)
  useEffect(() => {
    const el = folderInputRef.current;
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  }, []);

  const W = cube?.header.samples ?? 512;
  const H = cube?.header.lines ?? 512;

  const fitZoom = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const pad = 56;
    const zw = (el.clientWidth - pad) / W;
    const zh = (el.clientHeight - pad) / H;
    const z = Math.max(0.25, Math.min(6, Math.min(zw, zh)));
    setZoom(Math.round(z * 20) / 20);
  }, [W, H]);

  // Reset RGB / gray / NDVI band selections to their defaults for the current cube
  const resetBands = useCallback(() => {
    if (!cube) return;
    const wl = cube.header.wavelengths;
    setBands(cube.header.defaultBands ?? [70, 53, 19]);
    setGrayBand(wl.length ? nearestBand(wl, 700) : Math.round(cube.header.bands / 2));
    setRedBand(nearestBand(wl, 670));
    setNirBand(nearestBand(wl, 800));
    setStatus({ msg: "표시 밴드를 기본값으로 초기화했습니다." });
  }, [cube]);

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

  // ---- Recompute the displayed composite when cube / mode / bands change ----
  useEffect(() => {
    if (!cube) {
      setBaseImage(null);
      return;
    }
    try {
      if (viewMode === "gray") setBaseImage(compositeGray(cube, grayBand));
      else if (viewMode === "ndvi")
        setBaseImage(compositeNDVI(cube, redBand, nirBand));
      else setBaseImage(compositeRGB(cube, bands));
    } catch (e) {
      setStatus({ msg: `영상 합성 실패: ${(e as Error).message}`, err: true });
    }
  }, [cube, viewMode, bands, grayBand, redBand, nirBand]);

  // ---- Build a default workspace from a freshly-loaded cube ----
  const makeDoc = (
    finalCube: Cube,
    name: string,
    mode: "applied" | "pre" | "raw"
  ): DocState => {
    const wl = finalCube.header.wavelengths;
    return {
      cube: finalCube,
      baseName: name,
      calib: mode,
      bands: finalCube.header.defaultBands ?? [70, 53, 19],
      viewMode: "rgb",
      grayBand: wl.length ? nearestBand(wl, 700) : Math.round(finalCube.header.bands / 2),
      redBand: nearestBand(wl, 670),
      nirBand: nearestBand(wl, 800),
      rois: [],
      selectedId: null,
      past: [],
      future: [],
      labelInput: "",
      zoom: 1,
    };
  };

  // ---- Load one capture (sample + optional white/dark) into a reflectance cube ----
  const loadCapture = async (
    groupFiles: File[]
  ): Promise<{ cube: Cube; name: string; mode: "applied" | "pre" | "raw" }> => {
    const hdrs = groupFiles.filter((f) => /\.hdr$/i.test(f.name));
    const datas = groupFiles.filter((f) => /\.(dat|img|raw)$/i.test(f.name));
    const hdrFor = (data: File) => {
      const base = data.name.replace(/\.(dat|img|raw)$/i, "").toLowerCase();
      return hdrs.find((h) => h.name.replace(/\.hdr$/i, "").toLowerCase() === base);
    };
    const maxBySize = (fs: File[]) =>
      fs.length ? fs.reduce((a, b) => (b.size > a.size ? b : a)) : undefined;

    const isRef = (f: File) => /WHITEREF|DARKREF/i.test(f.name);
    const whiteData = datas.find((f) => /WHITEREF/i.test(f.name));
    const darkData = datas.find((f) => /DARKREF/i.test(f.name));
    const candidates = datas.filter((f) => !isRef(f));
    const rawCandidates =
      whiteData && darkData
        ? candidates.filter((f) => !/reflectance/i.test(f.name))
        : [];
    const sampleData = maxBySize(rawCandidates.length ? rawCandidates : candidates);
    if (!sampleData || !hdrFor(sampleData))
      throw new Error("데이터(.dat/.raw/.img)와 같은 이름의 .hdr가 필요합니다.");

    const canCalibrate =
      whiteData && darkData && hdrFor(whiteData) && hdrFor(darkData);
    const name = sampleData.name.replace(/\.(dat|img|raw)$/i, "");

    const sampleCube = loadCube(
      await hdrFor(sampleData)!.text(),
      await sampleData.arrayBuffer(),
      name
    );
    let finalCube = sampleCube;
    let mode: "applied" | "pre" | "raw";
    if (canCalibrate) {
      const whiteCube = loadCube(
        await hdrFor(whiteData!)!.text(),
        await whiteData!.arrayBuffer(),
        "white"
      );
      const darkCube = loadCube(
        await hdrFor(darkData!)!.text(),
        await darkData!.arrayBuffer(),
        "dark"
      );
      finalCube = calibrateCube(sampleCube, whiteCube, darkCube);
      mode = "applied";
    } else if (/reflectance/i.test(sampleData.name) || sampleCube.header.dataType === 4) {
      mode = "pre";
    } else {
      mode = "raw";
    }
    return { cube: finalCube, name, mode };
  };

  // ---- File loading: groups selected files into captures, one image each ----
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const arr = Array.from(files).filter((f) => /\.(hdr|dat|img|raw)$/i.test(f.name));
    if (!arr.length) {
      setStatus({ msg: ".hdr / .dat / .raw / .img 파일을 선택하세요.", err: true });
      return;
    }

    // Group by capture token in the filename (WHITEREF_/DARKREF_/REFLECTANCE_ stripped)
    const captureKey = (name: string) =>
      name
        .replace(/\.(dat|img|raw|hdr)$/i, "")
        .replace(/^(whiteref|darkref|reflectance|rgbscene|rgbbackground|rgbviewfinder)[_-]?/i, "")
        .toLowerCase();
    const groups = new Map<string, File[]>();
    for (const f of arr) {
      const k = captureKey(f.name);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
    }
    const groupList = [...groups.values()];

    const prevDoc = activeId ? captureLive() : null;
    setStatus({
      msg:
        groupList.length > 1
          ? `${groupList.length}개 이미지 로딩 중…`
          : "로딩 중…",
    });

    const loaded: { cube: Cube; name: string; mode: "applied" | "pre" | "raw" }[] = [];
    let failures = 0;
    for (const g of groupList) {
      try {
        loaded.push(await loadCapture(g));
      } catch {
        failures += 1;
      }
    }
    if (!loaded.length) {
      setStatus({ msg: "불러올 수 있는 이미지가 없습니다. .hdr와 데이터 파일을 함께 선택하세요.", err: true });
      return;
    }

    if (activeId && prevDoc) archiveRef.current.set(activeId, prevDoc);
    const newTabs: { id: string; name: string }[] = [];
    let firstId: string | null = null;
    loaded.forEach((cap, i) => {
      const id = `tab_${++tabCounter}`;
      newTabs.push({ id, name: cap.name });
      const doc = makeDoc(cap.cube, cap.name, cap.mode);
      if (i === 0) {
        firstId = id;
        applyDoc(doc);
        fittedRef.current.add(id);
      } else {
        archiveRef.current.set(id, doc);
      }
    });
    setTabs((t) => [...t, ...newTabs]);
    if (firstId) setActiveId(firstId);

    const calApplied = loaded.filter((l) => l.mode === "applied").length;
    const calRaw = loaded.filter((l) => l.mode === "raw").length;
    setStatus({
      msg:
        `${loaded.length}개 이미지 로드 완료` +
        (calApplied ? ` · ${calApplied}개 반사율 보정됨` : "") +
        (calRaw ? ` · ${calRaw}개 원시 DN(보정 안 됨)` : "") +
        (failures ? ` · ${failures}개 실패` : ""),
      err: calRaw > 0,
    });
    setTimeout(fitZoom, 30);
  };

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

  const addRoi = useCallback(
    (kind: ShapeKind, points: Point[]) => {
      if (!cube) return;
      pushHistory();
      const { spectrum, pixelCount } = meanSpectrum(cube, points);
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
      setLabelingId(id); // open the top-left label toast for this ROI
    },
    [cube, labelInput, pushHistory]
  );

  // Focus + select the label toast when it opens
  useEffect(() => {
    if (labelingId && labelToastRef.current) {
      labelToastRef.current.focus();
      labelToastRef.current.select();
    }
  }, [labelingId]);

  // Live-apply the typed label to the ROI being named and keep it as the sticky default
  const setLabelLive = useCallback(
    (value: string) => {
      setLabelInput(value);
      if (!labelingId) return;
      setRois((rs) =>
        rs.map((r) =>
          r.id === labelingId ? { ...r, label: value.trim() || r.kind } : r
        )
      );
    },
    [labelingId]
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
          setStatus({
            msg: "분할 결과가 너무 작습니다. 다른 지점을 클릭해보세요.",
            err: true,
          });
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

  const moveVertex = useCallback((roiId: string, index: number, p: Point) => {
    setRois((rs) =>
      rs.map((r) => {
        if (r.id !== roiId) return r;
        const points = r.points.slice();
        points[index] = p;
        return { ...r, points };
      })
    );
  }, []);

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

  const deleteRoi = useCallback(
    (id: string) => {
      pushHistory();
      setRois((rs) => rs.filter((r) => r.id !== id));
      setSelectedId((s) => (s === id ? null : s));
    },
    [pushHistory]
  );

  // ---- Re-import previously exported ROI CSV and re-draw the annotations ----
  const importRoiCSV = async (files: FileList | null) => {
    if (!files || !files.length) return;
    if (!cube) {
      setStatus({ msg: "먼저 초분광 영상을 연 뒤 CSV를 불러오세요.", err: true });
      return;
    }
    try {
      const parsed = parseSpectraCSV(await files[0].text());
      if (!parsed.length) {
        setStatus({ msg: "CSV에서 ROI를 찾지 못했습니다.", err: true });
        return;
      }
      pushHistory();
      const imported: Roi[] = parsed.map((p, i) => ({
        id: p.id || nextId(),
        kind: p.kind,
        points: p.points,
        label: p.label || p.kind,
        color: PALETTE[i % PALETTE.length],
        // prefer recomputing from the current cube; fall back to CSV spectrum
        ...(() => {
          const { spectrum, pixelCount } = meanSpectrum(cube, p.points);
          return spectrum ? { spectrum, pixelCount } : { spectrum: p.spectrum, pixelCount: p.pixelCount };
        })(),
      }));
      // keep id counter ahead of any imported numeric ids
      for (const p of parsed) {
        const m = /(\d+)$/.exec(p.id || "");
        if (m) roiCounter = Math.max(roiCounter, parseInt(m[1], 10));
      }
      setRois(imported);
      setSelectedId(null);
      setStatus({ msg: `${imported.length}개 ROI를 CSV에서 불러와 표시했습니다.` });
    } catch (e) {
      setStatus({ msg: `CSV 불러오기 실패: ${(e as Error).message}`, err: true });
    }
  };

  const startRename = (r: Roi) => {
    setEditingId(r.id);
    setEditingValue(r.label);
  };
  const commitRename = () => {
    if (!editingId) return;
    const val = editingValue.trim();
    pushHistory();
    setRois((rs) =>
      rs.map((r) => (r.id === editingId ? { ...r, label: val || r.kind } : r))
    );
    setEditingId(null);
  };

  const selected = rois.find((r) => r.id === selectedId) || null;

  useEffect(() => {
    setLabelInput(selected ? selected.label : "");
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyLabel = () => {
    if (!selected) return;
    pushHistory();
    setRois((rs) =>
      rs.map((r) =>
        r.id === selected.id ? { ...r, label: labelInput.trim() || r.kind } : r
      )
    );
  };

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      // Ctrl/Cmd +/- : zoom the image (override browser page zoom), Ctrl+0 : fit
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          setZoom((z) => Math.min(6, +(z + 0.25).toFixed(2)));
          return;
        }
        if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)));
          return;
        }
        if (e.key === "0") {
          e.preventDefault();
          fitZoom();
          return;
        }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId)
        deleteRoi(selectedId);
      if (!e.ctrlKey && !e.metaKey) {
        if (e.key === "1") setTool("select");
        if (e.key === "2") setTool("polygon");
        if (e.key === "3") setTool("bbox");
        if (e.key === "4") setTool("sam");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, deleteRoi, undo, redo, fitZoom]);

  // Space-bar + drag to pan the image
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      e.preventDefault();
      setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setSpaceHeld(false);
        panRef.current.active = false;
      }
    };
    const move = (e: MouseEvent) => {
      const p = panRef.current;
      if (!p.active || !stageRef.current) return;
      stageRef.current.scrollLeft = p.sl - (e.clientX - p.startX);
      stageRef.current.scrollTop = p.st - (e.clientY - p.startY);
    };
    const mouseUp = () => {
      panRef.current.active = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", mouseUp);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", mouseUp);
    };
  }, []);

  // Ctrl + mouse wheel (and trackpad pinch) to zoom the image
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain wheel scrolls normally
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((z) => Math.max(0.25, Math.min(6, +(z * factor).toFixed(2))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const startPan = (e: React.MouseEvent) => {
    if (!spaceHeld || !stageRef.current) return;
    panRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      sl: stageRef.current.scrollLeft,
      st: stageRef.current.scrollTop,
    };
  };

  const wavelengths = cube?.header.wavelengths ?? [];
  const hasSpectra = rois.some((r) => r.spectrum);

  const tools: { id: Tool; name: string; key: string }[] = useMemo(
    () => [
      { id: "select", name: "선택·편집", key: "1" },
      { id: "polygon", name: "폴리곤", key: "2" },
      { id: "bbox", name: "박스", key: "3" },
      { id: "sam", name: "SAM 자동", key: "4" },
    ],
    []
  );

  const cancelDraw = () => canvasApi.current?.cancelDraft();

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          {logoOk ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="logo"
              src="/logo-cnaes.png"
              alt="충청남도농업기술원"
              onError={() => setLogoOk(false)}
            />
          ) : (
            <div className="mark" />
          )}
          <div className="titles">
            <h1>초분광 ROI 추출기</h1>
            <p>충청남도농업기술원 · Specim IQ 반사율 분석 (Polygon / BBox / SAM)</p>
          </div>
          <div className="affil" title="개발: AGIS Lab · 경희대학교">
            {/* eslint-disable @next/next/no-img-element */}
            <img
              className="affil-logo"
              src="/logo-agis.png"
              alt="AGIS Lab"
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
            <img
              className="affil-logo"
              src="/logo-khu.png"
              alt="경희대학교"
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
            {/* eslint-enable @next/next/no-img-element */}
          </div>
        </div>

        <div className="spacer" />
        {cube && (
          <span className="meta-chip">
            {baseName} · {W}×{H} · {cube.header.bands} bands ·{" "}
            {cube.header.wavelengths.length
              ? `${Math.round(cube.header.wavelengths[0])}–${Math.round(
                  cube.header.wavelengths[cube.header.wavelengths.length - 1]
                )} nm`
              : ""}
          </span>
        )}
      </div>

      {/* LEFT SIDEBAR */}
      <aside className="sidebar left">
        <div className="panel">
          <h3>
            <span className="step">1</span> 데이터 불러오기
          </h3>
          <div
            className="dropzone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFiles(e.dataTransfer.files);
            }}
          >
            <div className="dz-title">파일 선택 / 드롭</div>
            <div className="dz-sub">
              capture의 robot_*.raw + WHITEREF + DARKREF (+각 .hdr) → 반사율 자동 보정
            </div>
          </div>
          <button
            className="block"
            style={{ marginTop: 8 }}
            onClick={() => folderInputRef.current?.click()}
          >
            📁 캡처 폴더 통째로 선택
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".hdr,.dat,.raw,.img"
            style={{ display: "none" }}
            onChange={(e) => handleFiles(e.target.files)}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => handleFiles(e.target.files)}
          />
          {calib && (
            <div className={`calib-badge ${calib}`}>
              <span className="ic">
                {calib === "applied" ? "✓" : calib === "pre" ? "ℹ" : "⚠"}
              </span>
              <span>
                {calib === "applied" &&
                  "WHITE/DARK 반사율 보정 적용됨 — 스펙트럼이 0–1 반사율 단위입니다."}
                {calib === "pre" &&
                  "이미 반사율(REFLECTANCE) 데이터입니다 — 추가 보정 불필요."}
                {calib === "raw" &&
                  "원시 DN입니다 — WHITEREF/DARKREF를 함께 올려야 식물 반사율이 나옵니다."}
              </span>
            </div>
          )}
        </div>

        {cube && (
          <div className="panel">
            <h3>표시 모드</h3>
            <div className="seg">
              {(
                [
                  ["rgb", "RGB"],
                  ["gray", "그레이"],
                  ["ndvi", "NDVI"],
                ] as [ViewMode, string][]
              ).map(([m, lbl]) => (
                <button
                  key={m}
                  className={viewMode === m ? "active" : ""}
                  onClick={() => setViewMode(m)}
                >
                  {lbl}
                </button>
              ))}
            </div>

            {viewMode === "rgb" &&
              (["R", "G", "B"] as const).map((ch, i) => (
                <div className="field" key={ch}>
                  <label>
                    <span>{ch} 밴드</span>
                    <span className="val">
                      #{bands[i]} · {wavelengths[bands[i] - 1]?.toFixed(0) ?? "?"} nm
                    </span>
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

            {viewMode === "gray" && (
              <div className="field">
                <label>
                  <span>밴드</span>
                  <span className="val">
                    #{grayBand} · {wavelengths[grayBand - 1]?.toFixed(0) ?? "?"} nm
                  </span>
                </label>
                <input
                  type="range"
                  min={1}
                  max={cube.header.bands}
                  value={grayBand}
                  onChange={(e) => setGrayBand(parseInt(e.target.value, 10))}
                />
              </div>
            )}

            {viewMode === "ndvi" && (
              <>
                <div className="field">
                  <label>
                    <span>Red 밴드</span>
                    <span className="val">
                      #{redBand} · {wavelengths[redBand - 1]?.toFixed(0) ?? "?"} nm
                    </span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={cube.header.bands}
                    value={redBand}
                    onChange={(e) => setRedBand(parseInt(e.target.value, 10))}
                  />
                </div>
                <div className="field">
                  <label>
                    <span>NIR 밴드</span>
                    <span className="val">
                      #{nirBand} · {wavelengths[nirBand - 1]?.toFixed(0) ?? "?"} nm
                    </span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={cube.header.bands}
                    value={nirBand}
                    onChange={(e) => setNirBand(parseInt(e.target.value, 10))}
                  />
                </div>
                <div className="ndvi-legend">
                  <span>낮음</span>
                  <span className="ramp" />
                  <span>높음(식생)</span>
                </div>
                <p className="hint">NDVI = (NIR − Red) / (NIR + Red) · 잎은 0.6–0.9</p>
              </>
            )}

            <button className="block" style={{ margin: "2px 0 12px" }} onClick={resetBands}>
              ↺ 표시 밴드 기본값으로 초기화
            </button>

            <div className="field" style={{ marginTop: 4 }}>
              <label>
                <span>확대</span>
                <span className="val">{Math.round(zoom * 100)}%</span>
              </label>
              <div className="btn-row">
                <button onClick={fitZoom} title="화면에 맞춤 (Ctrl+0)">
                  맞춤
                </button>
                <button
                  onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))}
                  title="축소 (Ctrl+−)"
                >
                  −
                </button>
                <button
                  onClick={() => setZoom((z) => Math.min(6, +(z + 0.25).toFixed(2)))}
                  title="확대 (Ctrl+＋)"
                >
                  ＋
                </button>
              </div>
              <p className="hint" style={{ marginTop: 6 }}>
                Ctrl + 휠/＋/− 확대·축소 · Space + 드래그 이동
              </p>
            </div>

            <button
              className="block"
              disabled={!baseImage}
              onClick={() =>
                baseImage && exportImagePNG(baseImage, `${baseName}_${viewMode}.png`)
              }
            >
              🖼 현재 화면 이미지 저장 (PNG)
            </button>
          </div>
        )}

        <div className="panel">
          <h3>
            <span className="step">2</span> 도구
          </h3>
          <div className="tool-grid">
            {tools.map((t) => (
              <button
                key={t.id}
                className={`tool ${tool === t.id ? "active" : ""}`}
                disabled={!cube}
                onClick={() => setTool(t.id)}
              >
                <ToolIcon id={t.id} />
                <span className="tname">{t.name}</span>
                <span className="tkey">{t.key}</span>
              </button>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 12 }}>
            {tool === "polygon" && (
              <>
                클릭으로 점 추가 → <b>우클릭·더블클릭·Enter</b> 또는 첫 점(초록 원)을 클릭해
                완성, Esc 취소.
              </>
            )}
            {tool === "bbox" && <>드래그하여 사각형 영역을 그립니다.</>}
            {tool === "sam" && (
              <>
                객체 위를 <b>클릭</b>하면 SAM이 자동으로 영역을 따 폴리곤으로 만듭니다.
              </>
            )}
            {tool === "select" && (
              <>
                ROI 클릭해 선택, <b>꼭짓점 드래그</b>로 수정, Delete로 삭제.
              </>
            )}
          </p>
        </div>

        <div className="panel">
          <h3>고정 라벨</h3>
          <input
            type="text"
            placeholder="예: 잎, 병징, 배경…"
            value={labelInput}
            onChange={(e) => setLabelLive(e.target.value)}
            onBlur={applyLabel}
            onKeyDown={(e) => e.key === "Enter" && applyLabel()}
            style={{ width: "100%" }}
          />
          <p className="hint" style={{ marginTop: 8 }}>
            새 라벨을 입력하기 전까지 이 라벨이 <b>다음 ROI들에 계속 적용</b>됩니다.
          </p>
          {selected && (
            <button className="block" style={{ marginTop: 8 }} onClick={applyLabel}>
              선택된 ROI에 적용
            </button>
          )}
        </div>

      </aside>

      {/* CENTER STAGE */}
      <main
        className="stage"
        ref={stageRef}
        onMouseDown={startPan}
        style={{ cursor: spaceHeld ? "grab" : undefined }}
      >
        {cube && (
          <div className="stage-actions">
            {tabs.length > 0 &&
              (() => {
                const idx = tabs.findIndex((t) => t.id === activeId);
                return (
                  <div className="img-nav">
                    <button
                      className="nav-btn"
                      title="이전 이미지"
                      disabled={idx <= 0}
                      onClick={() => idx > 0 && switchTab(tabs[idx - 1].id)}
                    >
                      ◀
                    </button>
                    <span className="nav-count">
                      {idx + 1} / {tabs.length}
                    </span>
                    <button
                      className="nav-btn"
                      title="다음 이미지"
                      disabled={idx >= tabs.length - 1}
                      onClick={() =>
                        idx < tabs.length - 1 && switchTab(tabs[idx + 1].id)
                      }
                    >
                      ▶
                    </button>
                    <button
                      className="nav-btn nav-close"
                      title="현재 이미지 닫기"
                      onClick={() => activeId && closeTab(activeId)}
                    >
                      ✕
                    </button>
                  </div>
                );
              })()}
            <button onClick={undo} disabled={past.length === 0} title="되돌리기 (Ctrl+Z)">
              ↩ 되돌리기
            </button>
            <button
              onClick={redo}
              disabled={future.length === 0}
              title="다시 실행 (Ctrl+Shift+Z / Ctrl+Y)"
            >
              ↪ 다시 실행
            </button>
            {hasDraft && (
              <button className="cta" onClick={cancelDraw}>
                ✕ 그리기 취소
              </button>
            )}
          </div>
        )}

        {labelingId && (
          <div className="label-toast">
            <span className="lt-title">ROI 이름</span>
            <input
              ref={labelToastRef}
              type="text"
              value={labelInput}
              placeholder="예: 잎, 병징, 배경…"
              onChange={(e) => setLabelLive(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  setLabelingId(null);
                }
              }}
            />
            <button className="lt-ok" onClick={() => setLabelingId(null)}>
              확인
            </button>
          </div>
        )}

        {!cube ? (
          <div className="stage-empty">
            <div className="big">초분광 영상을 불러오세요</div>
            왼쪽에서 Specim IQ <b style={{ color: "#cdd6e2" }}>capture 폴더</b>를 선택하면
            (robot_*.raw + WHITEREF + DARKREF) 자동으로 반사율 보정 후 표시됩니다.
            <br />
            이미 보정된 <b style={{ color: "#cdd6e2" }}>REFLECTANCE</b> 파일도 바로 열 수
            있습니다.
            <div className="lock">🔒 모든 처리는 브라우저 안에서만 이뤄집니다</div>
          </div>
        ) : (
          <AnnotationCanvas
            ref={canvasApi}
            baseImage={baseImage}
            width={W}
            height={H}
            zoom={zoom}
            tool={tool}
            rois={rois}
            selectedId={selectedId}
            samBusy={samBusy}
            panMode={spaceHeld}
            draftColor={PALETTE[roiCounter % PALETTE.length]}
            onCommitShape={addRoi}
            onSamClick={handleSamClick}
            onSelect={setSelectedId}
            onMoveVertex={moveVertex}
            onDraftChange={setHasDraft}
            onVertexDragStart={pushHistory}
          />
        )}

        {hasDraft && tool === "polygon" && (
          <div className="draw-badge">
            점을 계속 찍고 → <b>우클릭/더블클릭/Enter</b> 또는 첫 점을 클릭해 닫기
          </div>
        )}

        {samBusy && (
          <div className="busy-veil">
            <div className="busy-card">
              <span className="spinner" />
              SAM 처리 중…
            </div>
          </div>
        )}
      </main>

      {/* RIGHT SIDEBAR */}
      <aside className="sidebar right">
        <div className="panel">
          <h3>
            ROI 목록 <span className="count">{rois.length}개</span>
          </h3>
          {rois.length === 0 ? (
            <div className="empty">아직 ROI가 없습니다.</div>
          ) : (
            rois.map((r) => (
              <div
                key={r.id}
                className={`roi-item ${r.id === selectedId ? "sel" : ""}`}
                onClick={() => setSelectedId(r.id)}
              >
                <span className="roi-swatch" style={{ background: r.color }} />
                <span className="meta">
                  {editingId === r.id ? (
                    <input
                      className="roi-rename"
                      autoFocus
                      value={editingValue}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <div
                      className="lab"
                      title="더블클릭하여 이름 수정"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(r);
                      }}
                    >
                      {r.label}
                    </div>
                  )}
                  <div className="px">
                    {r.kind} · {r.pixelCount ?? 0} px
                  </div>
                </span>
                <span
                  className="x"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(r);
                  }}
                  title="이름 수정"
                >
                  ✎
                </span>
                <span
                  className="x"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteRoi(r.id);
                  }}
                  title="삭제"
                >
                  ✕
                </span>
              </div>
            ))
          )}
          {selected && (
            <button
              className="block"
              style={{ marginTop: 8 }}
              onClick={recomputeSelected}
              title="꼭짓점 편집 후 스펙트럼 다시 계산"
            >
              선택 ROI 스펙트럼 재계산
            </button>
          )}
        </div>

        <div className="panel">
          <h3>평균 반사율 스펙트럼</h3>
          <SpectrumChart wavelengths={wavelengths} rois={rois} highlightId={selectedId} />
        </div>

        <div className="panel">
          <h3>
            <span className="step">3</span> 내보내기
          </h3>
          <div className="field">
            <button
              className="primary block"
              disabled={!cube || !hasSpectra}
              onClick={() => exportSpectraCSV(cube!, rois, baseName)}
            >
              스펙트럼 CSV (wide)
            </button>
          </div>
          <div className="btn-row" style={{ marginBottom: 0 }}>
            <button
              disabled={!cube || !hasSpectra}
              onClick={() => exportSpectraLongCSV(cube!, rois, baseName)}
            >
              CSV (long)
            </button>
            <button
              disabled={!cube || rois.length === 0}
              onClick={() => exportRoiJSON(cube!, rois, baseName)}
            >
              ROI JSON
            </button>
          </div>
          <button
            className="block"
            style={{ marginTop: 8 }}
            disabled={!cube}
            onClick={() => csvInputRef.current?.click()}
            title="이전에 내보낸 spectra CSV를 불러와 ROI를 다시 표시"
          >
            ⤓ ROI CSV 불러오기
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv"
            style={{ display: "none" }}
            onChange={(e) => {
              importRoiCSV(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {status && (
          <div className={`status ${status.err ? "err" : ""}`}>
            <span className="dot" />
            <span>{status.msg}</span>
          </div>
        )}
      </aside>
    </div>
  );
}
