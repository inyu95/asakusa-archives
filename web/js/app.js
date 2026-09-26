/* global Cesium */

import {
  loadHistoricPhotos,
  loadMappingContent,
  normalizeSpotName,
} from "./sheets.js";
import { attachSpotPhotos } from "./photos.js";

/**
 * 浅草範囲に絞ったローカル tileset（平坦な葉タイルのみ。REPLACE 階層なし）。
 * 生成: npm run trim:plateau-asakusa。中身のタイルは PLATEAU CDN を参照。
 */
const PLATEAU_TILESET_URL = "data/plateau-asakusa-bldg-lod2.json";

/** PLATEAU 建物と垂直基準を揃えた楕円体高の地形（ジオイド補正済み） */
const PLATEAU_TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain";

/** モデル／建物が極端に暗くならないよう、太陽が高い時刻に固定（UTC = JST 正午付近） */
const DAYLIGHT_TIME_ISO = "2025-06-21T03:00:00Z";

/** 葉タイル固定のため SSE は安定表示向けの一定値（キャッシュ不足時は memoryAdjustedSSE が上がるので注意） */
const BUILDING_SSE = 16;

/**
 * 起動直後の視点（凌雲閣付近）。
 * 俯瞰→接近の flyTo だとタイルを二重取得するので、最初からここを向ける。
 */
const INITIAL_VIEW = {
  lon: 139.7932,
  lat: 35.7158,
  height: 220,
  heading: 30,
  pitch: -28,
};

/**
 * PLATEAU VIEW 5.0（Re:Earth）相当の IBL 係数。
 * カスタムシェーダで白飛ばさず、公式配信に近い建物の見え方にする。
 */
const PLATEAU_VIEW_SH_COEFFICIENTS = [
  new Cesium.Cartesian3(0.651181936264038, 0.651181936264038, 0.651181936264038),
  new Cesium.Cartesian3(0.335859775543213, 0.335859775543213, 0.335859775543213),
  new Cesium.Cartesian3(8.74592729e-7, 8.74592729e-7, 8.74592729e-7),
  new Cesium.Cartesian3(2.7729817e-8, 2.7729817e-8, 2.7729817e-8),
  new Cesium.Cartesian3(1.4838997e-8, 1.4838997e-8, 1.4838997e-8),
  new Cesium.Cartesian3(-5.038311e-9, -5.038311e-9, -5.038311e-9),
  new Cesium.Cartesian3(0.000121221753943, 0.000121221753943, 0.000121221753943),
  new Cesium.Cartesian3(2.82587223e-7, 2.82587223e-7, 2.82587223e-7),
  new Cesium.Cartesian3(0.000364663166692, 0.000364663166692, 0.000364663166692),
];

/** PLATEAU VIEW 相当のシーン光強度（VIEW 本体は 12 だが、航空写真ベースでは白飛びしやすいので抑える） */
const PLATEAU_VIEW_LIGHT_INTENSITY = 2.5;

/**
 * タイルセットを PLATEAU VIEW に近い照明にする（UNLIT / 色加算はしない）。
 * @param {Cesium.Cesium3DTileset} tileset
 */
function applyPlateauViewLighting(tileset) {
  tileset.customShader = undefined;
  tileset.style = undefined;

  if (tileset.imageBasedLighting) {
    tileset.imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(
      1.0,
      1.0
    );
    tileset.imageBasedLighting.sphericalHarmonicCoefficients =
      PLATEAU_VIEW_SH_COEFFICIENTS;
  }

  // Cesium 1.123+ の動的環境マップは公式 VIEW（1.118）に無いので無効化
  if (tileset.environmentMapManager) {
    tileset.environmentMapManager.enabled = false;
  }
}

/**
 * @param {Cesium.Viewer} viewer
 */
