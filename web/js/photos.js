const PHOTO_FILE_PATTERN = /\.(jpe?g|png|gif|webp|svg|bmp)$/i;
const ASSETS_PHOTOS_BASE = "assets/photos/";
const INDEX_URL = ASSETS_PHOTOS_BASE + "index.json";

let photoIndexPromise = null;

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

function normalizeImageFolder(value) {
  let text = normalizePathSeparators(value);
  text = text.replace(/^\.\//, "").replace(/^\/+/, "");
  const prefix = ASSETS_PHOTOS_BASE;
  if (text.toLowerCase().startsWith(prefix)) {
    text = text.slice(prefix.length);
  }
  return text.replace(/^\/+|\/+$/g, "");
}

function normalizeFolderKey(value) {
  const folder = normalizeImageFolder(value);
  return folder ? folder.normalize("NFC") : "";
}

function extractFolderFromImagePath(value) {
  const text = normalizePathSeparators(value)
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  const lastSlash = text.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return text.slice(0, lastSlash);
}

function encodePhotoFileName(fileName) {
  return String(fileName || "")
    .trim()
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function buildPhotoBaseUrl(folder) {
  const segments = folder.split("/").filter(Boolean).map((seg) =>
    encodeURIComponent(seg)
  );
  return ASSETS_PHOTOS_BASE + segments.join("/") + "/";
}

function buildPhotoEntry(base, file) {
  const name = String(file || "").trim();
  if (!name) return null;
  return { url: base + encodePhotoFileName(name), title: "" };
}

function resolveImageUrl(path) {
  if (!path) return "";
  const text = String(path).trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;

  const normalized = text.replace(/^\.\//, "").replace(/^\/+/, "");
  if (normalized.toLowerCase().startsWith("assets/")) {
    return normalized
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
  }

  if (isDirectImagePath(normalized) && normalized.indexOf("/") === -1) {
    return ASSETS_PHOTOS_BASE + encodeURIComponent(normalized);
  }

  return normalized
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function loadPhotoIndex() {
  if (!photoIndexPromise) {
    photoIndexPromise = fetch(INDEX_URL)
      .then((res) => {
        if (!res.ok) return {};
        return res.json();
      })
      .then((data) => {
        if (!data || typeof data !== "object") return {};
        if (data.folders && typeof data.folders === "object") return data.folders;
        return data;
      })
      .catch((err) => {
        console.warn("写真 index.json の取得に失敗:", err);
        return {};
      });
  }
  return photoIndexPromise;
}

function photosFromIndex(index, folder, base) {
  const key = folder.normalize("NFC");
  const files = index[key] || index[folder] || [];
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => String(file || "").trim())
    .filter((file) => PHOTO_FILE_PATTERN.test(file))
    .sort((a, b) => a.localeCompare(b, "ja"))
    .map((file) => buildPhotoEntry(base, file))
    .filter(Boolean);
}

function probeNumberedImages(base) {
  const maxCount = 40;
  const extensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

  function probeExtensions(index, extIndex) {
    if (extIndex >= extensions.length) return Promise.resolve("");
    const url = base + index + extensions[extIndex];
    return fetch(url, { method: "HEAD" })
      .then((res) => (res.ok ? url : probeExtensions(index, extIndex + 1)))
      .catch(() => probeExtensions(index, extIndex + 1));
  }

  function probe(index, found) {
    if (index > maxCount) return Promise.resolve(found);
    return probeExtensions(index, 0).then((url) => {
      if (url) {
        found.push({ url, title: "" });
        return probe(index + 1, found);
      }
      return found;
    });
  }

  return probe(1, []);
}

function resolveImagesFromFolder(folderName) {
  const folder = normalizeFolderKey(folderName);
  if (!folder) return Promise.resolve([]);

  const base = buildPhotoBaseUrl(folder);
  return loadPhotoIndex().then((index) => {
    const fromIndex = photosFromIndex(index, folder, base);
    if (fromIndex.length > 0) return fromIndex;
    return probeNumberedImages(base);
  });
}

function photoFileNameFromUrl(url) {
  const part = String(url || "").split("/").pop() || "";
  try {
    return decodeURIComponent(part);
  } catch (_err) {
    return part;
  }
}

function reorderPhotosWithPreferred(photos, preferredUrl, preferredFileName) {
  if (!photos.length || (!preferredUrl && !preferredFileName)) return photos;

  const index = photos.findIndex((photo) => {
    if (preferredUrl && photo.url === preferredUrl) return true;
    if (!preferredFileName) return false;
    return photoFileNameFromUrl(photo.url) === preferredFileName;
  });

  if (index <= 0) return photos;

  const reordered = photos.slice();
  const preferred = reordered.splice(index, 1)[0];
  reordered.unshift(preferred);
  return reordered;
}

/**
 * シートの image 列（フォルダ名 / ファイルパス / URL）から写真配列を解決する。
 * @returns {Promise<{ images: Array<{url:string,title:string}>, image: string }>}
 */
export async function resolveSpotPhotos(imageRaw) {
  const raw = String(imageRaw || "").trim();
  if (!raw) {
    return { images: [], image: "" };
  }

  if (isDirectImagePath(raw) && /^https?:\/\//i.test(raw)) {
    const url = resolveImageUrl(raw);
    return { images: [{ url, title: "" }], image: url };
  }

  const folderInput = isDirectImagePath(raw)
    ? extractFolderFromImagePath(raw)
    : raw;
  const folder = normalizeFolderKey(folderInput);
  const preferredUrl = isDirectImagePath(raw) ? resolveImageUrl(raw) : "";
  const preferredFileName = isDirectImagePath(raw)
    ? normalizePathSeparators(raw).split("/").pop()
    : "";

  if (isDirectImagePath(raw) && !folder) {
    const url = preferredUrl;
    return url
      ? { images: [{ url, title: "" }], image: url }
      : { images: [], image: "" };
  }

  if (!folder) {
    return { images: [], image: "" };
  }

  const photos = await resolveImagesFromFolder(folder);
  if (photos.length === 0 && preferredUrl) {
    return {
      images: [{ url: preferredUrl, title: "" }],
      image: preferredUrl,
    };
  }

  const ordered = reorderPhotosWithPreferred(
    photos,
    preferredUrl,
    preferredFileName
  );
  return {
    images: ordered,
    image: ordered[0] ? ordered[0].url : "",
  };
}

/** 複数スポットの写真を解決して spot.images / spot.image を埋める */
export async function attachSpotPhotos(spots) {
  await Promise.all(
    spots.map(async (spot) => {
      const raw = spot.imageFolder || spot.image || "";
      // すでに images 配列がある場合はそのまま
      if (Array.isArray(spot.images) && spot.images.length > 0) {
        if (!spot.image) spot.image = spot.images[0].url || "";
        return;
      }
      const resolved = await resolveSpotPhotos(raw);
      spot.images = resolved.images;
      spot.image = resolved.image;
      if (raw && resolved.images.length === 0) {
        console.warn(
          "写真が見つかりません:",
          spot.name,
          "(" + raw + ")",
          "— web/assets/photos/<フォルダ>/ に置き、npm run photos:index を実行してください。"
        );
      }
    })
  );
  return spots;
}
