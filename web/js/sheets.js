import { parseGvizTable } from "./gviz.js";

/** 浅草タイムトラベル — コンテンツ用スプレッドシート */
export const SHEET_ID = "1CJfTgaM-C0iL7YGpSJVuTUNn9JkpKs5O7dypYBJ1oAA";
export const SHEET_MAPPING = "マッピング";
export const SHEET_PHOTOS = "画像データ";
export const SHEET_CATEGORIES = "カテゴリリスト";
/** セル背景色の取得用（公開シートの読み取り専用） */
const GOOGLE_SHEETS_API_KEY = "AIzaSyAj3HmCQbFFqq1G7L9OhLMW2yT8cTJckJc";
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

function parseOptionalNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function getColumnIndexes(rows, cols) {
  const defaults = {
    id: -1,
    name: 0,
    coords: 1,
    image: 2,
    text: 3,
    note: -1,
    url: 5,
    urlLabel: 6,
    openingYear: 7,
    closingYear: 8,
    category: 9,
    role: 10,
    viewHeading: -1,
    viewPitch: -1,
    viewRange: -1,
    pinLength: -1,
  };

  const headerLabels = [];
  // GViz は parsedNumHeaders=1 のときヘッダーを cols[].label に移し、rows から除く
  if (cols && cols.length > 0) {
    for (let i = 0; i < cols.length; i++) {
      headerLabels[i] = cols[i]?.label ?? "";
    }
  }
  const hasColLabels = headerLabels.some((label) => String(label || "").trim());
  if (!hasColLabels && rows && rows.length > 0) {
    const headerRow = rows[0].c || [];
    for (let i = 0; i < headerRow.length; i++) {
      headerLabels[i] = cellValue(headerRow[i]);
    }
  }

  const headerMap = {};
  for (let i = 0; i < headerLabels.length; i++) {
    const header = normalizeHeaderText(headerLabels[i]);
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
    else if (
      header === "note" ||
      header === "注記" ||
      header === "備考" ||
      header === "メモ"
    )
      headerMap.note = i;
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
    else if (header === "viewheading" || header === "カメラ方位")
      headerMap.viewHeading = i;
    else if (header === "viewpitch" || header === "カメラ俯角")
      headerMap.viewPitch = i;
    else if (header === "viewrange" || header === "カメラ距離")
      headerMap.viewRange = i;
    else if (
      header === "ピン長さ" ||
      header === "pinlength" ||
      header === "pinheight" ||
      header === "ポール高さ"
    )
      headerMap.pinLength = i;
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

function parseRows(rows, cols) {
  const list = [];
  const col = getColumnIndexes(rows, cols);

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
      note:
        col.note >= 0
          ? String(cellTextValue(c[col.note]) || "").trim()
          : "",
      yearFrom: String(cellValue(c[col.openingYear]) || "").trim(),
      yearTo: String(cellValue(c[col.closingYear]) || "").trim(),
      category: String(cellValue(c[col.category]) || "").trim(),
      role: String(cellValue(c[col.role]) || "").trim(),
      viewHeading:
        col.viewHeading >= 0
          ? parseOptionalNumber(cellValue(c[col.viewHeading]))
          : null,
      viewPitch:
        col.viewPitch >= 0
          ? parseOptionalNumber(cellValue(c[col.viewPitch]))
          : null,
      viewRange:
        col.viewRange >= 0
          ? parseOptionalNumber(cellValue(c[col.viewRange]))
          : null,
      pinLength:
        col.pinLength >= 0
          ? parseOptionalNumber(cellValue(c[col.pinLength]))
          : null,
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
    .then((text) => parseGvizTable(text))
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
  const { rows, cols } = await fetchSheetData(SHEET_MAPPING);
  return parseRows(rows, cols);
}

function isCssColorText(value) {
  const text = String(value || "").trim();
  return (
    /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ||
    /^rgba?\(/i.test(text)
  );
}

function sheetsApiColorToCss(color) {
  if (!color) return "";
  // Sheets API は 0 のチャンネルを省略することがある。欠落は 0（昔の ?? 1 だと色がずれる）
  const r = Math.round((color.red ?? 0) * 255);
  const g = Math.round((color.green ?? 0) * 255);
  const b = Math.round((color.blue ?? 0) * 255);
  // 未設定セルの白背景は無視
  if (r >= 250 && g >= 250 && b >= 250) return "";
  return `rgb(${r}, ${g}, ${b})`;
}

function getCellBackgroundCss(valueCell) {
  if (!valueCell) return "";
  const format =
    valueCell.effectiveFormat || valueCell.userEnteredFormat || null;
  if (!format) return "";
  const styleRgb = format.backgroundColorStyle && format.backgroundColorStyle.rgbColor;
  if (styleRgb) return sheetsApiColorToCss(styleRgb);
  return sheetsApiColorToCss(format.backgroundColor);
}

/** GViz: B 列に #hex / rgb が書いてあればそれを使う */
function parseCategoryColorsFromGviz(rows) {
  const colors = {};
  for (const row of rows || []) {
    const c = row.c || [];
    const name = String(cellValue(c[0]) || "").trim();
    if (!name || name.indexOf("一覧") !== -1) continue;
    const text = String(cellValue(c[1]) || "").trim();
    if (text.toLowerCase() === "color" || text.toLowerCase() === "色") continue;
    if (isCssColorText(text)) colors[name] = text;
  }
  return colors;
}

/** Sheets API: B 列セルの背景色をカテゴリ色として読む */
async function fetchCategoryColorsFromSheetsApi() {
  if (!GOOGLE_SHEETS_API_KEY) return {};

  const range = encodeURIComponent(`${SHEET_CATEGORIES}!A1:B100`);
  const fields = encodeURIComponent(
    "sheets(data(rowData(values(formattedValue,effectiveFormat(backgroundColor,backgroundColorStyle),userEnteredFormat(backgroundColor,backgroundColorStyle)))))"
  );
  const url =
    "https://sheets.googleapis.com/v4/spreadsheets/" +
    SHEET_ID +
    "?ranges=" +
    range +
    "&fields=" +
    fields +
    "&key=" +
    encodeURIComponent(GOOGLE_SHEETS_API_KEY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEET_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn("カテゴリ色 API エラー:", res.status);
      return {};
    }
    const json = await res.json();
    const rowData =
      json?.sheets?.[0]?.data?.[0]?.rowData || [];
    const colors = {};
    for (const row of rowData) {
      const values = row.values || [];
      if (values.length < 2) continue;
      const name = String(values[0]?.formattedValue || "").trim();
      if (!name || name.indexOf("一覧") !== -1) continue;
      const text = String(values[1]?.formattedValue || "").trim();
      if (text && isCssColorText(text)) {
        colors[name] = text;
        continue;
      }
      const bg = getCellBackgroundCss(values[1]);
      if (bg) colors[name] = bg;
    }
    return colors;
  } catch (err) {
    clearTimeout(timer);
    console.warn("カテゴリ色の取得に失敗:", err);
    return {};
  }
}

/**
 * カテゴリリスト A 列の表示順一覧。
 * @returns {Promise<string[]>}
 */
export async function loadCategoryList() {
  try {
    const table = await fetchSheetData(SHEET_CATEGORIES);
    const list = [];
    const seen = new Set();
    for (const row of table.rows || []) {
      const c = row.c || [];
      const name = String(cellValue(c[0]) || "").trim();
      if (!name || name.indexOf("一覧") !== -1) continue;
      const lower = name.toLowerCase();
      if (
        lower === "category" ||
        lower === "カテゴリ" ||
        name === "カテゴリ名"
      ) {
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      list.push(name);
    }
    return list;
  } catch (err) {
    console.warn("カテゴリ一覧の取得に失敗:", err);
    return [];
  }
}

/**
 * カテゴリリストの B 列（color）からカテゴリ名 → CSS 色のマップを返す。
 * セル文字（#hex）があれば優先。なければセル背景色。
 */
export async function loadCategoryColors() {
  const [table, apiColors] = await Promise.all([
    fetchSheetData(SHEET_CATEGORIES).catch((err) => {
      console.warn("カテゴリリストの取得に失敗:", err);
      return { rows: [], cols: [] };
    }),
    fetchCategoryColorsFromSheetsApi(),
  ]);
  return {
    ...parseCategoryColorsFromGviz(table.rows || []),
    ...apiColors,
  };
}

function isPhotoHeaderRow(c) {
  const colA = normalizeHeaderText(cellValue(c[0]));
  const colB = normalizeHeaderText(cellValue(c[1]));
  return (
    (colA === "フォルダパス" ||
      colA === "写真パス" ||
      colA === "folder" ||
      colA === "folderpath") &&
    (colB === "データ名" ||
      colB === "ファイル名" ||
      colB === "filename" ||
      colB === "file")
  );
}

function getPhotoColumnIndexes(rows, cols) {
  const defaults = {
    folder: 0,
    file: 1,
    title: 2,
    description: 3,
    date: 4,
    creator: 5,
    collection: 6,
    credit: 7,
    order: 8,
    genre: 9,
    pitch: 10,
  };

  const headerLabels = [];
  if (cols && cols.length > 0) {
    for (let i = 0; i < cols.length; i++) {
      headerLabels[i] = cols[i]?.label ?? "";
    }
  }
  const hasColLabels = headerLabels.some((label) => String(label || "").trim());
  if (!hasColLabels && rows && rows.length > 0) {
    const headerRow = rows[0].c || [];
    for (let i = 0; i < headerRow.length; i++) {
      headerLabels[i] = cellValue(headerRow[i]);
    }
  }

  // ヘッダーらしきラベルが無いときは既定列順
  const probe = headerLabels.map((v) => {
    const cell = { v: v };
    return cell;
  });
  if (!isPhotoHeaderRow(probe) && !(cols && cols.length > 0 && hasColLabels)) {
    return defaults;
  }

  const headerMap = {};
  for (let i = 0; i < headerLabels.length; i++) {
    const header = normalizeHeaderText(headerLabels[i]);
    if (!header) continue;

    if (
      header === "フォルダパス" ||
      header === "写真パス" ||
      header === "folder" ||
      header === "folderpath"
    )
      headerMap.folder = i;
    else if (
      header === "データ名" ||
      header === "ファイル名" ||
      header === "filename" ||
      header === "file"
    )
      headerMap.file = i;
    else if (header === "写真タイトル" || header === "タイトル" || header === "title")
      headerMap.title = i;
    else if (header === "説明" || header === "description" || header === "caption")
      headerMap.description = i;
    else if (
      header === "年代" ||
      header === "撮影年代" ||
      header === "date" ||
      header === "year"
    )
      headerMap.date = i;
    else if (
      header === "作者/撮影者" ||
      header === "作者" ||
      header === "撮影者" ||
      header === "creator" ||
      header === "author"
    )
      headerMap.creator = i;
    else if (
      header.indexOf("所蔵") !== -1 ||
      header === "出典" ||
      header === "collection" ||
      header === "source"
    )
      headerMap.collection = i;
    else if (
      header.indexOf("クレジット") !== -1 ||
      header === "credit"
    )
      headerMap.credit = i;
    else if (header === "表示順" || header === "order" || header === "sort")
      headerMap.order = i;
    else if (header === "ジャンル" || header === "genre" || header === "category")
      headerMap.genre = i;
    else if (header === "pitch") headerMap.pitch = i;
  }

  // cols ラベルがある場合は headerMap が空でも defaults にフォールバック
  if (Object.keys(headerMap).length === 0) return defaults;

  const indexes = {};
  Object.keys(defaults).forEach((key) => {
    indexes[key] = resolveColumnIndex(headerMap, key, defaults[key]);
  });
  return indexes;
}

function parsePhotoOrder(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function parsePhotoRows(rows, cols) {
  const list = [];
  const col = getPhotoColumnIndexes(rows, cols);

  for (let index = 0; index < rows.length; index++) {
    const c = rows[index].c || [];
    if (isPhotoHeaderRow(c)) continue;

    const folder = String(cellValue(c[col.folder]) || "").trim();
    const file = String(cellValue(c[col.file]) || "").trim();
    if (!folder || !file) continue;

    list.push({
      folder,
      file,
      title: String(cellTextValue(c[col.title]) || "").trim(),
      description: String(cellTextValue(c[col.description]) || "").trim(),
      date: String(cellValue(c[col.date]) || "").trim(),
      creator: String(cellValue(c[col.creator]) || "").trim(),
      collection: String(cellValue(c[col.collection]) || "").trim(),
      credit: String(cellValue(c[col.credit]) || "").trim(),
      order: parsePhotoOrder(cellValue(c[col.order])),
      genre: String(cellValue(c[col.genre]) || "").trim(),
      pitch: String(cellValue(c[col.pitch]) || "").trim(),
      sheetIndex: index,
    });
  }
  return list;
}

/** 画像データシートの行を取得する（フォルダパス＋データ名が正） */
export async function loadHistoricPhotos() {
  const { rows, cols } = await fetchSheetData(SHEET_PHOTOS);
  return parsePhotoRows(rows, cols);
}

/** 表示名の照合用（括弧以降を除く） */
export function normalizeSpotName(name) {
  return String(name || "")
    .replace(/[（(].*$/, "")
    .trim()
    .toLowerCase();
}