function applyPlateauViewSceneLighting(viewer) {
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(DAYLIGHT_TIME_ISO);
  viewer.clock.shouldAnimate = false;

  if (viewer.scene.light) {
    viewer.scene.light.color = Cesium.Color.WHITE;
    if ("intensity" in viewer.scene.light) {
      viewer.scene.light.intensity = PLATEAU_VIEW_LIGHT_INTENSITY;
    }
  }

  // 地形ライティングは重いのでオフ（建物・モデルの見た目は IBL 側で担保）
  viewer.scene.globe.enableLighting = false;
  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.0002;
  viewer.scene.highDynamicRange = false;

  if (viewer.scene.skyAtmosphere) {
    viewer.scene.skyAtmosphere.saturationShift = -1;
    viewer.scene.skyAtmosphere.brightnessShift = 0;
  }
  if (viewer.scene.sun) {
    viewer.scene.sun.show = false;
  }
}

/**
 * PLATEAU CDN への並列リクエスト上限を上げ、タイル取得を速くする。
 */
function boostPlateauRequestConcurrency() {
  const hosts = [
    "assets.cms.plateau.reearth.io",
    "api.plateauview.mlit.go.jp",
    "tile.plateauview.mlit.go.jp",
  ];
  for (const host of hosts) {
    Cesium.RequestScheduler.requestsByServer[`${host}:443`] = 24;
  }
  if (Cesium.RequestScheduler.maximumRequestsPerServer < 24) {
    Cesium.RequestScheduler.maximumRequestsPerServer = 24;
  }
}

/**
 * @param {Cesium.Viewer} viewer
 * @returns {Promise<Cesium.Cesium3DTileset>}
 */
async function loadAsakusaBuildings(viewer) {
  boostPlateauRequestConcurrency();

  const tileset = await Cesium.Cesium3DTileset.fromUrl(PLATEAU_TILESET_URL, {
    maximumScreenSpaceError: BUILDING_SSE,
    // カメラ移動中にタイルを捨てない／周辺を遅延させない（消えたり出たり防止）
    dynamicScreenSpaceError: false,
    foveatedScreenSpaceError: false,
    cullRequestsWhileMoving: false,
    loadSiblings: true,
    skipLevelOfDetail: false,
    immediatelyLoadDesiredLevelOfDetail: false,
    preloadWhenHidden: false,
    preloadFlightDestinations: false,
    shadows: Cesium.ShadowMode.DISABLED,
    // LOD2 テクスチャが重い。キャッシュ不足だと memoryAdjustedSSE が上がり
    // アングル変更で精緻化が止まり建物が消える。
    cacheBytes: 4 * 1024 * 1024 * 1024,
    maximumCacheOverflowBytes: 2 * 1024 * 1024 * 1024,
  });

  tileset.tileFailed.addEventListener((error) => {
    console.warn("PLATEAU tile failed:", error?.url || error);
  });

  applyPlateauViewLighting(tileset);
  // 範囲制限は trim 済み tileset 側で行う（ClippingPolygon はアングル次第で消失の原因になる）
  viewer.scene.primitives.add(tileset);
  viewer.scene.requestRender();
  return tileset;
}

const statusEl = document.getElementById("status");
const infoPanel = document.getElementById("infoPanel");
const infoClose = document.getElementById("infoClose");
const infoTitle = document.getElementById("infoTitle");
const infoYears = document.getElementById("infoYears");
const infoDescription = document.getElementById("infoDescription");
const infoNote = document.getElementById("infoNote");
const infoSources = document.getElementById("infoSources");
const infoImage = document.getElementById("infoImage");
const infoImageButton = document.getElementById("infoImageButton");
const infoGallery = document.getElementById("infoGallery");
const infoGalleryPrev = document.getElementById("infoGalleryPrev");
const infoGalleryNext = document.getElementById("infoGalleryNext");
const infoGalleryCounter = document.getElementById("infoGalleryCounter");
const infoPhotoListToggle = document.getElementById("infoPhotoListToggle");
const infoPhotoList = document.getElementById("infoPhotoList");
const photoThumbLightbox = document.getElementById("photoThumbLightbox");
const photoThumbClose = document.getElementById("photoThumbClose");
const photoThumbSubtitle = document.getElementById("photoThumbSubtitle");
const photoLightbox = document.getElementById("photoLightbox");
const lightboxClose = document.getElementById("lightboxClose");
const lightboxImage = document.getElementById("lightboxImage");
const lightboxTitle = document.getElementById("lightboxTitle");
const lightboxMeta = document.getElementById("lightboxMeta");
const lightboxDescription = document.getElementById("lightboxDescription");
const lightboxCredit = document.getElementById("lightboxCredit");
const lightboxPrev = document.getElementById("lightboxPrev");
const lightboxNext = document.getElementById("lightboxNext");
const lightboxPhotoListToggle = document.getElementById("lightboxPhotoListToggle");

