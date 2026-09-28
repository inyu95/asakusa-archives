/* global Cesium */

import {
  loadCategoryColors,
  loadCategoryList,
  loadHistoricPhotos,
  loadMappingContent,
  normalizeSpotName,
} from "./sheets.js";
import { attachSpotPhotos } from "./photos.js";
import {
  createPinMarkerImageDataUrl,
} from "./pin-art.js";

/** カテゴリアイコンのベースパス（ファイル名 = カテゴリ名.png） */
const ASSETS_CATEGORY_BASE = "assets/category/";

/** ピンの足の高さ（m）。シート「ピン長さ」→ spots.json markerHeight → この既定値 */
const PIN_POLE_HEIGHT_METERS = 36;
const PIN_STEM_WIDTH = 1.5;
const PIN_STEM_COLOR = "#ffffff";
const PIN_STEM_ALPHA = 0.85;
/** イントロ後のピン出現（ふわっと） */
const PIN_REVEAL_MS = 780;
const PIN_REVEAL_FROM_SCALE = 0.86;

/** カテゴリ名 → ピン色（カテゴリリスト B 列） */
let categoryColorByName = new Map();

/** @type {object[]} */
let allSpots = [];

/** イントロ引き完了前はピン／モデルを出さない */
let introMarkersRevealed = false;

/** @type {string[]} */
let categoryOptions = [];

/** @type {Set<string>} */
const selectedCategories = new Set();

/**
 * 浅草寺中心・半径 1 km 円に絞ったローカル tileset（平坦な葉タイルのみ。REPLACE 階層なし）。
 * 生成: npm run trim:plateau-asakusa。中身のタイルは PLATEAU CDN を参照。
 * 表示時は ClippingPolygon で円境界にさらに整形する。
 */
const PLATEAU_TILESET_URLS = {
  /** 台東区 建築物 LOD2 */
  taitoBldg: "data/plateau-asakusa-bldg-lod2.json",
  /** 墨田区 建築物 LOD2（隅田川対岸） */
  sumidaBldg: "data/plateau-sumida-bldg-lod2.json",
  /** 台東区 橋梁 LOD2（吾妻橋など） */
  taitoBrid: "data/plateau-taito-brid-lod2.json",
};

/** PLATEAU 建物と垂直基準を揃えた楕円体高の地形（ジオイド補正済み） */
const PLATEAU_TERRAIN_URL = "https://tile.plateauview.mlit.go.jp/terrain";

/** モデル／建物が極端に暗くならないよう、太陽が高い時刻に固定（UTC = JST 正午付近） */
const DAYLIGHT_TIME_ISO = "2025-06-21T03:00:00Z";

/** 葉タイル固定のため SSE は安定表示向けの一定値（キャッシュ不足時は memoryAdjustedSSE が上がるので注意） */
const BUILDING_SSE = 16;

/**
 * 建物表示範囲（浅草寺中心・半径 1 km）。
 * Wikipedia: 北緯 35.71472 / 東経 139.796750
 */
const BUILDING_CLIP = {
  lon: 139.79675,
  lat: 35.71472,
  radiusMeters: 1000,
  segments: 64,
};

/**
 * 起動直後の寄り視点（雷門正面・絶対姿勢）。
 * lon/lat/height/heading/pitch は DEV「初期視点用コピー」の値そのもの。
 * focus* は引きカメラ・DEV の注視点基準用。
 *
 * 注視点は雷門中央付近（Wikipedia/地図: 約 35.71111, 139.79639）。
 */
const INITIAL_VIEW = {
  lon: 139.796332,
  lat: 35.710727,
  height: 46.21,
  heading: 5.2,
  pitch: -1.1,
  // 注視点（雷門やや上方）。高いほど寄りで門が画面下に寄る
  focusLon: 139.79637,
  focusLat: 35.71111,
  focusHeight: 47,
};

/**
 * イントロ引きの最終俯瞰（絶対姿勢）。
 * 円全体は必須にせず、寄りからある程度引いた位置で止める。
 */
const OVERVIEW_VIEW = {
  lon: 139.7950,
  lat: 35.7005,
  height: 980,
  heading: 5.2,
  pitch: -38,
  /** 寄り→全体の飛行秒数 */
  duration: 3.4,
  /** 寄り表示を少し見せてから引き始める待ち（ms） */
  holdMs: 650,
};

/** 冒頭寄りで雷門が欠けないよう、一時的に細かくする SSE */
const INTRO_BUILDING_SSE = 4;

/** スポット解説表示時のカメラ寄りの既定値 */
const SPOT_FOCUS = {
  range: 180,
  heading: 3.2,
  pitch: -30,
  duration: 1.4,
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
 * 中心経緯度まわりに水平円の頂点列を作る（ENU 平面上）。
 * @param {number} lon
 * @param {number} lat
 * @param {number} radiusMeters
 * @param {number} segments
 * @returns {Cesium.Cartesian3[]}
 */
function createHorizontalCirclePositions(lon, lat, radiusMeters, segments) {
  const center = Cesium.Cartesian3.fromDegrees(lon, lat);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
  const positions = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Cesium.Math.TWO_PI;
    const local = new Cesium.Cartesian3(
      Math.cos(angle) * radiusMeters,
      Math.sin(angle) * radiusMeters,
      0
    );
    positions.push(
      Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3())
    );
  }
  return positions;
}

/**
 * 浅草寺中心・半径 1 km の円の外側をクリップし、円内だけ残す。
 * @param {Cesium.Viewer} viewer
 * @param {Cesium.Cesium3DTileset} tileset
 */
function clipTilesetToSensojiCircle(viewer, tileset) {
  if (
    typeof Cesium.ClippingPolygon === "undefined" ||
    typeof Cesium.ClippingPolygonCollection === "undefined"
  ) {
    console.warn("ClippingPolygon 非対応のため、円形クリップをスキップします");
    return;
  }
  if (
    typeof Cesium.ClippingPolygonCollection.isSupported === "function" &&
    !Cesium.ClippingPolygonCollection.isSupported(viewer.scene)
  ) {
    console.warn("この WebGL コンテキストでは ClippingPolygon を使えません");
    return;
  }

  const positions = createHorizontalCirclePositions(
    BUILDING_CLIP.lon,
    BUILDING_CLIP.lat,
    BUILDING_CLIP.radiusMeters,
    BUILDING_CLIP.segments
  );

  tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({
    polygons: [new Cesium.ClippingPolygon({ positions })],
    // true = 多角形の外側をクリップ → 円内だけ残る
    inverse: true,
  });
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {string} url
 * @param {string} label
 * @returns {Promise<Cesium.Cesium3DTileset | null>}
 */
async function loadPlateauTileset(viewer, url, label) {
  try {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
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
      cacheBytes: 2 * 1024 * 1024 * 1024,
      maximumCacheOverflowBytes: 1 * 1024 * 1024 * 1024,
    });

    tileset.tileFailed.addEventListener((error) => {
      console.warn(`PLATEAU ${label} tile failed:`, error?.url || error);
    });

    applyPlateauViewLighting(tileset);
    clipTilesetToSensojiCircle(viewer, tileset);
    viewer.scene.primitives.add(tileset);
    viewer.scene.requestRender();
    return tileset;
  } catch (err) {
    console.warn(`PLATEAU ${label} の読み込みに失敗:`, err);
    return null;
  }
}

/**
 * 台東区建物・墨田区建物・橋梁を円範囲で読み込む。
 * @param {Cesium.Viewer} viewer
 * @returns {Promise<(Cesium.Cesium3DTileset | null)[]>}
 */
async function loadAsakusaBuildings(viewer) {
  boostPlateauRequestConcurrency();

  const loaded = await Promise.all([
    loadPlateauTileset(viewer, PLATEAU_TILESET_URLS.taitoBldg, "台東建物"),
    loadPlateauTileset(viewer, PLATEAU_TILESET_URLS.sumidaBldg, "墨田建物"),
    loadPlateauTileset(viewer, PLATEAU_TILESET_URLS.taitoBrid, "台東橋梁"),
  ]);

  if (!loaded.some(Boolean)) {
    throw new Error("PLATEAU tileset を1件も読み込めませんでした");
  }
  return loaded;
}

/**
 * タイトル表示中のステータス文言を更新する。
 * @param {string} message
 */
function setIntroSplashStatus(message) {
  const el = document.getElementById("introSplashStatus");
  if (el) el.textContent = message;
}

/** @type {number} */
let introSplashProgressValue = 4;

/**
 * 冒頭ローディングバーの進捗（0–100）。後退しない。
 * @param {number} percent
 */
function setIntroSplashProgress(percent) {
  const next = Math.max(
    introSplashProgressValue,
    Math.min(100, Math.round(percent))
  );
  introSplashProgressValue = next;

  const bar = document.getElementById("introSplashProgressBar");
  const track = bar?.parentElement;
  if (bar) bar.style.width = `${next}%`;
  if (track) track.setAttribute("aria-valuenow", String(next));
}

