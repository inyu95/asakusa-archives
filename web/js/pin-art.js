/** 山谷アーカイブと同様の円形ピン画像を生成する（ラベルはアイコン下に焼き込み） */

export const PIN_CIRCLE_SIZE = 52;
/** 表示サイズは論理 px。描画だけ高解像度にしてから縮小表示する */
const PIN_RENDER_SCALE = 16;
/**
 * 複数カテゴリ時の団子間隔。
 * outerR = size/2 - 1 に合わせ、円が重ならず外縁で接する距離。
 */
const PIN_DANGO_SPACING = PIN_CIRCLE_SIZE - 2;
const PIN_ART_CACHE_VERSION = "category-color-fix-v2";
const PIN_WHITE_BORDER_WIDTH = 2;
const PIN_ICON_PADDING = 6;
const DEFAULT_PIN_BORDER_COLOR = "#ffffff";
const PIN_NO_COLOR_FILL = "#9a9a9a";

const LABEL_FONT = "bold 15px sans-serif";
const LABEL_GAP = 6;
const LABEL_PAD_X = 12;
const LABEL_OUTLINE_WIDTH = 3.5;

const markerImageCache = new Map();

function getDangoHeight(layerCount) {
  if (layerCount <= 1) return PIN_CIRCLE_SIZE;
  return PIN_CIRCLE_SIZE + (layerCount - 1) * PIN_DANGO_SPACING;
}

function getDangoPositions(layerCount, clusterHeight, originX) {
  const positions = [];
  const cx = originX + PIN_CIRCLE_SIZE / 2;
  for (let i = 0; i < layerCount; i++) {
    positions.push({
      x: cx,
      y: clusterHeight - PIN_CIRCLE_SIZE / 2 - i * PIN_DANGO_SPACING,
    });
  }
  return positions;
}

function drawPinCircleContent(ctx, cx, cy, size, drawCircleContent, fillColor) {
  const outerR = size / 2 - 1;
  const borderW = PIN_WHITE_BORDER_WIDTH;
  const fillR = outerR - borderW;
  const contentR = fillR - PIN_ICON_PADDING;
  const color = fillColor || PIN_NO_COLOR_FILL;

  ctx.beginPath();
  ctx.arc(cx, cy, fillR, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, fillR, 0, Math.PI * 2);
  ctx.clip();
  drawCircleContent(ctx, cx, cy, contentR);
  ctx.restore();
}

function drawPinWhiteRing(ctx, cx, cy, size) {
  const outerR = size / 2 - 1;
  const borderW = PIN_WHITE_BORDER_WIDTH;
  const innerR = outerR - borderW;

  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
  ctx.fillStyle = DEFAULT_PIN_BORDER_COLOR;
  ctx.fill("evenodd");
}

function drawInitialContent(c, cx, cy, innerR, text) {
  const initial = (text || "?").trim().charAt(0).toUpperCase();
  const size = innerR * 2;
  c.fillStyle = "#ffffff";
  c.font = "bold " + Math.round(size * 0.42) + "px sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(initial, cx, cy + 2);
}

/**
 * カテゴリアイコン（白シルエット／黒背景）を白だけ残して描く。
 * 黒・暗い背景は透過し、シートのカテゴリ色がピン下地として見えるようにする。
 */
function drawImageContent(c, cx, cy, innerR, img) {
  const contentSize = Math.max(1, Math.round(innerR * 2));
  const min = Math.min(img.width, img.height);
  const sx = (img.width - min) / 2;
  const sy = (img.height - min) / 2;

  const tmp = document.createElement("canvas");
  tmp.width = contentSize;
  tmp.height = contentSize;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(img, sx, sy, min, min, 0, 0, contentSize, contentSize);

  const imageData = tctx.getImageData(0, 0, contentSize, contentSize);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 8) {
      data[i + 3] = 0;
      continue;
    }
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    // 明るい部分（白シルエット）だけ白で残す。黒い下地は捨てる
    if (lum < 40) {
      data[i + 3] = 0;
    } else {
      const strength = Math.min(1, (lum - 40) / 180);
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * strength);
    }
  }
  tctx.putImageData(imageData, 0, 0);

  c.drawImage(
    tmp,
    cx - contentSize / 2,
    cy - contentSize / 2,
    contentSize,
    contentSize
  );
}

function normalizeLayers(layers) {
  if (!layers || layers.length === 0) {
    return [{ imageUrl: "", borderColor: "", label: "" }];
  }
  return layers;
}