/** @type {Map<string, object>} */
const spotById = new Map();

/** @type {Array<object>} */
let galleryImages = [];
let galleryIndex = 0;
let lightboxIndex = 0;
let photoListOpen = false;

function setStatus(message, isError = false) {
  if (!statusEl) return;
  if (!message) {
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.classList.remove("hidden");
  statusEl.classList.toggle("error", isError);
  statusEl.textContent = message;
}

function formatLightboxMeta(photo) {
  return [photo.date, photo.creator, photo.genre].filter(Boolean).join(" · ");
}

function formatPhotoCredit(photo) {
  return [photo.credit, photo.collection].filter(Boolean).join(" / ");
}

function isPhotoLightboxOpen() {
  return Boolean(
    photoLightbox &&
      !photoLightbox.hidden &&
      !photoLightbox.classList.contains("hidden")
  );
}

function isPhotoThumbLightboxOpen() {
  return Boolean(
    photoThumbLightbox &&
      !photoThumbLightbox.hidden &&
      !photoThumbLightbox.classList.contains("hidden")
  );
}

function syncPhotoListToggleState() {
  const toggles = [infoPhotoListToggle, lightboxPhotoListToggle].filter(Boolean);
  for (const toggle of toggles) {
    toggle.setAttribute("aria-expanded", photoListOpen ? "true" : "false");
    toggle.setAttribute(
      "aria-label",
      photoListOpen ? "写真一覧を閉じる" : "写真一覧を表示"
    );
  }
}

function setPhotoListOpen(open) {
  photoListOpen = Boolean(open) && galleryImages.length > 1;

  if (photoThumbLightbox) {
    photoThumbLightbox.hidden = !photoListOpen;
    photoThumbLightbox.classList.toggle("hidden", !photoListOpen);
  }

  if (photoThumbSubtitle) {
    const spotName = infoTitle?.textContent?.trim() || "";
    photoThumbSubtitle.textContent = photoListOpen
      ? (spotName
          ? `${spotName} · ${galleryImages.length}枚`
          : `${galleryImages.length}枚`)
      : "";
  }

  syncPhotoListToggleState();

  if (photoListOpen) {
    renderPhotoList();
  }
}

function renderPhotoList() {
  if (!infoPhotoList) return;
  infoPhotoList.replaceChildren();
  const activeIndex = isPhotoLightboxOpen() ? lightboxIndex : galleryIndex;

  galleryImages.forEach((photo, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "info-photo-list-item" + (index === activeIndex ? " is-active" : "");
    button.setAttribute("role", "option");
    button.setAttribute(
      "aria-selected",
      index === activeIndex ? "true" : "false"
    );
    const label =
      photo.title || photo.file || "写真 " + (index + 1);
    button.setAttribute("aria-label", label);
    button.title = label;

    const media = document.createElement("span");
    media.className = "info-photo-list-media";
    const thumb = document.createElement("img");
    thumb.className = "info-photo-list-thumb";
    thumb.src = photo.url;
    thumb.alt = "";
    thumb.loading = "lazy";
    media.append(thumb);
    button.append(media);

    const caption = document.createElement("span");
    caption.className = "info-photo-list-caption";
    const titleEl = document.createElement("span");
    titleEl.className = "info-photo-list-title";
    titleEl.textContent = photo.title || label;
    caption.append(titleEl);
    if (photo.date) {
      const dateEl = document.createElement("span");
      dateEl.className = "info-photo-list-date";
      dateEl.textContent = photo.date;
      caption.append(dateEl);
    }
    button.append(caption);

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      setPhotoListOpen(false);
      if (isPhotoLightboxOpen()) {
        selectLightboxPhoto(index);
      } else {
        selectGalleryPhoto(index);
        openPhotoLightbox(galleryImages[index]);
      }
    });
    infoPhotoList.append(button);
  });
}

