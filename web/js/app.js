/* global Cesium */

import { loadMappingContent, normalizeSpotName } from "./sheets.js";
import { attachSpotPhotos } from "./photos.js";

const PLATEAU_TILESET_URL =
  "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13106-bldg-lod2-2025/tileset.json";

/** PLATEAU 建物と垂直基準を揃えた楕円体高の地形（ジオイド補正済み） */
const PLATEAU_TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain";

/** モデル／建物が極端に暗くならないよう、太陽が高い時刻に固定（UTC = JST 正午付近） */
const DAYLIGHT_TIME_ISO = "2025-06-21T03:00:00Z";

const INITIAL_VIEW = {
  lon: 139.7945,
  lat: 35.7142,
  height: 420,
  heading: 20,
  pitch: -35,
};

/**
 * 浅草エリア（雷門〜浅草寺〜六区〜吾妻橋付近）。
 * 3D 建物はこの矩形内だけ表示し、外側は地形・航空写真のみ。
 */
const ASAKUSA_BOUNDS = {
  west: 139.788,
  south: 35.708,
  east: 139.803,
  north: 35.722,
};

function asakusaRectangle() {
  return Cesium.Rectangle.fromDegrees(
    ASAKUSA_BOUNDS.west,
    ASAKUSA_BOUNDS.south,
    ASAKUSA_BOUNDS.east,
    ASAKUSA_BOUNDS.north
  );
}

/**
 * PLATEAU 建物を浅草矩形の外側でクリップする（外側は地形のみ見える）。
 * @param {Cesium.Cesium3DTileset} tileset
 */
function clipBuildingsToAsakusa(tileset) {
  if (
    typeof Cesium.ClippingPolygon === "undefined" ||
    typeof Cesium.ClippingPolygonCollection === "undefined"
  ) {
    console.warn("ClippingPolygon 非対応のため、建物のエリア制限をスキップします");
    return;
  }

  const rect = asakusaRectangle();
  const positions = [
    Cesium.Cartesian3.fromRadians(rect.west, rect.south),
    Cesium.Cartesian3.fromRadians(rect.east, rect.south),
    Cesium.Cartesian3.fromRadians(rect.east, rect.north),
    Cesium.Cartesian3.fromRadians(rect.west, rect.north),
  ];

  tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({
    polygons: [new Cesium.ClippingPolygon({ positions })],
    // true = 多角形の外側をクリップ → 浅草内だけ建物が残る
    inverse: true,
  });
}

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

  viewer.scene.globe.enableLighting = true;
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
 * @param {Cesium.Viewer} viewer
 * @returns {Promise<Cesium.Cesium3DTileset>}
 */
async function loadAsakusaBuildings(viewer) {
  const tileset = await Cesium.Cesium3DTileset.fromUrl(PLATEAU_TILESET_URL, {
    maximumScreenSpaceError: 16,
    loadSiblings: false,
    skipLevelOfDetail: true,
    immediatelyLoadDesiredLevelOfDetail: false,
  });

  // PLATEAU VIEW 相当の照明（カスタムシェーダによる白飛び補正はしない）
  applyPlateauViewLighting(tileset);
  clipBuildingsToAsakusa(tileset);
  viewer.scene.primitives.add(tileset);
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
const infoGallery = document.getElementById("infoGallery");
const infoGalleryPrev = document.getElementById("infoGalleryPrev");
const infoGalleryNext = document.getElementById("infoGalleryNext");
const infoGalleryCounter = document.getElementById("infoGalleryCounter");

/** @type {Map<string, object>} */
const spotById = new Map();

/** @type {Array<{url:string,title?:string}>} */
let galleryImages = [];
let galleryIndex = 0;

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

function hideInfo() {
  infoPanel.classList.add("hidden");
  galleryImages = [];
  galleryIndex = 0;
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
    return;
  }

  const photo = galleryImages[galleryIndex] || galleryImages[0];
  if (infoImage) {
    infoImage.src = photo.url;
    infoImage.alt = photo.title || infoTitle?.textContent || "";
    infoImage.classList.remove("hidden");
  }

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

function shiftGallery(delta) {
  if (galleryImages.length <= 1) return;
  galleryIndex =
    (galleryIndex + delta + galleryImages.length) % galleryImages.length;
  updateGalleryView();
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

function pickContent(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  return value;
}

function mergeSpot(meta, content) {
  const base = meta ? { ...meta } : {};
  if (!content) return base;

  const yearFrom = pickContent(content.yearFrom, base.yearFrom);
  const yearTo = pickContent(content.yearTo, base.yearTo);
  const sources =
    content.sources && content.sources.length > 0
      ? content.sources
      : base.sources;

  return {
    ...base,
    id: base.id || content.id || slugifyId(content.name),
    // シート名が短縮形（例: 凌雲閣）のときはメタの正式名を残す
    name: preferDisplayName(content.name, base.name),
    lat: content.lat != null ? content.lat : base.lat,
    lon: content.lon != null ? content.lon : base.lon,
    description: pickContent(content.description, base.description),
    imageFolder: pickContent(content.imageFolder, base.imageFolder),
    image: pickContent(content.image, base.image),
    yearFrom,
    yearTo,
    category: pickContent(content.category, base.category),
    role: pickContent(content.role, base.role),
    sources,
  };
}

function preferDisplayName(sheetName, metaName) {
  const fromSheet = pickContent(sheetName, "");
  const fromMeta = pickContent(metaName, "");
  if (!fromSheet) return fromMeta;
  if (!fromMeta) return fromSheet;
  if (normalizeSpotName(fromSheet) === normalizeSpotName(fromMeta)) {
    return fromMeta.length >= fromSheet.length ? fromMeta : fromSheet;
  }
  return fromSheet;
}

function slugifyId(name) {
  const key = normalizeSpotName(name) || "spot";
  return key.replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]+/g, "-") || "spot";
}

