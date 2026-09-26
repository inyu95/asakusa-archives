# 浅草タイムトラベル（Web）

CesiumJS で浅草エリアに PLATEAU 建物を表示し、復元モデル（凌雲閣）を重ねます。浅草外は地形・航空写真のみです。

## 必要環境

- Node.js 18+（ローカルサーバー用）
- ブラウザ（Chrome / Edge 推奨）

## 起動

### Node.js がある場合

```bash
npm start
```

### Node.js が無い場合（.NET 8）

```bash
dotnet run -c Release --project tools/StaticServer/StaticServer.csproj -- web 5173
```

ブラウザで http://127.0.0.1:5173/ を開きます。

## フォルダ構成

```text
web/
  index.html
  css/style.css
  js/app.js
  js/sheets.js            ← マッピングシート読込
  js/photos.js            ← 写真フォルダ解決
  js/gviz.js
  data/spots.json         ← Unity モデル配置のみ（lat/lon・scale など）
  data/plateau-asakusa-bldg-lod2.json ← 浅草範囲 PLATEAU 建物（LOD2・平坦タイル）
  assets/photos/          ← スポット写真（フォルダ単位）
  models/Ryouunkaku.glb   ← メインの表示モデル
  models/Ryouunkaku.obj   ← 変換元（任意）
```

周辺建物は台東区全体の tileset ではなく、浅草付近の z17 葉タイルだけを平坦に並べた `data/plateau-asakusa-bldg-lod2.json` を使います（親↔子の REPLACE による欠けを避けます）。更新する場合:

```bash
npm run trim:plateau-asakusa
```

## データ分担

| ソース | 役割 |
|---|---|
| [Google スプレッドシート「マッピング」](https://docs.google.com/spreadsheets/d/1CJfTgaM-C0iL7YGpSJVuTUNn9JkpKs5O7dypYBJ1oAA/edit) | **ピン位置**＋情報パネル（名称・説明・注記・写真フォルダ・URL・年代など） |
| 同スプレッドシート「画像データ」 | 写真一覧とメタ（フォルダパス・データ名・タイトル・年代・作者など） |
| `data/spots.json` | **Unity モデルの配置のみ**（`id`・`lat`/`lon`・`height`・`model`・`scale`・`heading` など） |

起動時にシートと JSON をマージします。

- **ピンの位置**はシートの緯度経度が正
- **3D モデルの位置**は `spots.json`（Unity 側の配置）が正
- **情報パネル**（名称・説明・注記・年代・リンク・写真）はシートのみ
- 照合は `id`、または名称（括弧より前）／`sheetName`
- シートは「リンクを知っている全員が閲覧可」である必要があります

情報パネルの注記を出す場合は、マッピングシートに `注記`（または `備考` / `note`）列を追加してください。

## 写真（複数枚）

写真は **シート「画像データ」** が正です（`index.json` は使いません）。

1. `web/assets/photos/<フォルダ名>/` に画像を置く  
2. 「画像データ」に `フォルダパス`（例: `assets/photos/凌雲閣`）と `データ名`（例: `1.jpg`）を記入し、タイトル・年代・作者などを埋める  
3. 「マッピング」の `image` 列に同じフォルダを書く  

情報パネルで ‹ › により複数枚を切り替え、各写真のメタを表示します。`表示順` があればその順、なければシート行順です。

## モデル変換（OBJ → GLB）

```bash
dotnet run -c Release --project tools/ObjToGlb/ObjToGlb.csproj -- web/models/Ryouunkaku.obj web/models/Ryouunkaku.glb
```

生成された `web/models/Ryouunkaku.glb` を `data/spots.json` の `model` が参照します。
高さは史実の約52mに近づけるため、spots 側の `scale`（現状 0.86）で調整しています。

変換時に頂点クラスタリング（既定セルサイズ 0.18 m）でメッシュを軽量化します。
第3引数でセルサイズを変えられます（大きいほど軽く、ディテールは落ちます）。

## スポットの追加

1. スプレッドシート「マッピング」に行を追加（`name` / `lat,lon` / `text` / `image` / URL・年代など）— ピンはこの座標
2. 3D モデルがある場合は `spots.json` に Unity 配置を追加し、`id` または `sheetName` でシート行と対応させる

`spots.json` のフィールド（コンテンツやピン座標は入れない。Unity モデル配置のみ）:

| フィールド | 説明 |
|---|---|
| `id` | 一意な ID（シートの id 列と揃えると確実） |
| `sheetName` | シートの `name` と照合するための短縮名（任意） |
| `lat` / `lon` / `height` | Unity モデルの位置。`height` は楕円体高（m）。地形が取れた場合は地形高＋`heightOffset` で接地 |
| `heightOffset` | 地形高からの追加オフセット（m）。省略時 0 |
| `heading` | 方位（度） |
| `model` | glb への相対パス |
| `scale` | モデル倍率 |

## データ出典

- 3D都市モデル: [Project PLATEAU](https://www.mlit.go.jp/plateau/)（台東区 2025・浅草範囲のみ表示）
- 地形: [PLATEAU-Terrain](https://docs.plateauview.mlit.go.jp/datasets/terrain/)（楕円体高・ジオイド補正済み）
- 航空写真: 地理院タイル（シームレス写真）

## 表示の注意

- **浅草内**: PLATEAU 建物＋歴史スポット（`trim:plateau-asakusa` で葉タイルのみ抽出）。
- **浅草外**: 3D 建物タイル自体が無いので、地形・航空写真のみ。
- 復元モデルの接地のため PLATEAU-Terrain を使います。
- 建物の見え方は [PLATEAU VIEW](https://plateauview.mlit.go.jp/) に合わせ、Cesium **1.118**＋公式相当の IBL を使います（UNLIT / 色加算はしません）。