function updateLightboxView() {
  if (!isPhotoLightboxOpen()) return;
  const photo = galleryImages[lightboxIndex] || galleryImages[0];
  if (!photo) {
    closePhotoLightbox();
    return;
  }

  if (lightboxImage) {
    lightboxImage.src = photo.url;
    lightboxImage.alt = photo.title || "";
  }
  if (lightboxTitle) lightboxTitle.textContent = photo.title || "";
  if (lightboxMeta) lightboxMeta.textContent = formatLightboxMeta(photo);
  if (lightboxDescription) {
    lightboxDescription.textContent = photo.description || "";
  }
  if (lightboxCredit) lightboxCredit.textContent = formatPhotoCredit(photo);

  const hasMultiple = galleryImages.length > 1;
  if (lightboxPrev) {
    lightboxPrev.classList.toggle("hidden", !hasMultiple);
    lightboxPrev.disabled = !hasMultiple;
  }
  if (lightboxNext) {
    lightboxNext.classList.toggle("hidden", !hasMultiple);
    lightboxNext.disabled = !hasMultiple;
  }
}

function closePhotoLightbox() {
  if (!photoLightbox) return;
  photoLightbox.classList.add("hidden");
  photoLightbox.hidden = true;
  if (lightboxImage) lightboxImage.removeAttribute("src");
}

function openPhotoLightbox(photo) {
  if (!photoLightbox || !photo?.url) return;

  const index = galleryImages.findIndex((item) => item === photo || item.url === photo.url);
  lightboxIndex = index >= 0 ? index : galleryIndex;

  photoLightbox.hidden = false;
  photoLightbox.classList.remove("hidden");
  updateLightboxView();
}

function hideInfo() {
  closePhotoLightbox();
  setPhotoListOpen(false);
  infoPanel.classList.add("hidden");
  galleryImages = [];
  galleryIndex = 0;
  lightboxIndex = 0;
}

function updateGalleryView() {
  const hasImages = galleryImages.length > 0;
  const hasMultiple = galleryImages.length > 1;

  if (infoGallery) {
    infoGallery.classList.toggle("hidden", !hasImages);
  }

  if (!hasImages) {
    if (infoImage) {
      infoImage.removeAttribute("src");
      infoImage.classList.add("hidden");
    }
    if (infoImageButton) infoImageButton.disabled = true;
    if (infoPhotoListToggle) infoPhotoListToggle.classList.add("hidden");
    if (lightboxPhotoListToggle) lightboxPhotoListToggle.classList.add("hidden");
    setPhotoListOpen(false);
    if (infoPhotoList) infoPhotoList.replaceChildren();
    return;
  }

  const photo = galleryImages[galleryIndex] || galleryImages[0];
  if (infoImage) {
    infoImage.src = photo.url;
    infoImage.alt = photo.title || infoTitle?.textContent || "";
    infoImage.classList.remove("hidden");
  }
  if (infoImageButton) infoImageButton.disabled = false;

  if (infoPhotoListToggle) {
    infoPhotoListToggle.classList.toggle("hidden", !hasMultiple);
  }
  if (lightboxPhotoListToggle) {
    lightboxPhotoListToggle.classList.toggle("hidden", !hasMultiple);
  }
  if (photoListOpen) {
    renderPhotoList();
  }
  if (!hasMultiple) setPhotoListOpen(false);

  if (infoGalleryPrev) {
    infoGalleryPrev.classList.toggle("hidden", !hasMultiple);
    infoGalleryPrev.disabled = !hasMultiple;
  }
  if (infoGalleryNext) {
    infoGalleryNext.classList.toggle("hidden", !hasMultiple);
    infoGalleryNext.disabled = !hasMultiple;
  }
  if (infoGalleryCounter) {
    if (hasMultiple) {
      infoGalleryCounter.textContent =
        galleryIndex + 1 + " / " + galleryImages.length;
      infoGalleryCounter.classList.remove("hidden");
    } else {
      infoGalleryCounter.textContent = "";
      infoGalleryCounter.classList.add("hidden");
    }
  }
}

