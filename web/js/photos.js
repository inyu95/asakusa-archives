const PHOTO_FILE_PATTERN = /\.(jpe?g|png|gif|webp|svg|bmp)$/i;
const ASSETS_PHOTOS_BASE = "assets/photos/";

function isDirectImagePath(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return true;
  return PHOTO_FILE_PATTERN.test(text);
}

function normalizePathSeparators(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/");
}

/** シート／スポットのフォルダ指定を assets/photos 配下のキーに正規化する */
export function normalizeFolderKey(value) {
  let text = normalizePathSeparators(value);
  text = text.replace(/^\.\//, "").replace(/^\/+/, "");
  const prefix = ASSETS_PHOTOS_BASE;
  if (text.toLowerCase().startsWith(prefix)) {
    text = text.slice(prefix.length);
  }
  text = text.replace(/^\/+|\/+$/g, "");
  return text ? text.normalize("NFC") : "";
}

function encodePathSegments(path) {
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function resolveImageUrl(path) {
  if (!path) return "";
  const text = String(path).trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;

  const normalized = text.replace(/^\.\//, "").replace(/^\/+/, "");
  if (normalized.toLowerCase().startsWith("assets/")) {
    return encodePathSegments(normalized);
  }

  if (isDirectImagePath(normalized) && normalized.indexOf("/") === -1) {
    return ASSETS_PHOTOS_BASE + encodeURIComponent(normalized);
  }

  return encodePathSegments(normalized);
}

function joinFolderAndFile(folderPath, fileName) {
  let folder = normalizePathSeparators(folderPath).replace(/\/+$/, "");
  folder = folder.replace(/^\.\//, "").replace(/^\/+/, "");
  const file = String(fileName || "")
    .trim()
    .replace(/^\/+/, "");
  if (!folder || !file) return "";

  if (!folder.toLowerCase().startsWith("assets/")) {
    folder = ASSETS_PHOTOS_BASE.replace(/\/$/, "") + "/" + normalizeFolderKey(folder);
  }
  return folder + "/" + file;
}

function photoFromRecord(record) {
  const path = joinFolderAndFile(record.folder, record.file);
  const url = resolveImageUrl(path);
  if (!url || !PHOTO_FILE_PATTERN.test(record.file)) return null;

  return {
    url,
    file: record.file,
    folder: normalizeFolderKey(record.folder),
    title: record.title || "",
    description: record.description || "",
    date: record.date || "",
    creator: record.creator || "",
    collection: record.collection || "",
    credit: record.credit || "",
    order: record.order,
    genre: record.genre || "",
    pitch: record.pitch || "",
  };
}

function comparePhotos(a, b) {
  const orderA = a.order == null ? Number.POSITIVE_INFINITY : a.order;
  const orderB = b.order == null ? Number.POSITIVE_INFINITY : b.order;
  if (orderA !== orderB) return orderA - orderB;

  const sheetA = a.sheetIndex == null ? Number.POSITIVE_INFINITY : a.sheetIndex;
  const sheetB = b.sheetIndex == null ? Number.POSITIVE_INFINITY : b.sheetIndex;
  if (sheetA !== sheetB) return sheetA - sheetB;

  return String(a.file || "").localeCompare(String(b.file || ""), "ja");
}

function groupPhotosByFolder(records) {
  /** @type {Map<string, object[]>} */
  const byFolder = new Map();
  for (const record of records || []) {
    const photo = photoFromRecord(record);
    if (!photo) continue;
    photo.sheetIndex = record.sheetIndex;
    const key = photo.folder;
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(photo);
  }
  for (const list of byFolder.values()) {
    list.sort(comparePhotos);
  }
  return byFolder;
}

/**
 * マッピングの image 列（フォルダ）と画像データシートから写真配列を解決する。
 * @returns {{ images: object[], image: string }}
 */
export function resolveSpotPhotos(imageRaw, photoRecords) {
  const raw = String(imageRaw || "").trim();
  if (!raw) {
    return { images: [], image: "" };
  }

  if (isDirectImagePath(raw) && /^https?:\/\//i.test(raw)) {
    const url = resolveImageUrl(raw);
    return { images: [{ url, title: "" }], image: url };
  }

  const folder = isDirectImagePath(raw)
    ? normalizeFolderKey(raw.slice(0, raw.lastIndexOf("/")))
    : normalizeFolderKey(raw);

  if (!folder) {
    if (isDirectImagePath(raw)) {
      const url = resolveImageUrl(raw);
      return url
        ? { images: [{ url, title: "" }], image: url }
        : { images: [], image: "" };
    }
    return { images: [], image: "" };
  }

  const byFolder = groupPhotosByFolder(photoRecords);
  const photos = byFolder.get(folder) || [];

  if (photos.length === 0 && isDirectImagePath(raw)) {
    const url = resolveImageUrl(raw);
    return url
      ? { images: [{ url, title: "" }], image: url }
      : { images: [], image: "" };
  }

  return {
    images: photos,
    image: photos[0] ? photos[0].url : "",
  };
}

/** 複数スポットの写真を画像データシート基準で埋める */
export async function attachSpotPhotos(spots, photoRecords) {
  const records = Array.isArray(photoRecords) ? photoRecords : [];

  for (const spot of spots) {
    if (Array.isArray(spot.images) && spot.images.length > 0) {
      if (!spot.image) spot.image = spot.images[0].url || "";
      continue;
    }

    const raw = spot.imageFolder || spot.image || "";
    const resolved = resolveSpotPhotos(raw, records);
    spot.images = resolved.images;
    spot.image = resolved.image;
    if (raw && resolved.images.length === 0) {
      console.warn(
        "写真が見つかりません:",
        spot.name,
        "(" + raw + ")",
        "— シート「画像データ」にフォルダパスとデータ名を記入し、web/assets/photos/ にファイルを置いてください。"
      );
    }
  }
  return spots;
}
