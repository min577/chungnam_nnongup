"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Point, Roi, ShapeKind } from "@/lib/types";
import { pointInPolygon } from "@/lib/envi";
import { bboxPoints } from "@/lib/geometry";

export type Tool = "select" | "polygon" | "bbox" | "sam";

export interface CanvasHandle {
  cancelDraft: () => void;
  hasDraft: () => boolean;
}

interface Props {
  baseImage: ImageData | null;
  width: number;
  height: number;
  zoom: number;
  tool: Tool;
  rois: Roi[];
  selectedId: string | null;
  samBusy: boolean;
  panMode: boolean;
  draftColor: string;
  onCommitShape: (kind: ShapeKind, points: Point[]) => void;
  onSamClick: (p: Point) => void;
  onSelect: (id: string | null) => void;
  onMoveVertex: (roiId: string, index: number, p: Point) => void;
  onDraftChange?: (active: boolean) => void;
  onVertexDragStart?: () => void;
}

const VERTEX_HIT = 6; // image px
// Distance (in image px) within which clicking the first vertex closes the
// polygon. Defined in *screen* px so it stays easy to hit at any zoom level.
const closeThreshImg = (zoom: number) => 14 / zoom;

const AnnotationCanvas = forwardRef<CanvasHandle, Props>(function AnnotationCanvas(
  {
    baseImage,
    width,
    height,
    zoom,
    tool,
    rois,
    selectedId,
    samBusy,
    panMode,
    draftColor,
    onCommitShape,
    onSamClick,
    onSelect,
    onMoveVertex,
    onDraftChange,
    onVertexDragStart,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);

  const [draftPoly, setDraftPoly] = useState<Point[]>([]);
  const [bboxStart, setBboxStart] = useState<Point | null>(null);
  const [mouse, setMouse] = useState<Point | null>(null);
  const [dragVertex, setDragVertex] = useState<{ roiId: string; index: number } | null>(
    null
  );

  const cancelDraft = useCallback(() => {
    setDraftPoly([]);
    setBboxStart(null);
  }, []);

  useImperativeHandle(ref, () => ({
    cancelDraft,
    hasDraft: () => draftPoly.length > 0 || bboxStart != null,
  }));

  // Report draft activity to the parent (for the floating cancel button)
  useEffect(() => {
    onDraftChange?.(draftPoly.length > 0 || bboxStart != null);
  }, [draftPoly, bboxStart, onDraftChange]);

  // Build offscreen native-resolution canvas from baseImage
  useEffect(() => {
    if (!baseImage) {
      offscreenRef.current = null;
      return;
    }
    const off = document.createElement("canvas");
    off.width = baseImage.width;
    off.height = baseImage.height;
    off.getContext("2d")!.putImageData(baseImage, 0, 0);
    offscreenRef.current = off;
  }, [baseImage]);

  // Reset transient drafts when tool changes
  useEffect(() => {
    setDraftPoly([]);
    setBboxStart(null);
  }, [tool]);

  const toImage = useCallback(
    (e: React.MouseEvent): Point => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const x = (e.clientX - rect.left) / zoom;
      const y = (e.clientY - rect.top) / zoom;
      return {
        x: Math.max(0, Math.min(width - 0.001, x)),
        y: Math.max(0, Math.min(height - 0.001, y)),
      };
    },
    [zoom, width, height]
  );

  // ---- Rendering ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (offscreenRef.current) {
      ctx.drawImage(offscreenRef.current, 0, 0, width * zoom, height * zoom);
    } else {
      ctx.fillStyle = "#10151c";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const sx = (v: number) => v * zoom;

    const drawShape = (pts: Point[], color: string, selected: boolean) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(sx(pts[0].x), sx(pts[0].y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i].x), sx(pts[i].y));
      ctx.closePath();
      ctx.fillStyle = color + "26";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.stroke();
      if (selected) {
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(sx(p.x), sx(p.y), 4.5, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    };

    for (const r of rois) drawShape(r.points, r.color, r.id === selectedId);

    // Draft polygon
    if (draftPoly.length > 0) {
      const first = draftPoly[0];
      const nearFirst =
        draftPoly.length >= 3 &&
        mouse != null &&
        Math.hypot(first.x - mouse.x, first.y - mouse.y) <= closeThreshImg(zoom);

      ctx.beginPath();
      ctx.moveTo(sx(draftPoly[0].x), sx(draftPoly[0].y));
      for (let i = 1; i < draftPoly.length; i++)
        ctx.lineTo(sx(draftPoly[i].x), sx(draftPoly[i].y));
      if (mouse) {
        // snap the rubber-band end to the first point when it would close
        const end = nearFirst ? first : mouse;
        ctx.lineTo(sx(end.x), sx(end.y));
      }
      ctx.strokeStyle = draftColor;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      draftPoly.forEach((p, i) => {
        const isFirst = i === 0;
        const r = isFirst ? (nearFirst ? 8 : 5) : 3.5;
        ctx.beginPath();
        ctx.arc(sx(p.x), sx(p.y), r, 0, Math.PI * 2);
        ctx.fillStyle = isFirst ? "#fff" : draftColor;
        ctx.fill();
        ctx.strokeStyle = isFirst && nearFirst ? "#12a150" : draftColor;
        ctx.lineWidth = isFirst && nearFirst ? 3 : 1.5;
        ctx.stroke();
      });

      if (nearFirst) {
        // "닫기" cue ring
        ctx.beginPath();
        ctx.arc(sx(first.x), sx(first.y), 13, 0, Math.PI * 2);
        ctx.strokeStyle = "#12a150";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draft bbox
    if (bboxStart && mouse) {
      const x = sx(Math.min(bboxStart.x, mouse.x));
      const y = sx(Math.min(bboxStart.y, mouse.y));
      const w = sx(Math.abs(mouse.x - bboxStart.x));
      const h = sx(Math.abs(mouse.y - bboxStart.y));
      ctx.fillStyle = draftColor + "22";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = draftColor;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  }, [
    baseImage,
    width,
    height,
    zoom,
    rois,
    selectedId,
    draftPoly,
    bboxStart,
    mouse,
    draftColor,
  ]);

  const finishPolygon = useCallback(() => {
    if (draftPoly.length >= 3) onCommitShape("polygon", draftPoly);
    setDraftPoly([]);
  }, [draftPoly, onCommitShape]);

  // keyboard: Enter = finish polygon, Escape = cancel draft
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && tool === "polygon") finishPolygon();
      if (e.key === "Escape") cancelDraft();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, finishPolygon, cancelDraft]);

  // ---- Mouse handlers ----
  const findVertex = (p: Point): { roiId: string; index: number } | null => {
    const r = rois.find((rr) => rr.id === selectedId);
    if (!r) return null;
    for (let i = 0; i < r.points.length; i++) {
      if (Math.hypot(r.points[i].x - p.x, r.points[i].y - p.y) <= VERTEX_HIT)
        return { roiId: r.id, index: i };
    }
    return null;
  };

  const handleDown = (e: React.MouseEvent) => {
    if (panMode) return;
    const p = toImage(e);
    if (tool === "select") {
      const v = findVertex(p);
      if (v) {
        onVertexDragStart?.();
        setDragVertex(v);
        return;
      }
      for (let i = rois.length - 1; i >= 0; i--) {
        if (pointInPolygon(p.x, p.y, rois[i].points)) {
          onSelect(rois[i].id);
          return;
        }
      }
      onSelect(null);
    } else if (tool === "bbox") {
      setBboxStart(p);
    }
  };

  const handleMove = (e: React.MouseEvent) => {
    const p = toImage(e);
    setMouse(p);
    if (dragVertex) onMoveVertex(dragVertex.roiId, dragVertex.index, p);
  };

  const handleUp = (e: React.MouseEvent) => {
    if (dragVertex) {
      setDragVertex(null);
      return;
    }
    if (tool === "bbox" && bboxStart) {
      const p = toImage(e);
      if (Math.abs(p.x - bboxStart.x) > 2 && Math.abs(p.y - bboxStart.y) > 2) {
        onCommitShape("bbox", bboxPoints(bboxStart, p));
      }
      setBboxStart(null);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (panMode) return;
    const p = toImage(e);
    if (tool === "polygon") {
      if (
        draftPoly.length >= 3 &&
        Math.hypot(draftPoly[0].x - p.x, draftPoly[0].y - p.y) <=
          closeThreshImg(zoom)
      ) {
        finishPolygon();
      } else {
        setDraftPoly((d) => [...d, p]);
      }
    } else if (tool === "sam" && !samBusy) {
      onSamClick(p);
    }
  };

  const handleDouble = () => {
    if (tool === "polygon") finishPolygon();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (panMode) {
      e.preventDefault();
      return;
    }
    // Right-click completes the polygon (and never shows the browser menu here)
    if (tool === "polygon" && draftPoly.length >= 1) {
      e.preventDefault();
      finishPolygon();
    } else if (bboxStart || draftPoly.length) {
      e.preventDefault();
      cancelDraft();
    }
  };

  return (
    <div className="stage-inner">
      <canvas
        ref={canvasRef}
        className="annot"
        width={width * zoom}
        height={height * zoom}
        onMouseDown={handleDown}
        onMouseMove={handleMove}
        onMouseUp={handleUp}
        onClick={handleClick}
        onDoubleClick={handleDouble}
        onContextMenu={handleContextMenu}
        onMouseLeave={() => setMouse(null)}
        style={{
          cursor: panMode
            ? "grab"
            : samBusy
            ? "wait"
            : tool === "select"
            ? "default"
            : "crosshair",
        }}
      />
    </div>
  );
});

export default AnnotationCanvas;