/**
 * 寄り視点で必要な建物タイルが揃うまで待つ（タイムアウト付き）。
 * スプラッシュ表示中に呼び、雷門などが欠けたまま開かないようにする。
 * @param {Cesium.Viewer} viewer
 * @param {(Cesium.Cesium3DTileset | null)[]} tilesets
 * @param {{ timeoutMs?: number, stableFrames?: number, minReady?: number }} [options]
 * @returns {Promise<() => void>} イントロ終了後に呼ぶ後始末（SSE / requestRenderMode 復帰）
 */
function waitForInitialTiles(viewer, tilesets, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45000;
  const stableFrames = options.stableFrames ?? 30;
  const minReady = options.minReady ?? 12;
  const active = (tilesets || []).filter(Boolean);
  // 寄りは雷門＝台東建物が本体。他 tileset まで待つと不要に長引く
  const primary = active[0] ?? null;

  return new Promise((resolve) => {
    const prevRequestRenderMode = viewer.scene.requestRenderMode;
    const prevSseByTileset = active.map((tileset) => ({
      tileset,
      sse: tileset.maximumScreenSpaceError,
    }));

    const restore = () => {
      for (const entry of prevSseByTileset) {
        entry.tileset.maximumScreenSpaceError = entry.sse;
      }
      viewer.scene.requestRenderMode = prevRequestRenderMode;
      viewer.scene.requestRender();
    };

    if (!primary) {
      setIntroSplashProgress(96);
      resolve(restore);
      return;
    }

    const started = performance.now();
    viewer.scene.requestRenderMode = false;
    // 寄りでは LOD を細かくして門上部が欠けた粗いタイルで開かないようにする
    for (const tileset of active) {
      tileset.maximumScreenSpaceError = INTRO_BUILDING_SSE;
    }

    let readyStreak = 0;
    let lastStatusAt = 0;
    let peakReady = 0;

    applyInitialView(viewer);
    setIntroSplashProgress(58);

    const finish = () => {
      setIntroSplashProgress(100);
      setIntroSplashStatus("地形を整えています…");
      applyInitialView(viewer);
      // 寄り表示〜引き開始までは連続描画を維持（門の精緻化を止めない）
      viewer.scene.requestRender();
      resolve(restore);
    };

    const tick = () => {
      viewer.scene.requestRender();
      const elapsed = performance.now() - started;
      const ready = primary.statistics?.numberOfTilesWithContentReady ?? 0;
      const selected = primary.statistics?.selected ?? 0;
      const hasVisibleContent = ready >= minReady && selected >= 1;
      const viewReady = primary.tilesLoaded && hasVisibleContent;

      peakReady = Math.max(peakReady, ready);
      const tileProgress =
        58 + 38 * (1 - Math.exp(-(peakReady + (viewReady ? 8 : 0)) / 14));
      setIntroSplashProgress(viewReady ? Math.max(tileProgress, 96) : tileProgress);

      if (viewReady) {
        readyStreak += 1;
      } else {
        readyStreak = 0;
      }

      if (elapsed - lastStatusAt > 400) {
        lastStatusAt = elapsed;
        setIntroSplashStatus(
          viewReady
            ? "地形を整えています…"
            : `浅草を読み込み中…（${ready}）`
        );
      }

      if (readyStreak >= stableFrames || elapsed >= timeoutMs) {
        finish();
        return;
      }
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  });
}

/**
 * 現在視点で地形・画像タイルが揃うまで待つ（ちらつき軽減）。
 * @param {Cesium.Viewer} viewer
 * @param {{ timeoutMs?: number, stableFrames?: number }} [options]
 */
function waitForGlobeTiles(viewer, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const stableFrames = options.stableFrames ?? 8;
  const started = performance.now();
  let readyStreak = 0;

  return new Promise((resolve) => {
    const tick = () => {
      applyInitialView(viewer);
      viewer.scene.requestRender();
      const loaded = viewer.scene.globe.tilesLoaded === true;
      readyStreak = loaded ? readyStreak + 1 : 0;
      if (readyStreak >= stableFrames || performance.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * イントロスプラッシュをフェードアウトしてマップ UI を出す。
 */
function revealMapFromIntro() {
  const splash = document.getElementById("introSplash");
  document.body.classList.remove("is-intro");
  if (!splash) return;

  splash.classList.add("is-leaving");
  splash.setAttribute("aria-hidden", "true");
  const done = () => {
    splash.classList.add("is-gone");
    splash.removeEventListener("transitionend", done);
  };
  splash.addEventListener("transitionend", done);
  // transitionend 欠落時のフォールバック
  setTimeout(done, 1000);
}

const statusEl = document.getElementById("status");
const leftPanel = document.getElementById("leftPanel");
const pinSearch = document.getElementById("pinSearch");
const searchCount = document.getElementById("searchCount");
const filterPanel = document.getElementById("filterPanel");
const filterToggle = document.getElementById("filterToggle");
const categoryFilters = document.getElementById("categoryFilters");
const filterClear = document.getElementById("filterClear");
const infoBackdrop = document.getElementById("infoBackdrop");
const infoPanel = document.getElementById("infoPanel");
const infoFooterClose = document.getElementById("infoFooterClose");
const infoTitle = document.getElementById("infoTitle");
const infoYears = document.getElementById("infoYears");
const infoFactName = document.getElementById("infoFactName");
const infoFactCategory = document.getElementById("infoFactCategory");
const infoFactRole = document.getElementById("infoFactRole");
const infoFactYears = document.getElementById("infoFactYears");
const infoVisualCategories = document.getElementById("infoVisualCategories");
const infoVisualEmpty = document.getElementById("infoVisualEmpty");
const infoDescription = document.getElementById("infoDescription");
const infoNote = document.getElementById("infoNote");
const infoSources = document.getElementById("infoSources");
const infoImage = document.getElementById("infoImage");
const infoImageButton = document.getElementById("infoImageButton");
const infoModelViewer = document.getElementById("infoModelViewer");
const infoGallery = document.getElementById("infoGallery");
const infoGalleryPrev = document.getElementById("infoGalleryPrev");
const infoGalleryNext = document.getElementById("infoGalleryNext");
const infoGalleryCounter = document.getElementById("infoGalleryCounter");
const infoPhotoListToggle = document.getElementById("infoPhotoListToggle");
const infoPhotoMetaToggle = document.getElementById("infoPhotoMetaToggle");
const infoPhotoMetaOverlay = document.getElementById("infoPhotoMetaOverlay");
const infoPhotoList = document.getElementById("infoPhotoList");
const photoThumbLightbox = document.getElementById("photoThumbLightbox");
const photoThumbClose = document.getElementById("photoThumbClose");
const photoThumbSubtitle = document.getElementById("photoThumbSubtitle");
const photoLightbox = document.getElementById("photoLightbox");
const lightboxClose = document.getElementById("lightboxClose");
const lightboxImage = document.getElementById("lightboxImage");
const lightboxImageViewport = document.getElementById("lightboxImageViewport");
const lightboxPrev = document.getElementById("lightboxPrev");
const lightboxNext = document.getElementById("lightboxNext");
const lightboxPhotoListToggle = document.getElementById("lightboxPhotoListToggle");
const lightboxPhotoMetaToggle = document.getElementById("lightboxPhotoMetaToggle");
const lightboxPhotoMetaOverlay = document.getElementById("lightboxPhotoMetaOverlay");

/** @type {Map<string, object>} */
const spotById = new Map();

/** @type {Cesium.Viewer | null} */
let mapViewer = null;

/**
 * 解説を開く直前のカメラ。閉じたらここに戻す。
 * @type {{ destination: Cesium.Cartesian3, orientation: { heading: number, pitch: number, roll: number } } | null}
 */
let savedCameraView = null;

/**
 * 解説パネルのギャラリー項目（モデル優先、続けて写真）。
 * @type {Array<{ type: "model", uri: string } | { type: "photo", url: string, [key: string]: any }>}
 */
let galleryItems = [];
/** 写真のみ（ライトボックス／一覧用）。galleryItems の photo と同一参照 */
let galleryImages = [];
let galleryIndex = 0;
let lightboxIndex = 0;
let photoListOpen = false;
let photoMetaOverlayOpen = false;

const LIGHTBOX_ZOOM_MIN = 1;
const LIGHTBOX_ZOOM_MAX = 6;
let lightboxZoom = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;
let lightboxDragging = false;
/** @type {{ x: number, y: number, panX: number, panY: number } | null} */
let lightboxDragOrigin = null;

/** @type {object | null} */
let activeSpot = null;

/** @type {(() => void) | null} */
let refreshDevPanel = null;

/** カメラ飛行中の古い表示予約を無効化するためのトークン */
let infoRevealToken = 0;

function isInfoOpen() {
  return Boolean(
    infoPanel &&
      (!infoPanel.classList.contains("hidden") ||
        infoPanel.classList.contains("is-visible"))
  );
}

function isInfoSessionActive() {
  return Boolean(savedCameraView || activeSpot || isInfoOpen());
}

function concealInfoPanel() {
  if (infoPanel) {
    infoPanel.classList.remove("is-visible");
    infoPanel.classList.add("hidden");
  }
  if (infoBackdrop) {
    infoBackdrop.classList.remove("is-visible");
    infoBackdrop.classList.add("hidden");
    infoBackdrop.hidden = true;
  }
}

function revealInfoPanel() {
  if (!infoPanel) return;

  if (infoBackdrop) {
    infoBackdrop.hidden = false;
    infoBackdrop.classList.remove("hidden");
    void infoBackdrop.offsetWidth;
    infoBackdrop.classList.add("is-visible");
  }

  infoPanel.classList.remove("hidden");
  infoPanel.classList.remove("is-visible");
  void infoPanel.offsetWidth;
  requestAnimationFrame(() => {
    infoPanel.classList.add("is-visible");
  });
}

function isDevMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("dev") === "1") return true;
    return window.localStorage.getItem("asakusa-dev") === "1";
  } catch {
    return false;
  }
}

/**
 * flyToSpot と同じ注視点（モデル位置のやや上空）。
 * @param {object} spot
 */
function getSpotFocusTarget(spot) {
  const lon = Number.isFinite(spot.modelLon) ? spot.modelLon : spot.lon;
  const lat = Number.isFinite(spot.modelLat) ? spot.modelLat : spot.lat;
  const baseHeight = Number.isFinite(spot.height) ? spot.height : 40;
  // height はモデル接地の楕円体高。建物中腹付近を見る
  const focusHeight = Number.isFinite(spot.viewFocusHeight)
    ? spot.viewFocusHeight
    : baseHeight + 25;
  return Cesium.Cartesian3.fromDegrees(lon, lat, focusHeight);
}

/** 初期視点の注視点（雷門）。DEV の初期基準コピーもここを使う。 */
function getInitialFocusTarget() {
  return Cesium.Cartesian3.fromDegrees(
    INITIAL_VIEW.focusLon,
    INITIAL_VIEW.focusLat,
    INITIAL_VIEW.focusHeight
  );
}

/**
 * flyToSpot / 初期視点と同じく BoundingSphere + HPR でカメラを置く。
 * @param {Cesium.Viewer} viewer
 * @param {Cesium.Cartesian3} target
 * @param {number} headingDeg
 * @param {number} pitchDeg
 * @param {number} range
 * @param {number} [duration]
 * @returns {Promise<boolean>}
 */
function flyToHeadingPitchRange(
  viewer,
  target,
  headingDeg,
  pitchDeg,
  range,
  duration = 0
) {
  return new Promise((resolve) => {
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 1), {
      duration,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(headingDeg),
        Cesium.Math.toRadians(pitchDeg),
        range
      ),
      complete: () => resolve(true),
      cancel: () => resolve(false),
    });
  });
}