function selectGalleryPhoto(index) {
  if (!galleryImages.length) return;
  galleryIndex = ((index % galleryImages.length) + galleryImages.length) %
    galleryImages.length;
  updateGalleryView();
}

function selectLightboxPhoto(index) {
  if (!galleryImages.length) return;
  lightboxIndex = ((index % galleryImages.length) + galleryImages.length) %
    galleryImages.length;
  updateLightboxView();
}

function shiftGallery(delta) {
  if (galleryImages.length <= 1) return;
  selectGalleryPhoto(galleryIndex + delta);
}

function shiftLightbox(delta) {
  if (galleryImages.length <= 1) return;
  selectLightboxPhoto(lightboxIndex + delta);
}

function showSpotInfo(spot) {
  infoTitle.textContent = spot.name ?? "";
  infoYears.textContent =
    spot.yearFrom && spot.yearTo
      ? `${spot.yearFrom}–${spot.yearTo}`
      : spot.yearFrom
        ? String(spot.yearFrom)
        : "";
  infoDescription.textContent = spot.description ?? "";
  infoNote.textContent = spot.note ?? "";

  infoSources.replaceChildren();
  for (const source of spot.sources ?? []) {
    const li = document.createElement("li");
    if (source.url) {
      const a = document.createElement("a");
      a.href = source.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = source.label ?? source.url;
      li.append(a);
    } else {
      li.textContent = source.label ?? "";
    }
    infoSources.append(li);
  }

  galleryImages = Array.isArray(spot.images)
    ? spot.images.filter((p) => p && p.url)
    : spot.image
      ? [{ url: spot.image, title: "" }]
      : [];
  galleryIndex = 0;
  lightboxIndex = 0;
  setPhotoListOpen(false);
  updateGalleryView();

  infoPanel.classList.remove("hidden");
}

function createGsiImageryProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
    maximumLevel: 18,
    credit: "地理院タイル",
  });
}

async function loadSpotsMeta() {
  const response = await fetch("data/spots.json");
  if (!response.ok) {
    throw new Error(`spots.json の取得に失敗 (${response.status})`);
  }
  const data = await response.json();
  return Array.isArray(data.spots) ? data.spots : data;
}

function findMetaForContent(metas, content) {
  if (content.id) {
    const byId = metas.find((m) => m.id === content.id);
    if (byId) return byId;
  }
  const key = normalizeSpotName(content.name);
  if (!key) return null;
  return (
    metas.find((m) => normalizeSpotName(m.name) === key) ||
    metas.find((m) => normalizeSpotName(m.sheetName) === key) ||
    null
  );
}

/** 配置用フィールドのみ（コンテンツはシート側） */
const PLACEMENT_KEYS = [
  "id",
  "sheetName",
  "lat",
  "lon",
  "height",
  "heightOffset",
  "heading",
  "pitch",
  "roll",
  "scale",
  "model",
  "markerHeight",
  "visibility",
];

function pickPlacement(meta) {
  if (!meta) return {};
  const out = {};
  for (const key of PLACEMENT_KEYS) {
    if (meta[key] != null && meta[key] !== "") out[key] = meta[key];
  }
  return out;
}

