"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Point, Roi, ShapeKind } from "@/lib/types";
import { pointInPolygon } from "@/lib/envi";
import { bboxPoints } from "@/lib/geometry";

export type Tool = "select" | "polygon" | "bbox" | "sam";

interface Props {
  baseImage: ImageData | null;
  width: number;
  height: number;
  zoom: number;
  tool: Tool;
  rois: Roi[];
  selectedId: string | null;
  samBusy: boolean;
  draftColor: string;
  onCommitShape: (kind: ShapeKind, points: Point[]) => void;
  onSamClick: (p: Point) => void;
  onSelect: (id: string | null) => void;
  onMoveVertex: (roiId: string, index: number, p: Point) => void;
}

const VERTEX_HIT = 6; // image px

export default function AnnotationCanvas({
  baseImage,
  width,
  height,
  zoom,
  tool,
  rois,
  selectedId,
  samBusy,
  draftColor,
  onCommitShape,
  onSamClick,
  onSelect,
  onMoveVertex,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);

  const [draftPoly, setDraftPoly] = useState<Point[]>([]);
  const [bboxStart, setBboxStart] = useState<Point | null>(null);
  const [mouse, setMouse] = useState<Point | null>(null);
  const [dragVertex, setDragVertex] = useState<{ roiId: string; index: number } | null>(
    null
  );

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
      ctx.fillStyle = color + "22";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.stroke();
      if (selected) {
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(sx(p.x), sx(p.y), 4, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    };

    for (const r of rois) drawShape(r.points, r.color, r.id === selectedId);

    // Draft polygon
    if (draftPoly.length > 0) {
      ctx.beginPath();
      ctx.moveTo(sx(draftPoly[0].x), sx(draftPoly[0].y));
      for (let i = 1; i < draftPoly.length; i++)
        ctx.lineTo(sx(draftPoly[i].x), sx(draftPoly[i].y));
      if (mouse) ctx.lineTo(sx(mouse.x), sx(mouse.y));
      ctx.strokeStyle = draftColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      for (const p of draftPoly) {
        ctx.beginPath();
        ctx.arc(sx(p.x), sx(p.y), 3.5, 0, Math.PI * 2);
        ctx.fillStyle = draftColor;
        ctx.fill();
      }
    }

    // Draft bbox
    if (bboxStart && mouse) {
      const x = sx(Math.min(bboxStart.x, mouse.x));
      const y = sx(Math.min(bboxStart.y, mouse.y));
      const w = sx(Math.abs(mouse.x - bboxStart.x));
      const h = sx(Math.abs(mouse.y - bboxStart.y));
      ctx.strokeStyle = draftColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
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
      if (e.key === "Escape") {
        setDraftPoly([]);
        setBboxStart(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, finishPolygon]);

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
    const p = toImage(e);
    if (tool === "select") {
      const v = findVertex(p);
      if (v) {
        setDragVertex(v);
        return;
      }
      // select topmost ROI under cursor
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
    const p = toImage(e);
    if (tool === "polygon") {
      if (
        draftPoly.length >= 3 &&
        Math.hypot(draftPoly[0].x - p.x, draftPoly[0].y - p.y) <= VERTEX_HIT
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
        onMouseLeave={() => setMouse(null)}
        style={{ cursor: samBusy ? "wait" : tool === "select" ? "default" : "crosshair" }}
      />
    </div>
  );
}
