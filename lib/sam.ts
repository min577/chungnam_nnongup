import { Point } from "./types";

/**
 * SAM (Segment Anything) running fully in the browser via transformers.js.
 * Uses SlimSAM (a small distilled SAM) so it loads/decodes fast on CPU/WebGPU.
 *
 * Flow:
 *   1. setImage(canvas)  -> run the vision encoder once, cache the embedding.
 *   2. segment(points)   -> run the lightweight mask decoder for click prompts.
 *
 * Model weights + wasm are fetched from the HuggingFace CDN at runtime, so this
 * works on static hosting (Vercel) with no backend.
 *
 * Point scaling follows the official transformers.js segment-anything demo:
 * prompt points are expressed in the processor's "reshaped input" space, i.e.
 *   sx = px / originalWidth  * reshapedWidth
 *   sy = py / originalHeight * reshapedHeight
 */

const MODEL_ID = "Xenova/slimsam-77-uniform";

type TJS = typeof import("@huggingface/transformers");

let tjs: TJS | null = null;
let processor: any = null;
let model: any = null;
let loadPromise: Promise<void> | null = null;

// Per-image state
let imageEmbeddings: any = null;
let imageInputs: any = null;
let imageSize: { width: number; height: number } | null = null;

export async function ensureModel(
  onProgress?: (msg: string) => void
): Promise<void> {
  if (model && processor) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    onProgress?.("SAM 모델 로딩 중… (최초 1회, 수십 MB 다운로드)");
    tjs = await import("@huggingface/transformers");
    processor = await tjs.AutoProcessor.from_pretrained(MODEL_ID);
    try {
      model = await tjs.SamModel.from_pretrained(MODEL_ID, {
        dtype: "fp16",
      } as any);
    } catch {
      model = await tjs.SamModel.from_pretrained(MODEL_ID);
    }
    onProgress?.("SAM 모델 준비 완료");
  })();
  return loadPromise;
}

/** Run the vision encoder on the canvas and cache the embedding. */
export async function setImage(canvas: HTMLCanvasElement): Promise<void> {
  await ensureModel();
  const t = tjs as TJS;
  const raw = await t.RawImage.fromCanvas(canvas);
  imageInputs = await processor(raw);
  imageEmbeddings = await model.get_image_embeddings(imageInputs);
  imageSize = { width: canvas.width, height: canvas.height };
}

export function hasImage(): boolean {
  return imageEmbeddings != null;
}

export function clearImage(): void {
  imageEmbeddings = null;
  imageInputs = null;
  imageSize = null;
}

/**
 * Run SAM for positive point prompts (image pixel coords).
 * Returns the best-scoring binary mask (Uint8Array, width*height).
 */
export async function segment(
  points: Point[]
): Promise<{ mask: Uint8Array; width: number; height: number } | null> {
  if (!imageEmbeddings || !imageSize || !imageInputs)
    throw new Error("이미지가 설정되지 않았습니다.");
  const t = tjs as TJS;
  const { width, height } = imageSize;

  // reshaped_input_sizes[0] = [rH, rW]
  const reshaped = imageInputs.reshaped_input_sizes[0];
  const rH = reshaped[0];
  const rW = reshaped[1];

  const scaled = points.flatMap((p) => [
    (p.x / width) * rW,
    (p.y / height) * rH,
  ]);
  const labels = points.map(() => 1n);

  const input_points = new (t as any).Tensor(
    "float32",
    Float32Array.from(scaled),
    [1, 1, points.length, 2]
  );
  const input_labels = new (t as any).Tensor(
    "int64",
    BigInt64Array.from(labels),
    [1, 1, points.length]
  );

  const outputs = await model({
    ...imageEmbeddings,
    input_points,
    input_labels,
  });

  // post_process_masks resizes masks back to original_sizes (= our canvas).
  const masks = await processor.post_process_masks(
    outputs.pred_masks,
    imageInputs.original_sizes,
    imageInputs.reshaped_input_sizes
  );

  const maskTensor = masks[0]; // dims [num_masks, H, W]
  const dims = maskTensor.dims;
  const H = dims[dims.length - 2];
  const W = dims[dims.length - 1];
  const flat = maskTensor.data as Uint8Array;

  const scores = Array.from(outputs.iou_scores.data as Float32Array);
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;

  const planeSize = H * W;
  const offset = best * planeSize;
  const out = new Uint8Array(width * height);
  if (H === height && W === width) {
    for (let i = 0; i < planeSize; i++) out[i] = flat[offset + i] ? 1 : 0;
  } else {
    // nearest-neighbour resize fallback
    for (let y = 0; y < height; y++) {
      const sy = Math.min(H - 1, Math.floor((y / height) * H));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(W - 1, Math.floor((x / width) * W));
        out[y * width + x] = flat[offset + sy * W + sx] ? 1 : 0;
      }
    }
  }
  return { mask: out, width, height };
}