/**
 * spots.json = Unity モデル配置、シート = ピン位置＋情報パネル。
 * ピン座標はシート正。モデル座標は JSON（無いときはピン座標にフォールバック）。
 */
function mergeSpot(meta, content) {
  const placement = pickPlacement(meta);
  if (!content) {
    // シート行なし: JSON の座標をピン／モデル両方のフォールバックにする
    if (placement.lat == null || placement.lon == null) return placement;
    return {
      ...placement,
      modelLat: placement.lat,
      modelLon: placement.lon,
    };
  }

  const pinLat = content.lat != null ? content.lat : placement.lat;
  const pinLon = content.lon != null ? content.lon : placement.lon;
  const modelLat = placement.lat != null ? placement.lat : pinLat;
  const modelLon = placement.lon != null ? placement.lon : pinLon;

  return {
    ...placement,
    id: placement.id || content.id || slugifyId(content.name),
    name: content.name || placement.sheetName || "",
    // ピン（シート正）
    lat: pinLat,
    lon: pinLon,
    // 3D モデル（Unity / spots.json 正）
    modelLat,
    modelLon,
    description: content.description || "",
    note: content.note || "",
    imageFolder: content.imageFolder || "",
    image: content.image || "",
    yearFrom: content.yearFrom || "",
    yearTo: content.yearTo || "",
    category: content.category || "",
    role: content.role || "",
    sources: content.sources || [],
  };
}

function slugifyId(name) {
  const key = normalizeSpotName(name) || "spot";
  return key.replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]+/g, "-") || "spot";
}

/**
 * spots.json（Unity モデル配置）とスプレッドシート「マッピング」（ピン＋コンテンツ）をマージする。
 * 情報パネルの文言・写真・URL・年代とピン位置はシート。モデル位置は JSON。
 */