function applyInitialView(viewer) {
  // 絶対姿勢を雷門注視＋方位固定のパスに合わせて調整（引き開始と一致させカクつき防止）
  const hpr = getIntroHprFromAbsolutePose(INITIAL_VIEW);
  if (!hpr) {
    viewer.camera.setView(absolutePoseToCameraView(INITIAL_VIEW));
    viewer.scene.requestRender();
    return;
  }
  applyIntroGateView(viewer, hpr, { unlock: true });
}

/**
 * 絶対姿勢をカメラ setView 用の引数にする。
 * @param {{ lon: number, lat: number, height: number, heading: number, pitch: number }} pose
 */
function absolutePoseToCameraView(pose) {
  return {
    destination: Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.height),
    orientation: {
      heading: Cesium.Math.toRadians(pose.heading),
      pitch: Cesium.Math.toRadians(pose.pitch),
      roll: 0,
    },
  };
}

/** イントロ引きで使う固定方位（横ブレ防止） */
function getIntroLockedHeading() {
  return Cesium.Math.toRadians(INITIAL_VIEW.heading);
}

/**
 * 指定絶対位置を、雷門注視点＋固定方位の HPR に調整する。
 * @param {{ lon: number, lat: number, height: number }} pose
 * @returns {Cesium.HeadingPitchRange | null}
 */
function getIntroHprFromAbsolutePose(pose) {
  const gate = getInitialFocusTarget();
  const position = Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.height);
  const hpr = headingPitchRangeFromPositions(position, gate);
  if (!hpr) return null;
  return new Cesium.HeadingPitchRange(
    getIntroLockedHeading(),
    hpr.pitch,
    hpr.range
  );
}

/**
 * 雷門注視のイントロ用カメラを適用する。
 * @param {Cesium.Viewer} viewer
 * @param {Cesium.HeadingPitchRange} hpr
 * @param {{ unlock?: boolean }} [options]
 */