/**
 * spots.json（メタ）とスプレッドシート「マッピング」（コンテンツ）をマージする。
 * シートの非空セルが優先。空の場合は JSON の値をフォールバックに使う。
 */
async function loadSpots() {
  const [metas, contents] = await Promise.all([
    loadSpotsMeta(),
    loadMappingContent().catch((err) => {
      console.warn("マッピングシートの取得に失敗。spots.json のみで表示します", err);
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
        "座標がないためスキップ:",
        spot.name || spot.id || "(無名)"
      );
      continue;
    }
    spots.push(spot);
  }

  for (const meta of metas) {
    if (meta.id && usedMetaIds.has(meta.id)) continue;
    if (meta.lat == null || meta.lon == null) continue;
    spots.push({ ...meta });
  }

  await attachSpotPhotos(spots);
  return spots;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {object} spot
 */
async function addSpotModel(viewer, spot) {
  let height = spot.height ?? 0;
  // 地形がある場合は楕円体高をサンプリングして接地（固定値のずれを防ぐ）
  try {
    const carto = Cesium.Cartographic.fromDegrees(spot.lon, spot.lat);
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
  const position = Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, height);
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
      minimumPixelSize: 48,
      maximumScale: 20000,
      heightReference: Cesium.HeightReference.NONE,
      // シーン光＋既定 IBL に任せる（強い補正は白飛び／黒潰れの原因）
      imageBasedLightingFactor: new Cesium.Cartesian2(1.0, 1.0),
    },
  });

  spotById.set(spot.id, spot);
  return entity;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {object} spot
 */
function addSpotMarker(viewer, spot) {
  const height = (spot.height ?? 0) + (spot.markerHeight ?? 55);
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
  });

  // 地形は全域表示。3D 建物だけ浅草にクリップする
  try {
    const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
      PLATEAU_TERRAIN_URL,
      { requestVertexNormals: true }
    );
    viewer.terrainProvider = terrainProvider;
  } catch (terrainErr) {
    console.warn("PLATEAU-Terrain の読み込みに失敗:", terrainErr);
  }

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

  try {
    setStatus("浅草エリアの建物を読み込み中…");
    await loadAsakusaBuildings(viewer);
  } catch (err) {
    console.error(err);
    setStatus(
      "PLATEAU 建物の読み込みに失敗しました（地形・スポットのみ表示）",
      true
    );
  }

  try {
    setStatus("スポットを配置中…");
    const spots = await loadSpots();
    /** @type {Cesium.Entity|undefined} */
    let focusEntity;
    for (const spot of spots) {
      if (spot.visibility === "ar") continue;
      spotById.set(spot.id, spot);
      addSpotMarker(viewer, spot);
      if (spot.model) {
        try {
          focusEntity = await addSpotModel(viewer, spot);
        } catch (modelErr) {
          console.warn(`モデル読込失敗: ${spot.id}`, modelErr);
        }
      }
    }

    if (focusEntity) {
      await viewer.flyTo(focusEntity, {
        duration: 1.5,
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(30),
          Cesium.Math.toRadians(-25),
          250
        ),
      });
    }
    setStatus("凌雲閣をクリックすると説明が表示されます");
    setTimeout(() => setStatus(""), 5000);
  } catch (err) {
    console.error(err);
    setStatus(`スポット読込失敗: ${err.message}`, true);
  }
}

main().catch((err) => {
  console.error(err);
  setStatus(`起動エラー: ${err.message}`, true);
});