async function loadSpots() {
  const [metas, contents, photoRecords] = await Promise.all([
    loadSpotsMeta(),
    loadMappingContent().catch((err) => {
      console.warn(
        "マッピングシートの取得に失敗。配置のみ表示します（情報パネルは空）",
        err
      );
      return [];
    }),
    loadHistoricPhotos().catch((err) => {
      console.warn("画像データシートの取得に失敗。写真なしで表示します", err);
      return [];
    }),
  ]);

  const usedMetaIds = new Set();
  const spots = [];

  for (const content of contents) {
    const meta = findMetaForContent(metas, content);
    if (meta?.id) usedMetaIds.add(meta.id);
    const spot = mergeSpot(meta, content);
    if (spot.lat == null || spot.lon == null) {
      console.warn(
        "ピン座標がないためスキップ:",
        spot.name || spot.id || "(無名)"
      );
      continue;
    }
    spots.push(spot);
  }

  for (const meta of metas) {
    if (meta.id && usedMetaIds.has(meta.id)) continue;
    const spot = mergeSpot(meta, null);
    if (spot.lat == null || spot.lon == null) continue;
    spots.push(spot);
  }

  await attachSpotPhotos(spots, photoRecords);
  return spots;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {object} spot
 */
async function addSpotModel(viewer, spot) {
  const modelLon = spot.modelLon ?? spot.lon;
  const modelLat = spot.modelLat ?? spot.lat;
  let height = spot.height ?? 0;
  // 地形がある場合は楕円体高をサンプリングして接地（固定値のずれを防ぐ）
  try {
    const carto = Cesium.Cartographic.fromDegrees(modelLon, modelLat);
    const sampled = await Cesium.sampleTerrainMostDetailed(
      viewer.terrainProvider,
      [carto]
    );
    if (Number.isFinite(sampled[0]?.height)) {
      height = sampled[0].height + (spot.heightOffset ?? 0);
    }
  } catch (err) {
    console.warn(`地形サンプリング失敗 (${spot.id})、spots.json の height を使用`, err);
  }

  const heading = Cesium.Math.toRadians(spot.heading ?? 0);
  const pitch = Cesium.Math.toRadians(spot.pitch ?? 0);
  const roll = Cesium.Math.toRadians(spot.roll ?? 0);
  const position = Cesium.Cartesian3.fromDegrees(modelLon, modelLat, height);
  const orientation = Cesium.Transforms.headingPitchRollQuaternion(
    position,
    new Cesium.HeadingPitchRoll(heading, pitch, roll)
  );

  const entity = viewer.entities.add({
    id: spot.id,
    name: spot.name,
    position,
    orientation,
    model: {
      uri: spot.model,
      scale: spot.scale ?? 1,
      // 遠距離で無理に大きく描かない（ピクセル拡大は負荷が増える）
      minimumPixelSize: 0,
      maximumScale: 20000,
      heightReference: Cesium.HeightReference.NONE,
      // シーン光＋既定 IBL に任せる（強い補正は白飛び／黒潰れの原因）
      imageBasedLightingFactor: new Cesium.Cartesian2(1.0, 1.0),
      // 約 2.5 km 以遠は描画スキップ
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2500),
    },
  });

  spotById.set(spot.id, spot);
  return entity;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {object} spot
 */
async function addSpotMarker(viewer, spot) {
  const markerOffset = spot.markerHeight ?? 55;
  let height = markerOffset;
  try {
    const carto = Cesium.Cartographic.fromDegrees(spot.lon, spot.lat);
    const sampled = await Cesium.sampleTerrainMostDetailed(
      viewer.terrainProvider,
      [carto]
    );
    if (Number.isFinite(sampled[0]?.height)) {
      height = sampled[0].height + markerOffset;
    }
  } catch (err) {
    console.warn(`ピン用地形サンプリング失敗 (${spot.id})`, err);
  }

  viewer.entities.add({
    id: `${spot.id}-marker`,
    name: spot.name,
    position: Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, height),
    label: {
      text: spot.name,
      font: "14px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -8),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    point: {
      pixelSize: 10,
      color: Cesium.Color.fromCssColorString("#c45c26"),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

function setupClickHandler(viewer) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (!Cesium.defined(picked) || !picked.id) {
      hideInfo();
      return;
    }

    const entityId = typeof picked.id === "string" ? picked.id : picked.id.id;
    const spotId = String(entityId).replace(/-marker$/, "");
    const spot = spotById.get(spotId);
    if (spot) {
      showSpotInfo(spot);
    } else {
      hideInfo();
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

async function main() {
  if (typeof Cesium === "undefined") {
    setStatus("Cesium の読み込みに失敗しました", true);
    return;
  }

  infoClose.addEventListener("click", hideInfo);
  if (infoGalleryPrev) {
    infoGalleryPrev.addEventListener("click", () => shiftGallery(-1));
  }
  if (infoGalleryNext) {
    infoGalleryNext.addEventListener("click", () => shiftGallery(1));
  }
  if (infoPhotoListToggle) {
    infoPhotoListToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setPhotoListOpen(!photoListOpen);
    });
  }
  if (lightboxPhotoListToggle) {
    lightboxPhotoListToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setPhotoListOpen(!photoListOpen);
    });
  }
  if (infoImageButton) {
    infoImageButton.addEventListener("click", () => {
      const photo = galleryImages[galleryIndex] || galleryImages[0];
      if (photo) openPhotoLightbox(photo);
    });
  }
  if (photoThumbClose) {
    photoThumbClose.addEventListener("click", () => setPhotoListOpen(false));
  }
  if (photoThumbLightbox) {
    photoThumbLightbox.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.thumbClose != null) {
        setPhotoListOpen(false);
      }
    });
  }
  if (lightboxClose) {
    lightboxClose.addEventListener("click", closePhotoLightbox);
  }
  if (lightboxPrev) {
    lightboxPrev.addEventListener("click", () => shiftLightbox(-1));
  }
  if (lightboxNext) {
    lightboxNext.addEventListener("click", () => shiftLightbox(1));
  }
  if (photoLightbox) {
    photoLightbox.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.lightboxClose != null) {
        closePhotoLightbox();
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (isPhotoLightboxOpen()) {
        closePhotoLightbox();
        return;
      }
      if (isPhotoThumbLightboxOpen() || photoListOpen) {
        setPhotoListOpen(false);
        return;
      }
      if (infoPanel && !infoPanel.classList.contains("hidden")) {
        hideInfo();
      }
      return;
    }

    if (!galleryImages.length || galleryImages.length <= 1) return;
    if (
      !isPhotoLightboxOpen() &&
      !isPhotoThumbLightboxOpen() &&
      (!infoPanel || infoPanel.classList.contains("hidden"))
    ) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (isPhotoLightboxOpen()) shiftLightbox(-1);
      else shiftGallery(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (isPhotoLightboxOpen()) shiftLightbox(1);
      else shiftGallery(1);
    }
  });

  setStatus("地図を初期化中…");

  const viewer = new Cesium.Viewer("cesiumContainer", {
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: true,
    infoBox: false,
    selectionIndicator: false,
    baseLayer: false,
    // カメラ停止中は再描画しない（アイドル時の CPU/GPU 負荷を大幅削減）
    requestRenderMode: true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    targetFrameRate: 60,
  });

  // HiDPI 端末でも描画解像度を抑え、操作中のフレーム落ちを緩和
  const dpr = window.devicePixelRatio || 1;
  viewer.resolutionScale = Math.min(1, 1 / Math.sqrt(dpr));
  viewer.scene.fxaa = true;
  viewer.scene.globe.maximumScreenSpaceError = 2;
  viewer.scene.globe.tileCacheSize = 100;

  viewer.imageryLayers.addImageryProvider(createGsiImageryProvider());
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#bfbfbf");
  viewer.scene.globe.depthTestAgainstTerrain = true;
  applyPlateauViewSceneLighting(viewer);
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 20;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = 8000;

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      INITIAL_VIEW.lon,
      INITIAL_VIEW.lat,
      INITIAL_VIEW.height
    ),
    orientation: {
      heading: Cesium.Math.toRadians(INITIAL_VIEW.heading),
      pitch: Cesium.Math.toRadians(INITIAL_VIEW.pitch),
      roll: 0,
    },
  });

  setupClickHandler(viewer);
  window.__asakusaViewer = viewer;

  // 地形・建物・スポットを並行開始（地形待ちで建物が止まらないようにする）
  setStatus("浅草エリアを読み込み中…");
  const terrainPromise = Cesium.CesiumTerrainProvider.fromUrl(
    PLATEAU_TERRAIN_URL,
    { requestVertexNormals: false }
  )
    .then((terrainProvider) => {
      viewer.terrainProvider = terrainProvider;
      viewer.scene.requestRender();
    })
    .catch((terrainErr) => {
      console.warn("PLATEAU-Terrain の読み込みに失敗:", terrainErr);
    });

  const buildingsPromise = loadAsakusaBuildings(viewer).catch((err) => {
    console.error(err);
    setStatus(
      "PLATEAU 建物の読み込みに失敗しました（地形・スポットのみ表示）",
      true
    );
    return null;
  });

  try {
    const [spots] = await Promise.all([loadSpots(), terrainPromise]);
    for (const spot of spots) {
      if (spot.visibility === "ar") continue;
      spotById.set(spot.id, spot);
      await addSpotMarker(viewer, spot);
      if (spot.model) {
        try {
          await addSpotModel(viewer, spot);
        } catch (modelErr) {
          console.warn(`モデル読込失敗: ${spot.id}`, modelErr);
        }
      }
    }

    viewer.scene.requestRender();
    await buildingsPromise;
    setStatus("凌雲閣をクリックすると説明が表示されます");
    setTimeout(() => setStatus(""), 5000);
  } catch (err) {
    console.error(err);
    setStatus(`スポット読込失敗: ${err.message}`, true);
    await buildingsPromise;
  }
}

main().catch((err) => {
  console.error(err);
  setStatus(`起動エラー: ${err.message}`, true);
});