function loadLayerImages(layers) {
  const normalized = normalizeLayers(layers);
  return Promise.all(
    normalized.map(
      (layer) =>
        new Promise((resolve) => {
          const url = layer.imageUrl || "";
          if (!url) {
            resolve(null);
            return;
          }
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = url;
        })
    )
  ).then((images) => ({ normalized, images }));
}

function drawDangoLayers(ctx, clusterHeight, name, normalized, images, originX) {
  const positions = getDangoPositions(normalized.length, clusterHeight, originX);

  for (let i = 0; i < normalized.length; i++) {
    const layer = normalized[i];
    const pos = positions[i];
    const fallbackLabel = layer.label || name;

    drawPinCircleContent(
      ctx,
      pos.x,
      pos.y,
      PIN_CIRCLE_SIZE,
      (c, drawCx, drawCy, innerR) => {
        const img = images[i];
        if (img) {
          drawImageContent(c, drawCx, drawCy, innerR, img);
        } else {
          drawInitialContent(c, drawCx, drawCy, innerR, fallbackLabel);
        }
      },
      layer.borderColor
    );
    drawPinWhiteRing(ctx, pos.x, pos.y, PIN_CIRCLE_SIZE);
  }
}

function measureLabel(text) {
  const label = String(text || "").trim();
  if (!label) {
    return { width: 0, height: 0, text: "" };
  }
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = LABEL_FONT;
  const metrics = probe.measureText(label);
  const width = Math.ceil(metrics.width);
  const ascent =
    metrics.actualBoundingBoxAscent != null
      ? metrics.actualBoundingBoxAscent
      : 11;
  const descent =
    metrics.actualBoundingBoxDescent != null
      ? metrics.actualBoundingBoxDescent
      : 3;
  const height = Math.ceil(ascent + descent + LABEL_OUTLINE_WIDTH);
  return { width, height, text: label, ascent };
}

function drawOutlinedLabel(ctx, text, x, y, ascent) {
  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = LABEL_OUTLINE_WIDTH;
  ctx.strokeStyle = "#000000";
  ctx.fillStyle = "#ffffff";
  const baseline = y + ascent;
  ctx.strokeText(text, x, baseline);
  ctx.fillText(text, x, baseline);
}

function createHiDpiCanvas(logicalW, logicalH) {
  const scale = PIN_RENDER_SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(logicalW * scale));
  canvas.height = Math.max(1, Math.ceil(logicalH * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

function layersCacheKey(layers) {
  return layers
    .map(
      (layer) =>
        (layer.imageUrl || "") +
        "|" +
        (layer.borderColor || "") +
        "|" +
        (layer.label || "")
    )
    .join(";");
}

/**
 * アイコン円の下に名称を焼き込んだピン画像を返す。
 * Cesium Label より HiDPI キャンバスの方が文字がシャープになる。
 *
 * @param {string} name
 * @param {{ imageUrl?: string, borderColor?: string, label?: string }[]} layers
 * @returns {Promise<{ dataUrl: string, width: number, height: number }>}
 */
export async function createPinMarkerImageDataUrl(name, layers) {
  const key =
    (name || "") +
    "::" +
    PIN_ART_CACHE_VERSION +
    "::" +
    layersCacheKey(layers || []);
  const cached = markerImageCache.get(key);
  if (cached) return cached;

  const { normalized, images } = await loadLayerImages(layers);
  const clusterHeight = getDangoHeight(normalized.length);
  const labelMetrics = measureLabel(name);
  const labelBlock =
    labelMetrics.text.length > 0 ? LABEL_GAP + labelMetrics.height : 0;
  const width = Math.max(
    PIN_CIRCLE_SIZE,
    labelMetrics.width + LABEL_PAD_X * 2
  );
  const height = clusterHeight + labelBlock;
  const originX = (width - PIN_CIRCLE_SIZE) / 2;

  const surface = createHiDpiCanvas(width, height);
  drawDangoLayers(
    surface.ctx,
    clusterHeight,
    name,
    normalized,
    images,
    originX
  );

  if (labelMetrics.text) {
    drawOutlinedLabel(
      surface.ctx,
      labelMetrics.text,
      width / 2,
      clusterHeight + LABEL_GAP,
      labelMetrics.ascent
    );
  }

  const result = {
    dataUrl: surface.canvas.toDataURL("image/png"),
    width,
    height,
  };
  markerImageCache.set(key, result);
  return result;
}
