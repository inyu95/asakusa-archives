import { parseGvizRows } from "./gviz.js";

/** 浅草タイムトラベル — コンテンツ用スプレッドシート */
export const SHEET_ID = "1CJfTgaM-C0iL7YGpSJVuTUNn9JkpKs5O7dypYBJ1oAA";
export const SHEET_MAPPING = "マッピング";
const SHEET_FETCH_TIMEOUT_MS = 30000;
const SHEET_FETCH_MAX_RETRIES = 2;

function cellValue(cell) {
  if (!cell) return "";
  if (cell.v != null) return cell.v;
  return "";
}

/** 改行を含むセルは v が空で f に入ることがある */
function cellTextValue(cell) {
  if (!cell) return "";
  if (cell.v != null && cell.v !== "") return cell.v;
  if (cell.f != null && cell.f !== "") {
    return String(cell.f).replace(/^'/, "");
  }
  return "";
}

function parseLatLonCell(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const parts = raw.split(/[,\s]+/).filter(Boolean).map(parseFloat);
  if (parts.length < 2 || parts.some(isNaN)) return null;

  const a = parts[0];
  const b = parts[1];
  const inJapanLon = (v) => v >= 120 && v <= 155;
  const inJapanLat = (v) => v >= 20 && v <= 50;

  if (inJapanLat(a) && inJapanLon(b)) return { lat: a, lon: b };
  if (inJapanLon(a) && inJapanLat(b)) return { lon: a, lat: b };
  return { lat: a, lon: b };
}

function isHeaderRow(c) {
  const colA = String(cellValue(c[0]) || "").toLowerCase();
  const colB = String(cellValue(c[1]) || "").toLowerCase();
  return (
    (colA === "name" || colA === "名称" || colA === "id") &&
    (colB.indexOf("lat") !== -1 ||
      colB.indexOf("lon") !== -1 ||
      colB === "座標" ||
      colB === "緯度経度" ||
      colB === "name" ||
      colB === "名称")
  );
}

function normalizeHeaderText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function resolveColumnIndex(headerMap, key, fallback) {
  return Object.prototype.hasOwnProperty.call(headerMap, key)
    ? headerMap[key]
    : fallback;
}

function getColumnIndexes(rows) {
  const defaults = {
    id: -1,
    name: 0,
    coords: 1,
    image: 2,
    text: 3,
    url: 5,
    urlLabel: 6,
    openingYear: 7,
    closingYear: 8,
    category: 9,
    role: 10,
  };
  if (!rows || rows.length === 0) return defaults;

  const headerRow = rows[0].c || [];
  const headerMap = {};
  for (let i = 0; i < headerRow.length; i++) {
    const header = normalizeHeaderText(cellValue(headerRow[i]));
    if (!header) continue;

    if (header === "id" || header === "スポットid") headerMap.id = i;
    else if (header === "name" || header === "名称" || header === "スポット名")
      headerMap.name = i;
    else if (
      header.indexOf("lat") !== -1 ||
      header.indexOf("lon") !== -1 ||
      header === "座標" ||
      header === "緯度経度"
    )
      headerMap.coords = i;
    else if (
      header === "imagefolder" ||
      header === "image" ||
      header === "写真" ||
      header === "写真フォルダ"
    )
      headerMap.image = i;
    else if (header === "text" || header === "説明") headerMap.text = i;
    else if (header.indexOf("url表示") !== -1) headerMap.urlLabel = i;
    else if (
      header === "url" ||
      header.indexOf("url（") !== -1 ||
      header.indexOf("url(") !== -1
    )
      headerMap.url = i;
    else if (header === "開業年") headerMap.openingYear = i;
    else if (header === "閉業年") headerMap.closingYear = i;
    else if (header === "category" || header === "カテゴリ")
      headerMap.category = i;
    else if (
      header === "role" ||
      header === "役割" ||
      header === "生活行為" ||
      header === "activity" ||
      header === "アクティビティ"
    )
      headerMap.role = i;
  }

  const indexes = {};
  Object.keys(defaults).forEach((key) => {
    indexes[key] = resolveColumnIndex(headerMap, key, defaults[key]);
  });
  return indexes;
}

function splitMultiline(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDirectImagePath(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return true;
  return /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(text);
}

function parseRows(rows) {
  const list = [];
  const col = getColumnIndexes(rows);

  for (let index = 0; index < rows.length; index++) {
    const c = rows[index].c || [];
    if (isHeaderRow(c)) continue;

    const name = String(cellValue(c[col.name]) || "").trim();
    const id =
      col.id >= 0 ? String(cellValue(c[col.id]) || "").trim() : "";
    if (!name && !id) continue;

    const coords = parseLatLonCell(cellValue(c[col.coords]));
    const imageRaw = String(cellValue(c[col.image]) || "").trim();
    const urls = splitMultiline(cellTextValue(c[col.url]));
    const urlLabels = splitMultiline(cellTextValue(c[col.urlLabel]));
    const sources = urls.map((url, i) => ({
      label: urlLabels[i] || url,
      url,
    }));

    list.push({
      id: id || "",
      name,
      lat: coords ? coords.lat : null,
      lon: coords ? coords.lon : null,
      // フォルダ名 / ファイルパス / URL。実体解決は photos.js 側
      imageFolder: imageRaw,
      image: isDirectImagePath(imageRaw) ? imageRaw : "",
      description: String(cellTextValue(c[col.text]) || "").trim(),
      yearFrom: String(cellValue(c[col.openingYear]) || "").trim(),
      yearTo: String(cellValue(c[col.closingYear]) || "").trim(),
      category: String(cellValue(c[col.category]) || "").trim(),
      role: String(cellValue(c[col.role]) || "").trim(),
      sources,
    });
  }
  return list;
}

function fetchSheetData(sheetName, retryCount) {
  const attempt = retryCount || 0;
  const url =
    "https://docs.google.com/spreadsheets/d/" +
    SHEET_ID +
    "/gviz/tq?tqx=out:json&sheet=" +
    encodeURIComponent(sheetName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEET_FETCH_TIMEOUT_MS);

  return fetch(url, { signal: controller.signal })
    .then((res) => {
      clearTimeout(timer);
      if (!res.ok) throw new Error("SHEET_HTTP_" + res.status);
      return res.text();
    })
    .then((text) => parseGvizRows(text))
    .catch((err) => {
      clearTimeout(timer);
      const canRetry =
        attempt < SHEET_FETCH_MAX_RETRIES &&
        (err.name === "AbortError" ||
          (err.message && err.message.indexOf("SHEET_HTTP_") === 0) ||
          err instanceof SyntaxError);
      if (canRetry) {
        console.warn(
          "スプレッドシート再試行:",
          sheetName,
          "(" + (attempt + 1) + "/" + SHEET_FETCH_MAX_RETRIES + ")"
        );
        return fetchSheetData(sheetName, attempt + 1);
      }
      throw err;
    });
}

/** マッピングシートのコンテンツ行を取得する */
export async function loadMappingContent() {
  const rows = await fetchSheetData(SHEET_MAPPING);
  return parseRows(rows);
}

/** 表示名の照合用（括弧以降を除く） */
export function normalizeSpotName(name) {
  return String(name || "")
    .replace(/[（(].*$/, "")
    .trim()
    .toLowerCase();
}