function applyIntroGateView(viewer, hpr, options = {}) {
  const unlock = options.unlock !== false;
  viewer.camera.lookAt(getInitialFocusTarget(), hpr);
  if (unlock) {
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
  viewer.scene.requestRender();
}

/**
 * 寄り視点から全体へゆっくり引くイントロ・ムービー。
 * 始点・終点とも雷門注視パス上に調整し、絶対姿勢への無理な合わせ込みをしない。
 * @param {Cesium.Viewer} viewer
 * @returns {Promise<boolean>}
 */
async function playIntroPullback(viewer) {
  viewer.scene.requestRenderMode = false;

  const startHpr = getIntroHprFromAbsolutePose(INITIAL_VIEW);
  const endHpr = getIntroHprFromAbsolutePose(OVERVIEW_VIEW);
  if (!startHpr || !endHpr) {
    applyInitialView(viewer);
    return false;
  }

  // 寄りは引きパス上の始点で見せる（絶対姿勢→lookAt の切替をしない）
  applyIntroGateView(viewer, startHpr, { unlock: false });

  if (OVERVIEW_VIEW.holdMs > 0) {
    const holdUntil = performance.now() + OVERVIEW_VIEW.holdMs;
    await new Promise((resolve) => {
      const tick = () => {
        applyIntroGateView(viewer, startHpr, { unlock: false });
        if (performance.now() >= holdUntil) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // 寄り〜引き序盤は深度テストOFFのまま（近景で門が地形に一瞬埋まるのを防ぐ）
  // 十分引いてからONにする
  let depthTestEnabled = false;

  const startPitch = startHpr.pitch;
  const endPitch = endHpr.pitch;
  const logStartRange = Math.log(Math.max(startHpr.range, 1));
  const logEndRange = Math.log(Math.max(endHpr.range, 1));
  const lockedHeading = getIntroLockedHeading();
  const gateFocus = getInitialFocusTarget();
  const depthTestRange = Math.max(startHpr.range * 4, 280);

  const durationMs = Math.max(0.1, OVERVIEW_VIEW.duration) * 1000;
  const startedAt = performance.now();

  try {
    return await new Promise((resolve) => {
      const tick = () => {
        const rawT = Math.min(1, (performance.now() - startedAt) / durationMs);
        const t = Cesium.EasingFunction.SINUSOIDAL_IN_OUT(rawT);

        const pitch = startPitch + (endPitch - startPitch) * t;
        const range = Math.exp(logStartRange + (logEndRange - logStartRange) * t);

        if (!depthTestEnabled && range >= depthTestRange) {
          viewer.scene.globe.depthTestAgainstTerrain = true;
          depthTestEnabled = true;
        }

        viewer.camera.lookAt(
          gateFocus,
          new Cesium.HeadingPitchRange(lockedHeading, pitch, range)
        );
        viewer.scene.requestRender();

        if (rawT < 1) {
          requestAnimationFrame(tick);
          return;
        }

        viewer.scene.globe.depthTestAgainstTerrain = true;
        // 終点も同じパス上。絶対姿勢へ戻してカクつかせない
        applyIntroGateView(viewer, endHpr, { unlock: true });
        resolve(true);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.requestRender();
  }
}

/**
 * 現在カメラの絶対姿勢を INITIAL_VIEW 用 TSV にする。
 * lon lat height heading pitch
 * @param {Cesium.Viewer} viewer
 */
function sampleAbsoluteCameraPose(viewer) {
  const c = viewer.camera.positionCartographic;
  return {
    lon: Math.round(Cesium.Math.toDegrees(c.longitude) * 1e6) / 1e6,
    lat: Math.round(Cesium.Math.toDegrees(c.latitude) * 1e6) / 1e6,
    height: Math.round(c.height * 100) / 100,
    heading: Math.round(Cesium.Math.toDegrees(viewer.camera.heading) * 10) / 10,
    pitch: Math.round(Cesium.Math.toDegrees(viewer.camera.pitch) * 10) / 10,
  };
}

/**
 * カメラ位置から HeadingPitchRange を逆算する（flyToBoundingSphere と一致）。
 * @param {Cesium.Cartesian3} cameraPosition
 * @param {Cesium.Cartesian3} target
 */
function headingPitchRangeFromPositions(cameraPosition, target) {
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(target);
  const inverse = Cesium.Matrix4.inverseTransformation(
    transform,
    new Cesium.Matrix4()
  );
  const local = Cesium.Matrix4.multiplyByPoint(
    inverse,
    cameraPosition,
    new Cesium.Cartesian3()
  );
  const range = Cesium.Cartesian3.magnitude(local);
  if (!(range > 1e-3)) return null;

  // Cesium Camera.offsetFromHeadingPitchRange の逆変換
  const pitch = -Math.asin(Cesium.Math.clamp(local.z / range, -1, 1));
  const beta = Math.atan2(-local.y, -local.x);
  const heading = Cesium.Math.zeroToTwoPi(Cesium.Math.PI_OVER_TWO - beta);

  return { heading, pitch, range };
}

/**
 * 現在カメラからシート用アングルを取得する。
 * @param {Cesium.Viewer} viewer
 * @param {object | null} [spot]
 * @param {{ useInitialFocus?: boolean }} [options]
 */
function sampleCameraAngle(viewer, spot, options = {}) {
  let target = null;
  if (options.useInitialFocus) {
    target = getInitialFocusTarget();
  } else if (spot && Number.isFinite(spot.lon) && Number.isFinite(spot.lat)) {
    target = getSpotFocusTarget(spot);
  } else {
    // スポット未選択時は初期視点と同じ注視点基準（ズレ防止）
    target = getInitialFocusTarget();
  }

  if (!target) {
    return {
      viewHeading: Math.round(Cesium.Math.toDegrees(viewer.camera.heading) * 10) / 10,
      viewPitch: Math.round(Cesium.Math.toDegrees(viewer.camera.pitch) * 10) / 10,
      viewRange: null,
    };
  }

  const hpr = headingPitchRangeFromPositions(viewer.camera.positionWC, target);
  if (!hpr) {
    return { viewHeading: 0, viewPitch: 0, viewRange: null };
  }

  return {
    viewHeading: Math.round(Cesium.Math.toDegrees(hpr.heading) * 10) / 10,
    viewPitch: Math.round(Cesium.Math.toDegrees(hpr.pitch) * 10) / 10,
    viewRange: Math.round(hpr.range),
  };
}

function setupDevPanel(viewer) {
  const panel = document.getElementById("devPanel");
  if (!panel || !isDevMode()) return;

  const headingEl = document.getElementById("devHeading");
  const pitchEl = document.getElementById("devPitch");
  const rangeEl = document.getElementById("devRange");
  const spotEl = document.getElementById("devSpotName");
  const copyBtn = document.getElementById("devCopyAngle");
  const copyInitialBtn = document.getElementById("devCopyInitialAngle");
  const previewBtn = document.getElementById("devPreviewAngle");
  const statusEl = document.getElementById("devCopyStatus");

  panel.hidden = false;
  panel.classList.remove("hidden");

  const refresh = () => {
    // 表示値は常に「初期注視点基準」も分かるよう、選択スポットがあればスポット基準
    const angle = sampleCameraAngle(viewer, activeSpot);
    if (headingEl) headingEl.textContent = String(angle.viewHeading);
    if (pitchEl) pitchEl.textContent = String(angle.viewPitch);
    if (rangeEl) {
      rangeEl.textContent =
        angle.viewRange != null ? String(angle.viewRange) : "—";
    }
    if (spotEl) {
      spotEl.textContent = activeSpot?.name
        ? `${activeSpot.name} 基準（シート用）`
        : "初期視点＝雷門 基準";
    }
  };

  viewer.camera.percentageChanged = 0.005;
  viewer.camera.changed.addEventListener(refresh);
  viewer.camera.moveEnd.addEventListener(refresh);
  refreshDevPanel = refresh;
  refresh();

  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      if (!activeSpot) {
        if (statusEl) {
          statusEl.textContent =
            "シート用はスポット選択中にコピーしてください（初期視点用ボタンを使うか）";
        }
        return;
      }
      const angle = sampleCameraAngle(viewer, activeSpot);
      if (angle.viewRange == null) {
        if (statusEl) statusEl.textContent = "距離を取得できませんでした";
        return;
      }
      const tsv = `${angle.viewHeading}\t${angle.viewPitch}\t${angle.viewRange}`;
      try {
        await navigator.clipboard.writeText(tsv);
        if (statusEl) {
          statusEl.textContent = `コピー（${activeSpot.name} 基準）`;
        }
      } catch {
        if (statusEl) statusEl.textContent = `手動コピー: ${tsv}`;
      }
      refresh();
    });
  }

  if (copyInitialBtn) {
    copyInitialBtn.addEventListener("click", async () => {
      const pose = sampleAbsoluteCameraPose(viewer);
      const hpr = sampleCameraAngle(viewer, null, { useInitialFocus: true });
      const tsv = `${pose.lon}\t${pose.lat}\t${pose.height}\t${pose.heading}\t${pose.pitch}`;
      const hprTsv =
        hpr.viewRange != null
          ? `${hpr.viewHeading}\t${hpr.viewPitch}\t${hpr.viewRange}`
          : "";
      try {
        await navigator.clipboard.writeText(tsv);
        if (statusEl) {
          statusEl.textContent = hprTsv
            ? `絶対姿勢をコピー: ${tsv}（参考 HPR ${hprTsv}）`
            : `絶対姿勢をコピー: ${tsv}`;
        }
      } catch {
        if (statusEl) statusEl.textContent = `手動コピー: ${tsv}`;
      }
      refresh();
    });
  }

  if (previewBtn) {
    previewBtn.addEventListener("click", async () => {
      if (activeSpot) {
        const angle = sampleCameraAngle(viewer, activeSpot);
        if (angle.viewRange == null) {
          if (statusEl) statusEl.textContent = "距離を取得できませんでした";
          return;
        }
        activeSpot.viewHeading = angle.viewHeading;
        activeSpot.viewPitch = angle.viewPitch;
        activeSpot.viewRange = angle.viewRange;
        await flyToSpot(viewer, activeSpot);
        if (statusEl) {
          statusEl.textContent =
            "寄り直し完了。見た目がほぼ同じならコピー値は正しいです";
        }
        return;
      }

      applyInitialView(viewer);
      if (statusEl) {
        statusEl.textContent = "INITIAL_VIEW の絶対姿勢へ復帰しました";
      }
      refresh();
    });
  }

  window.__asakusaSampleAngle = () =>
    sampleCameraAngle(viewer, activeSpot, { useInitialFocus: !activeSpot });
}

/**
 * @param {Cesium.Viewer} viewer
 */
function captureCameraView(viewer) {
  return {
    destination: Cesium.Cartesian3.clone(viewer.camera.positionWC),
    orientation: {
      heading: viewer.camera.heading,
      pitch: viewer.camera.pitch,
      roll: viewer.camera.roll,
    },
  };
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {object} spot
 * @returns {Promise<boolean>} 完了なら true、キャンセルなら false
 */
function flyToSpot(viewer, spot) {
  const target = getSpotFocusTarget(spot);
  const heading = Number.isFinite(spot.viewHeading)
    ? spot.viewHeading
    : SPOT_FOCUS.heading;
  const pitch = Number.isFinite(spot.viewPitch)
    ? spot.viewPitch
    : SPOT_FOCUS.pitch;
  const range = Number.isFinite(spot.viewRange)
    ? spot.viewRange
    : SPOT_FOCUS.range;

  return flyToHeadingPitchRange(
    viewer,
    target,
    heading,
    pitch,
    range,
    SPOT_FOCUS.duration
  ).then((ok) => {
    if (ok && refreshDevPanel) refreshDevPanel();
    return ok;
  });
}

/**
 * @param {Cesium.Viewer} viewer
 */
function restoreCameraView(viewer) {
  if (!savedCameraView) return;
  const view = savedCameraView;
  savedCameraView = null;
  viewer.camera.flyTo({
    destination: view.destination,
    orientation: view.orientation,
    duration: SPOT_FOCUS.duration,
  });
}

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

function fillPhotoMetaOverlay(overlay, photo) {
  if (!overlay) return;
  const titleEl = overlay.querySelector(".photo-meta-overlay-title");
  const dateEl = overlay.querySelector(".photo-meta-overlay-date");
  const descEl = overlay.querySelector(".photo-meta-overlay-description");
  if (titleEl) titleEl.textContent = photo?.title || "";
  if (dateEl) dateEl.textContent = photo?.date || "";
  if (descEl) descEl.textContent = photo?.description || "";
}

function syncPhotoMetaToggleState() {
  const toggles = [infoPhotoMetaToggle, lightboxPhotoMetaToggle].filter(Boolean);
  const label = "画像の情報を表示します";
  for (const toggle of toggles) {
    toggle.setAttribute("aria-expanded", photoMetaOverlayOpen ? "true" : "false");
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }
}

function setPhotoMetaOverlayOpen(open) {
  photoMetaOverlayOpen = Boolean(open) && galleryImages.length > 0;

  const overlays = [infoPhotoMetaOverlay, lightboxPhotoMetaOverlay].filter(Boolean);
  for (const overlay of overlays) {
    overlay.hidden = !photoMetaOverlayOpen;
    overlay.classList.toggle("hidden", !photoMetaOverlayOpen);
  }

  syncPhotoMetaToggleState();
  refreshPhotoMetaOverlayContent();
}

function getGalleryItem(index = galleryIndex) {
  return galleryItems[index] || null;
}

function isGalleryModelItem(item) {
  return Boolean(item && item.type === "model" && item.uri);
}

function isShowingModel() {
  return isGalleryModelItem(getGalleryItem());
}

function currentGalleryPhoto() {
  const item = getGalleryItem();
  return item?.type === "photo" ? item : null;
}

/** galleryItems 上の写真インデックス → galleryImages 上のインデックス */
function photoIndexForGalleryIndex(gIndex) {
  const item = galleryItems[gIndex];
  if (!item || item.type !== "photo") return -1;
  return galleryImages.findIndex(
    (photo) => photo === item || photo.url === item.url
  );
}

/** galleryImages 上のインデックス → galleryItems 上のインデックス */
function galleryIndexForPhotoIndex(photoIndex) {
  let count = 0;
  for (let i = 0; i < galleryItems.length; i++) {
    if (galleryItems[i]?.type !== "photo") continue;
    if (count === photoIndex) return i;
    count += 1;
  }
  return -1;
}

function clearInfoModelViewer() {
  if (!infoModelViewer) return;
  infoModelViewer.removeAttribute("src");
  infoModelViewer.classList.add("hidden");
  infoModelViewer.alt = "";
}

function refreshPhotoMetaOverlayContent() {
  if (!galleryImages.length) return;
  const galleryPhoto = currentGalleryPhoto() || galleryImages[0];
  const lightboxPhoto = galleryImages[lightboxIndex] || galleryImages[0];
  fillPhotoMetaOverlay(infoPhotoMetaOverlay, galleryPhoto);
  fillPhotoMetaOverlay(lightboxPhotoMetaOverlay, lightboxPhoto);
}

function syncPhotoListToggleState() {
  const toggles = [infoPhotoListToggle, lightboxPhotoListToggle].filter(Boolean);
  const label = "画像の一覧を表示します";
  for (const toggle of toggles) {
    toggle.setAttribute("aria-expanded", photoListOpen ? "true" : "false");
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
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
  const activePhotoIndex = isPhotoLightboxOpen()
    ? lightboxIndex
    : photoIndexForGalleryIndex(galleryIndex);

  galleryImages.forEach((photo, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "info-photo-list-item" +
      (index === activePhotoIndex ? " is-active" : "");
    button.setAttribute("role", "option");
    button.setAttribute(
      "aria-selected",
      index === activePhotoIndex ? "true" : "false"
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
        const itemIndex = galleryIndexForPhotoIndex(index);
        if (itemIndex >= 0) selectGalleryPhoto(itemIndex);
        openPhotoLightbox(galleryImages[index]);
      }
    });
    infoPhotoList.append(button);
  });
}

function applyLightboxZoom() {
  if (!lightboxImage) return;
  lightboxImage.style.transform =
    `translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`;
  if (lightboxImageViewport) {
    lightboxImageViewport.classList.toggle("is-zoomed", lightboxZoom > 1.01);
    lightboxImageViewport.classList.toggle("is-dragging", lightboxDragging);
  }
}

function resetLightboxZoom() {
  lightboxZoom = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;
  lightboxDragging = false;
  lightboxDragOrigin = null;
  applyLightboxZoom();
}

function updateLightboxView() {
  if (!isPhotoLightboxOpen()) return;
  const photo = galleryImages[lightboxIndex] || galleryImages[0];
  if (!photo) {
    closePhotoLightbox();
    return;
  }

  resetLightboxZoom();

  if (lightboxImage) {
    lightboxImage.src = photo.url;
    lightboxImage.alt = photo.title || "";
  }

  const hasMultiple = galleryImages.length > 1;
  if (lightboxPrev) {
    lightboxPrev.classList.toggle("hidden", !hasMultiple);
    lightboxPrev.disabled = !hasMultiple;
  }
  if (lightboxNext) {
    lightboxNext.classList.toggle("hidden", !hasMultiple);
    lightboxNext.disabled = !hasMultiple;
  }
  refreshPhotoMetaOverlayContent();
}

function closePhotoLightbox() {
  if (!photoLightbox) return;
  photoLightbox.classList.add("hidden");
  photoLightbox.hidden = true;
  resetLightboxZoom();
  if (lightboxImage) lightboxImage.removeAttribute("src");
}

function openPhotoLightbox(photo) {
  if (!photoLightbox || !photo?.url) return;

  const index = galleryImages.findIndex(
    (item) => item === photo || item.url === photo.url
  );
  const fallback = Math.max(0, photoIndexForGalleryIndex(galleryIndex));
  lightboxIndex = index >= 0 ? index : fallback;

  photoLightbox.hidden = false;
  photoLightbox.classList.remove("hidden");
  updateLightboxView();
}

function setupLightboxZoomInteractions() {
  if (!lightboxImageViewport) return;

  lightboxImageViewport.addEventListener(
    "wheel",
    (event) => {
      if (!isPhotoLightboxOpen()) return;
      event.preventDefault();
      event.stopPropagation();

      const rect = lightboxImageViewport.getBoundingClientRect();
      const cursorX = event.clientX - rect.left - rect.width / 2;
      const cursorY = event.clientY - rect.top - rect.height / 2;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextZoom = Math.min(
        LIGHTBOX_ZOOM_MAX,
        Math.max(LIGHTBOX_ZOOM_MIN, lightboxZoom * factor)
      );

      if (Math.abs(nextZoom - lightboxZoom) < 0.001) return;

      const ratio = nextZoom / lightboxZoom;
      lightboxPanX = cursorX - (cursorX - lightboxPanX) * ratio;
      lightboxPanY = cursorY - (cursorY - lightboxPanY) * ratio;
      lightboxZoom = nextZoom;

      if (lightboxZoom <= 1.01) {
        lightboxZoom = 1;
        lightboxPanX = 0;
        lightboxPanY = 0;
      }
      applyLightboxZoom();
    },
    { passive: false }
  );

  lightboxImageViewport.addEventListener("pointerdown", (event) => {
    if (!isPhotoLightboxOpen() || lightboxZoom <= 1.01) return;
    if (event.button !== 0) return;
    lightboxDragging = true;
    lightboxDragOrigin = {
      x: event.clientX,
      y: event.clientY,
      panX: lightboxPanX,
      panY: lightboxPanY,
    };
    lightboxImageViewport.setPointerCapture(event.pointerId);
    applyLightboxZoom();
  });

  lightboxImageViewport.addEventListener("pointermove", (event) => {
    if (!lightboxDragging || !lightboxDragOrigin) return;
    lightboxPanX =
      lightboxDragOrigin.panX + (event.clientX - lightboxDragOrigin.x);
    lightboxPanY =
      lightboxDragOrigin.panY + (event.clientY - lightboxDragOrigin.y);
    applyLightboxZoom();
  });

  const endDrag = (event) => {
    if (!lightboxDragging) return;
    lightboxDragging = false;
    lightboxDragOrigin = null;
    try {
      lightboxImageViewport.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    applyLightboxZoom();
  };

  lightboxImageViewport.addEventListener("pointerup", endDrag);
  lightboxImageViewport.addEventListener("pointercancel", endDrag);

  lightboxImageViewport.addEventListener("dblclick", (event) => {
    if (!isPhotoLightboxOpen()) return;
    event.preventDefault();
    if (lightboxZoom > 1.01) {
      resetLightboxZoom();
      return;
    }
    const rect = lightboxImageViewport.getBoundingClientRect();
    const cursorX = event.clientX - rect.left - rect.width / 2;
    const cursorY = event.clientY - rect.top - rect.height / 2;
    lightboxZoom = 2.5;
    lightboxPanX = cursorX * (1 - lightboxZoom);
    lightboxPanY = cursorY * (1 - lightboxZoom);
    applyLightboxZoom();
  });
}

function hideInfo() {
  infoRevealToken += 1;
  closePhotoLightbox();
  setPhotoListOpen(false);
  setPhotoMetaOverlayOpen(false);
  concealInfoPanel();
  clearInfoModelViewer();
  galleryItems = [];
  galleryImages = [];
  galleryIndex = 0;
  lightboxIndex = 0;
  activeSpot = null;
  if (refreshDevPanel) refreshDevPanel();
  if (mapViewer) restoreCameraView(mapViewer);
}

function formatSpotYears(spot) {
  if (spot?.yearFrom && spot?.yearTo) return `${spot.yearFrom}–${spot.yearTo}`;
  if (spot?.yearFrom) return `${spot.yearFrom}-`;
  if (spot?.yearTo) return `–${spot.yearTo}`;
  return "";
}

function setFactVisibility(factKey, visible) {
  const row = infoPanel?.querySelector(`[data-fact="${factKey}"]`);
  if (row) row.classList.toggle("hidden", !visible);
}

function renderCategoryBadges(container, spot) {
  if (!container) return [];
  container.replaceChildren();
  const categories = parseCategoryList(spot?.category);
  for (const category of categories) {
    const badge = document.createElement("span");
    badge.className = "info-category-badge";
    const color = categoryColorByName.get(category) || spot?.color || "";
    if (color) badge.style.setProperty("--badge-color", color);

    const icon = document.createElement("img");
    icon.className = "info-category-badge-icon";
    icon.src = ASSETS_CATEGORY_BASE + encodeURIComponent(category) + ".png";
    icon.alt = "";
    icon.loading = "lazy";
    icon.addEventListener("error", () => {
      icon.remove();
    });
    badge.append(icon);

    const label = document.createElement("span");
    label.textContent = category;
    badge.append(label);
    container.append(badge);
  }
  return categories;
}

function populateSpotInfo(spot) {
  const name = spot.name ?? "";
  const years = formatSpotYears(spot);
  const role = String(spot.role || "").trim();
  const description = spot.description ?? "";
  const note = spot.note ?? "";

  infoTitle.textContent = name;
  infoYears.textContent = years;
  if (infoFactName) infoFactName.textContent = name;
  if (infoFactRole) infoFactRole.textContent = role;
  if (infoFactYears) infoFactYears.textContent = years;
  infoDescription.textContent = description;
  infoNote.textContent = note;

  const categories = renderCategoryBadges(infoVisualCategories, spot);
  if (infoFactCategory) {
    renderCategoryBadges(infoFactCategory, spot);
  }

  setFactVisibility("name", Boolean(name));
  setFactVisibility("category", categories.length > 0);
  setFactVisibility("role", Boolean(role));
  setFactVisibility("years", Boolean(years));
  setFactVisibility("description", Boolean(description));
  setFactVisibility("note", Boolean(note));

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
  setFactVisibility("sources", (spot.sources ?? []).length > 0);

  galleryImages = (
    Array.isArray(spot.images)
      ? spot.images.filter((p) => p && p.url)
      : spot.image
        ? [{ url: spot.image, title: "" }]
        : []
  ).map((photo) => ({ type: "photo", ...photo }));
  galleryItems = [];
  if (spot.model) {
    galleryItems.push({ type: "model", uri: spot.model });
  }
  galleryItems.push(...galleryImages);
  galleryIndex = 0;
  lightboxIndex = 0;
  setPhotoListOpen(false);
  setPhotoMetaOverlayOpen(false);
  updateGalleryView();
}

async function showSpotInfo(spot) {
  const token = ++infoRevealToken;
  activeSpot = spot;
  if (refreshDevPanel) refreshDevPanel();

  populateSpotInfo(spot);
  concealInfoPanel();

  if (mapViewer) {
    if (!savedCameraView) {
      savedCameraView = captureCameraView(mapViewer);
    }
    const finished = await flyToSpot(mapViewer, spot);
    if (!finished || token !== infoRevealToken) return;
  } else if (token !== infoRevealToken) {
    return;
  }

  revealInfoPanel();
}

function updateGalleryView() {
  const hasItems = galleryItems.length > 0;
  const hasMultiple = galleryItems.length > 1;
  const showingModel = isShowingModel();
  const photo = currentGalleryPhoto();
  const hasPhotos = galleryImages.length > 0;
  const hasMultiplePhotos = galleryImages.length > 1;

  if (infoGallery) {
    infoGallery.classList.toggle("hidden", !hasItems);
  }
  if (infoVisualEmpty) {
    infoVisualEmpty.classList.toggle("hidden", hasItems);
  }

  if (!hasItems) {
    clearInfoModelViewer();
    if (infoImage) {
      infoImage.removeAttribute("src");
      infoImage.classList.add("hidden");
    }
    if (infoImageButton) infoImageButton.classList.add("hidden");
    if (infoPhotoListToggle) infoPhotoListToggle.classList.add("hidden");
    if (lightboxPhotoListToggle) lightboxPhotoListToggle.classList.add("hidden");
    if (infoPhotoMetaToggle) infoPhotoMetaToggle.classList.add("hidden");
    if (lightboxPhotoMetaToggle) lightboxPhotoMetaToggle.classList.add("hidden");
    setPhotoListOpen(false);
    setPhotoMetaOverlayOpen(false);
    if (infoPhotoList) infoPhotoList.replaceChildren();
    if (infoGalleryPrev) infoGalleryPrev.classList.add("hidden");
    if (infoGalleryNext) infoGalleryNext.classList.add("hidden");
    if (infoGalleryCounter) {
      infoGalleryCounter.textContent = "";
      infoGalleryCounter.classList.add("hidden");
    }
    return;
  }

  if (showingModel) {
    const modelItem = getGalleryItem();
    setPhotoMetaOverlayOpen(false);
    if (infoImageButton) infoImageButton.classList.add("hidden");
    if (infoImage) {
      infoImage.removeAttribute("src");
      infoImage.classList.add("hidden");
    }
    if (infoModelViewer && modelItem?.uri) {
      const spotName = infoTitle?.textContent || "";
      infoModelViewer.alt = spotName ? `${spotName}の3Dモデル` : "3Dモデル";
      if (infoModelViewer.getAttribute("src") !== modelItem.uri) {
        infoModelViewer.setAttribute("src", modelItem.uri);
      }
      infoModelViewer.classList.remove("hidden");
    }
    if (infoPhotoMetaToggle) infoPhotoMetaToggle.classList.add("hidden");
    if (infoPhotoListToggle) infoPhotoListToggle.classList.add("hidden");
  } else {
    clearInfoModelViewer();
    if (infoImageButton) infoImageButton.classList.remove("hidden");
    if (infoImage && photo) {
      infoImage.src = photo.url;
      infoImage.alt = photo.title || infoTitle?.textContent || "";
      infoImage.classList.remove("hidden");
    }
    if (infoPhotoMetaToggle) {
      infoPhotoMetaToggle.classList.toggle("hidden", !hasPhotos);
    }
    if (infoPhotoListToggle) {
      infoPhotoListToggle.classList.toggle("hidden", !hasMultiplePhotos);
    }
  }

  if (lightboxPhotoMetaToggle) {
    lightboxPhotoMetaToggle.classList.toggle("hidden", !hasPhotos);
  }
  if (lightboxPhotoListToggle) {
    lightboxPhotoListToggle.classList.toggle("hidden", !hasMultiplePhotos);
  }
  if (photoListOpen) {
    renderPhotoList();
  }
  if (!hasMultiplePhotos) setPhotoListOpen(false);
  if (!showingModel) refreshPhotoMetaOverlayContent();

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
        galleryIndex + 1 + " / " + galleryItems.length;
      infoGalleryCounter.classList.remove("hidden");
    } else {
      infoGalleryCounter.textContent = "";
      infoGalleryCounter.classList.add("hidden");
    }
  }
}

function selectGalleryPhoto(index) {
  if (!galleryItems.length) return;
  galleryIndex =
    ((index % galleryItems.length) + galleryItems.length) % galleryItems.length;
  updateGalleryView();
}

function selectLightboxPhoto(index) {
  if (!galleryImages.length) return;
  lightboxIndex =
    ((index % galleryImages.length) + galleryImages.length) %
    galleryImages.length;
  updateLightboxView();
  if (photoListOpen) renderPhotoList();
}

function shiftGallery(delta) {
  if (galleryItems.length <= 1) return;
  selectGalleryPhoto(galleryIndex + delta);
}

function shiftLightbox(delta) {
  if (galleryImages.length <= 1) return;
  selectLightboxPhoto(lightboxIndex + delta);
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
    viewHeading: Number.isFinite(content.viewHeading)
      ? content.viewHeading
      : undefined,
    viewPitch: Number.isFinite(content.viewPitch)
      ? content.viewPitch
      : undefined,
    viewRange: Number.isFinite(content.viewRange)
      ? content.viewRange
      : undefined,
    pinLength: Number.isFinite(content.pinLength)
      ? content.pinLength
      : undefined,
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
  const [metas, contents, photoRecords, categoryColors, categoryNames] =
    await Promise.all([
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
      loadCategoryColors().catch((err) => {
        console.warn("カテゴリ色の取得に失敗。ピンは無彩色で表示します", err);
        return {};
      }),
      loadCategoryList().catch((err) => {
        console.warn("カテゴリ一覧の取得に失敗", err);
        return [];
      }),
    ]);

  categoryColorByName = new Map(Object.entries(categoryColors || {}));
  categoryOptions = Array.isArray(categoryNames) ? [...categoryNames] : [];

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

  if (categoryOptions.length === 0) {
    categoryOptions = deriveCategoryOptionsFromSpots(spots);
  } else {
    const known = new Set(categoryOptions);
    for (const category of deriveCategoryOptionsFromSpots(spots)) {
      if (!known.has(category)) {
        known.add(category);
        categoryOptions.push(category);
      }
    }
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
    show: introMarkersRevealed,
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

/** カンマ／全角カンマ区切りのカテゴリ一覧 */
function parseCategoryList(value) {
  return String(value || "")
    .split(/[,、]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function deriveCategoryOptionsFromSpots(spots) {
  const seen = new Set();
  const list = [];
  for (const spot of spots || []) {
    for (const category of parseCategoryList(spot.category)) {
      if (seen.has(category)) continue;
      seen.add(category);
      list.push(category);
    }
  }
  return list;
}

function pinMatchesQuery(spot, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const fields = [
    spot.name,
    spot.description,
    spot.note,
    spot.category,
    spot.role,
    spot.yearFrom,
    spot.yearTo,
  ];
  return fields.some((field) => String(field || "").toLowerCase().includes(q));
}

function pinMatchesCategoryFilter(spot) {
  if (selectedCategories.size === 0) return true;
  return parseCategoryList(spot.category).some((category) =>
    selectedCategories.has(category)
  );
}

function getFilteredSpots() {
  const query = pinSearch ? pinSearch.value.trim() : "";
  return allSpots.filter(
    (spot) => pinMatchesQuery(spot, query) && pinMatchesCategoryFilter(spot)
  );
}

function setSpotEntitiesVisible(spotId, visible) {
  if (!mapViewer) return;
  const marker = mapViewer.entities.getById(`${spotId}-marker`);
  if (marker) marker.show = visible;
  const model = mapViewer.entities.getById(spotId);
  if (model) model.show = visible;
}

function updateSearchCount(filteredCount) {
  if (!searchCount) return;
  const total = allSpots.length;
  const query = pinSearch ? pinSearch.value.trim() : "";
  const hasFilter = Boolean(query) || selectedCategories.size > 0;
  searchCount.textContent = hasFilter ? `${filteredCount} / ${total} 件` : "";
}

function applyFilters() {
  const filtered = getFilteredSpots();
  const visibleIds = new Set(filtered.map((spot) => spot.id));

  for (const spot of allSpots) {
    const show = introMarkersRevealed && visibleIds.has(spot.id);
    setSpotEntitiesVisible(spot.id, show);
  }

  if (activeSpot && !visibleIds.has(activeSpot.id)) {
    hideInfo();
  }

  updateSearchCount(filtered.length);
  if (mapViewer) mapViewer.scene.requestRender();
  return filtered;
}

/** イントロ引き後にピンをふわっと表示する。 */
function revealIntroMarkers() {
  introMarkersRevealed = true;
  if (!mapViewer) {
    applyFilters();
    return;
  }

  const filtered = getFilteredSpots();
  const visibleIds = new Set(filtered.map((spot) => spot.id));
  /** @type {Cesium.Entity[]} */
  const fadingMarkers = [];

  for (const spot of allSpots) {
    const show = visibleIds.has(spot.id);
    const marker = mapViewer.entities.getById(`${spot.id}-marker`);
    const model = mapViewer.entities.getById(spot.id);
    if (model) model.show = show;
    if (!marker) continue;
    if (!show) {
      marker.show = false;
      continue;
    }
    marker.show = true;
    if (marker.billboard) {
      marker.billboard.color = Cesium.Color.WHITE.withAlpha(0);
      marker.billboard.scale = PIN_REVEAL_FROM_SCALE;
    }
    if (marker.polyline) {
      marker.polyline.material = Cesium.Color.fromCssColorString(
        PIN_STEM_COLOR
      ).withAlpha(0);
    }
    fadingMarkers.push(marker);
  }

  if (activeSpot && !visibleIds.has(activeSpot.id)) {
    hideInfo();
  }
  updateSearchCount(filtered.length);

  if (fadingMarkers.length === 0) {
    mapViewer.scene.requestRender();
    return;
  }

  const stemBase = Cesium.Color.fromCssColorString(PIN_STEM_COLOR);
  const startedAt = performance.now();

  const easeOutCubic = (t) => 1 - (1 - t) ** 3;

  const tick = (now) => {
    const t = Math.min(1, (now - startedAt) / PIN_REVEAL_MS);
    const e = easeOutCubic(t);
    const scale =
      PIN_REVEAL_FROM_SCALE + (1 - PIN_REVEAL_FROM_SCALE) * e;

    for (const marker of fadingMarkers) {
      if (marker.billboard) {
        marker.billboard.color = Cesium.Color.WHITE.withAlpha(e);
        marker.billboard.scale = scale;
      }
      if (marker.polyline) {
        marker.polyline.material = stemBase.withAlpha(PIN_STEM_ALPHA * e);
      }
    }

    mapViewer.scene.requestRender();
    if (t < 1) {
      requestAnimationFrame(tick);
    }
  };

  requestAnimationFrame(tick);
}

function renderCategoryFilterTags() {
  if (!categoryFilters) return;
  categoryFilters.replaceChildren();

  const group = categoryFilters.closest(".filter-group");
  if (group) group.classList.toggle("hidden", categoryOptions.length === 0);

  for (const label of categoryOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "filter-tag filter-tag--category" +
      (selectedCategories.has(label) ? " active" : "");

    const color = categoryColorByName.get(label);
    if (color) {
      button.dataset.color = color;
      button.style.setProperty("--tag-color", color);
    }

    const icon = document.createElement("img");
    icon.className = "filter-tag-icon";
    icon.src = ASSETS_CATEGORY_BASE + encodeURIComponent(label) + ".png";
    icon.alt = "";
    icon.loading = "lazy";
    icon.addEventListener("error", () => icon.remove());
    button.append(icon);

    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);

    button.addEventListener("click", () => {
      if (selectedCategories.has(label)) selectedCategories.delete(label);
      else selectedCategories.add(label);
      button.classList.toggle("active", selectedCategories.has(label));
      applyFilters();
    });
    categoryFilters.append(button);
  }
}

function clearFilters() {
  selectedCategories.clear();
  if (pinSearch) pinSearch.value = "";
  renderCategoryFilterTags();
  applyFilters();
}

function setupSearchAndFilters() {
  if (pinSearch) {
    pinSearch.addEventListener("input", () => {
      applyFilters();
    });
  }

  if (filterClear) {
    filterClear.addEventListener("click", clearFilters);
  }

  if (filterPanel && filterToggle) {
    filterPanel.classList.add("filter-panel--open");
    filterToggle.setAttribute("aria-expanded", "true");
    filterToggle.addEventListener("click", () => {
      const open = filterPanel.classList.toggle("filter-panel--open");
      filterToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  if (leftPanel) leftPanel.classList.remove("hidden");
}

/** カテゴリ名 → assets/category/<カテゴリ>.png ＋ カテゴリリストの色 */
function buildCategoryPinLayers(spot) {
  const categories = parseCategoryList(spot.category);
  if (categories.length === 0) {
    return [
      {
        imageUrl: "",
        borderColor: spot.color || "",
        label: spot.name || "",
      },
    ];
  }
  return categories.map((category) => ({
    imageUrl: ASSETS_CATEGORY_BASE + encodeURIComponent(category) + ".png",
    borderColor: categoryColorByName.get(category) || spot.color || "",
    label: category,
  }));
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {object} spot
 */
async function addSpotMarker(viewer, spot) {
  const poleHeight =
    (Number.isFinite(spot.pinLength) && spot.pinLength > 0
      ? spot.pinLength
      : null) ??
    (Number.isFinite(spot.markerHeight) && spot.markerHeight > 0
      ? spot.markerHeight
      : null) ??
    PIN_POLE_HEIGHT_METERS;
  let groundH = 0;
  try {
    const carto = Cesium.Cartographic.fromDegrees(spot.lon, spot.lat);
    const sampled = await Cesium.sampleTerrainMostDetailed(
      viewer.terrainProvider,
      [carto]
    );
    if (Number.isFinite(sampled[0]?.height)) {
      groundH = sampled[0].height;
    }
  } catch (err) {
    console.warn(`ピン用地形サンプリング失敗 (${spot.id})`, err);
  }

  const topH = groundH + poleHeight;
  const layers = buildCategoryPinLayers(spot);
  const { dataUrl, width, height: pinHeight } = await createPinMarkerImageDataUrl(
    spot.name || spot.id || "",
    layers
  );

  const groundPos = Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, groundH);
  const topPos = Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, topH);

  viewer.entities.add({
    id: `${spot.id}-marker`,
    name: spot.name,
    position: topPos,
    show: introMarkersRevealed,
    billboard: {
      image: dataUrl,
      width,
      height: pinHeight,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      sizeInMeters: false,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      eyeOffset: new Cesium.Cartesian3(0, 0, -8),
    },
    polyline: {
      positions: [groundPos, topPos],
      width: PIN_STEM_WIDTH,
      material: Cesium.Color.fromCssColorString(PIN_STEM_COLOR).withAlpha(
        PIN_STEM_ALPHA
      ),
      arcType: Cesium.ArcType.NONE,
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

/**
 * ピン文字を最大シャープにするため、描画解像度は DPR フル（resolutionScale=1）。
 * ピンはシーンと同じフレームバッファに描かれるため、ここを下げると必ず荒くなる。
 */
function applyViewerResolution(viewer) {
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = 1;
}

async function main() {
  if (typeof Cesium === "undefined") {
    setStatus("Cesium の読み込みに失敗しました", true);
    return;
  }

  if (infoFooterClose) {
    infoFooterClose.addEventListener("click", hideInfo);
  }
  if (infoBackdrop) {
    infoBackdrop.addEventListener("click", hideInfo);
  }
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
  if (infoPhotoMetaToggle) {
    infoPhotoMetaToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setPhotoMetaOverlayOpen(!photoMetaOverlayOpen);
    });
  }
  if (lightboxPhotoMetaToggle) {
    lightboxPhotoMetaToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setPhotoMetaOverlayOpen(!photoMetaOverlayOpen);
    });
  }
  if (infoPhotoMetaOverlay) {
    infoPhotoMetaOverlay.addEventListener("click", (event) => {
      event.stopPropagation();
      setPhotoMetaOverlayOpen(false);
    });
  }
  if (lightboxPhotoMetaOverlay) {
    lightboxPhotoMetaOverlay.addEventListener("click", (event) => {
      event.stopPropagation();
      setPhotoMetaOverlayOpen(false);
    });
  }
  if (infoImageButton) {
    infoImageButton.addEventListener("click", () => {
      if (isShowingModel()) return;
      const photo = currentGalleryPhoto();
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
  setupLightboxZoomInteractions();
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
        if (photoMetaOverlayOpen) {
          setPhotoMetaOverlayOpen(false);
          return;
        }
        closePhotoLightbox();
        return;
      }
      if (isPhotoThumbLightboxOpen() || photoListOpen) {
        setPhotoListOpen(false);
        return;
      }
      if (photoMetaOverlayOpen) {
        setPhotoMetaOverlayOpen(false);
        return;
      }
      if (isInfoSessionActive()) {
        hideInfo();
      }
      return;
    }

    if (!galleryItems.length || galleryItems.length <= 1) return;
    if (
      !isPhotoLightboxOpen() &&
      !isPhotoThumbLightboxOpen() &&
      !isInfoOpen()
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
  setIntroSplashStatus("浅草を読み込み中…");
  setIntroSplashProgress(6);
  const introStartedAt = performance.now();
  const INTRO_MIN_MS = 1600;

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

  // ピンを最大シャープにするため DPR フル解像度で描画する
  applyViewerResolution(viewer);
  // FXAA は細字・円縁をぼかすのでオフ（ピン優先）
  viewer.scene.fxaa = false;
  viewer.scene.globe.maximumScreenSpaceError = 2;
  viewer.scene.globe.tileCacheSize = 100;

  viewer.imageryLayers.addImageryProvider(createGsiImageryProvider());
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#bfbfbf");
  // 寄り冒頭は地形深度テストを切る（一瞬門が地面に埋まったように見えるのを防ぐ）
  viewer.scene.globe.depthTestAgainstTerrain = false;
  applyPlateauViewSceneLighting(viewer);
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 20;
  // 表示円（半径1km）が画面に収まる程度で引き込みを止める
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = 3500;
  // 近接初期視点が地形衝突で押し上げられないようにする
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;

  applyInitialView(viewer);

  mapViewer = viewer;
  setupClickHandler(viewer);
  setupDevPanel(viewer);
  window.__asakusaViewer = viewer;

  // 地形・建物・スポットを並行開始（地形待ちで建物が止まらないようにする）
  setStatus("浅草エリアを読み込み中…");
  setIntroSplashProgress(12);
  const terrainPromise = Cesium.CesiumTerrainProvider.fromUrl(
    PLATEAU_TERRAIN_URL,
    { requestVertexNormals: false }
  )
    .then((terrainProvider) => {
      viewer.terrainProvider = terrainProvider;
      viewer.scene.requestRender();
      setIntroSplashProgress(28);
    })
    .catch((terrainErr) => {
      console.warn("PLATEAU-Terrain の読み込みに失敗:", terrainErr);
      setIntroSplashProgress(28);
    });

  const buildingsPromise = loadAsakusaBuildings(viewer)
    .then((tilesets) => {
      setIntroSplashProgress(42);
      return tilesets;
    })
    .catch((err) => {
      console.error(err);
      setStatus(
        "PLATEAU 建物の読み込みに失敗しました（地形・スポットのみ表示）",
        true
      );
      return null;
    });

  try {
    const spotsPromise = loadSpots().then((spots) => {
      setIntroSplashProgress(36);
      return spots;
    });

    const [spots, tilesets] = await Promise.all([
      spotsPromise,
      buildingsPromise,
      terrainPromise,
    ]);
    setIntroSplashProgress(48);

    allSpots = spots.filter((spot) => spot.visibility !== "ar");
    setupSearchAndFilters();
    renderCategoryFilterTags();

    // ピンだけ先に置く（重いモデルはマップ表示後に遅延読込）
    setIntroSplashStatus("スポットを配置中…");
    setIntroSplashProgress(52);
    for (const spot of allSpots) {
      spotById.set(spot.id, spot);
      await addSpotMarker(viewer, spot);
    }
    applyFilters();
    setIntroSplashProgress(56);

    // 寄り視点で雷門など建物タイルが揃うまでタイトルを出し続ける
    applyInitialView(viewer);
    setIntroSplashStatus("建物モデルを読み込み中…");
    /** @type {(() => void) | null} */
    let endIntroQuality = null;
    if (Array.isArray(tilesets)) {
      endIntroQuality = await waitForInitialTiles(viewer, tilesets);
    } else {
      setIntroSplashProgress(100);
    }

    const remainingIntro = INTRO_MIN_MS - (performance.now() - introStartedAt);
    if (remainingIntro > 0) {
      setIntroSplashStatus("地形を整えています…");
      setIntroSplashProgress(100);
      await new Promise((resolve) => setTimeout(resolve, remainingIntro));
    }

    applyInitialView(viewer);
    // 地形表示は出したまま、タイルが落ち着いてからスプラッシュを外す
    viewer.scene.requestRenderMode = false;
    viewer.scene.globe.depthTestAgainstTerrain = false;
    setIntroSplashStatus("地形を整えています…");
    await waitForGlobeTiles(viewer);

    setIntroSplashStatus("まもなく表示します…");
    setIntroSplashProgress(100);
    for (let i = 0; i < 3; i += 1) {
      applyInitialView(viewer);
      viewer.scene.requestRender();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    setIntroSplashStatus("");
    revealMapFromIntro();
    setStatus("");

    await playIntroPullback(viewer);
    if (endIntroQuality) endIntroQuality();

    // 引き終わってからピンを出す
    revealIntroMarkers();
    setStatus("スポットをクリックすると説明が表示されます");
    setTimeout(() => setStatus(""), 5000);

    // 3D モデルはピン表示後に遅延読込
    void (async () => {
      for (const spot of allSpots) {
        if (!spot.model) continue;
        try {
          await addSpotModel(viewer, spot);
          const filtered = getFilteredSpots();
          const visibleIds = new Set(filtered.map((s) => s.id));
          setSpotEntitiesVisible(
            spot.id,
            introMarkersRevealed && visibleIds.has(spot.id)
          );
        } catch (modelErr) {
          console.warn(`モデル読込失敗: ${spot.id}`, modelErr);
        }
      }
      viewer.scene.requestRender();
    })();
  } catch (err) {
    console.error(err);
    setStatus(`スポット読込失敗: ${err.message}`, true);
    await buildingsPromise;
    applyInitialView(viewer);
    setIntroSplashStatus("");
    revealMapFromIntro();
    await playIntroPullback(viewer);
    revealIntroMarkers();
  }
}

main().catch((err) => {
  console.error(err);
  setStatus(`起動エラー: ${err.message}`, true);
  revealMapFromIntro();
});
