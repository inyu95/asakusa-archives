using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using PLATEAU.CityInfo;
using PLATEAU.Native;
using UnityEditor;
using UnityEngine;

/// <summary>
/// シーン上の WebSpotPlacement を lat/lon/heading に変換し、
/// リポジトリの web/data/spots.json へマージ書き出しする。
/// 書き出し単位は「置いてある GLB インスタンス」1 つ = spots.json 1 エントリ。
/// </summary>
public static class ExportWebSpotsMenu
{
    const string MenuRoot = "Asakusa Time Travel/";
    /// <summary>人物パックの Web 用（低ポリのみ・約35MB）。Unity の元 GLB より軽い。</summary>
    const string DefaultCrowdModel = "models/people-business-crowd.glb";
    const string DefaultModel = DefaultCrowdModel;

    [MenuItem(MenuRoot + "Export Spots JSON", false, 10)]
    public static void ExportSpotsJson()
    {
        var city = FindCityModel();
        if (city == null)
        {
            EditorUtility.DisplayDialog(
                "Export Spots JSON",
                "シーンに PLATEAUInstancedCityModel がありません。",
                "OK");
            return;
        }

        var placements = UnityEngine.Object.FindObjectsByType<WebSpotPlacement>(
            FindObjectsInactive.Exclude,
            FindObjectsSortMode.None);
        if (placements.Length == 0)
        {
            EditorUtility.DisplayDialog(
                "Export Spots JSON",
                "WebSpotPlacement が付いたオブジェクトがありません。\n" +
                "GLB のルートにコンポーネントを付けるか、\n" +
                "「Add WebSpotPlacement to Selection」を使ってください。",
                "OK");
            return;
        }

        // 子に付いた Placement を GLB ルートへ寄せてから書き出す
        NormalizePlacementsToGlbRoots(placements);
        placements = UnityEngine.Object.FindObjectsByType<WebSpotPlacement>(
            FindObjectsInactive.Exclude,
            FindObjectsSortMode.None);
        EnsureUniquePlacementIds(placements);

        var spotsPath = GetSpotsJsonPath();
        if (!File.Exists(spotsPath))
        {
            EditorUtility.DisplayDialog(
                "Export Spots JSON",
                $"spots.json が見つかりません:\n{spotsPath}",
                "OK");
            return;
        }

        var exported = BuildExportedSpots(city, placements);
        if (exported.Count == 0)
        {
            EditorUtility.DisplayDialog("Export Spots JSON", "書き出すスポットがありません。", "OK");
            return;
        }

        var existing = SpotJsonUtil.ReadSpots(File.ReadAllText(spotsPath, Encoding.UTF8));
        // 人物など export 対象 id はすべて差し替え。凌雲閣など未マークは保持。
        var exportIds = new HashSet<string>(exported.Select(s => s.Id), StringComparer.Ordinal);
        // 以前の person-* / crowd-* も消して、今回の配置だけにする
        var merged = existing
            .Where(s => !exportIds.Contains(s.Id) && !IsManagedPersonId(s.Id))
            .ToList();
        merged.AddRange(exported.OrderBy(s => s.Id, StringComparer.Ordinal));

        var json = SpotJsonUtil.WriteSpots(merged);
        File.WriteAllText(spotsPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        var kept = merged.Count - exported.Count;
        var peopleCount = exported.Sum(s => s.People?.Count ?? 0);
        Debug.Log(
            $"[ExportWebSpots] GLB {exported.Count} 件 / 人物 {peopleCount} 体 / 保持 {kept} 件 → {spotsPath}");
        EditorUtility.DisplayDialog(
            "Export Spots JSON",
            $"書き出し完了\n\nGLB: {exported.Count} 件\n人物: {peopleCount} 体（各位置）\nその他保持: {kept} 件\n\n{spotsPath}",
            "OK");
    }

    [MenuItem(MenuRoot + "Add WebSpotPlacement to Selection", false, 11)]
    public static void AddPlacementToSelection()
    {
        var transforms = Selection.transforms;
        if (transforms.Length == 0)
        {
            EditorUtility.DisplayDialog(
                "Add WebSpotPlacement",
                "Hierarchy で GLB（モデルインスタンス）を選択してください。",
                "OK");
            return;
        }

        var existingAll = UnityEngine.Object.FindObjectsByType<WebSpotPlacement>(
            FindObjectsInactive.Exclude,
            FindObjectsSortMode.None);
        var usedIds = new HashSet<string>(
            existingAll.Select(p => p.ResolvedId),
            StringComparer.OrdinalIgnoreCase);

        // 選択を GLB インスタンスルート単位に集約（シーンルートへは上げない）
        var glbRoots = transforms
            .Select(ResolveGlbInstanceRoot)
            .Where(t => t != null)
            .Distinct()
            .OrderBy(t => t.GetSiblingIndex())
            .ToArray();

        var added = 0;
        foreach (var t in glbRoots)
        {
            var modelPath = ResolveWebModelPath(t.gameObject, null);
            var idPrefix = IdPrefixFromModelPath(modelPath);

            var placement = t.GetComponent<WebSpotPlacement>();
            if (placement == null)
            {
                // 子にだけ付いている場合は GLB ルートへ寄せる
                var childPlacement = t.GetComponentsInChildren<WebSpotPlacement>(true)
                    .FirstOrDefault(p => p.transform != t);
                placement = Undo.AddComponent<WebSpotPlacement>(t.gameObject);
                added++;
                if (childPlacement != null)
                {
                    Undo.RecordObject(placement, "Copy WebSpotPlacement");
                    placement.spotId = childPlacement.spotId;
                    placement.model = childPlacement.model;
                    placement.heightOffset = childPlacement.heightOffset;
                    placement.scaleOverride = childPlacement.scaleOverride;
                    placement.visibility = childPlacement.visibility;
                    Undo.DestroyObjectImmediate(childPlacement);
                }
            }

            // 同じ GLB 配下の余分な WebSpotPlacement を除去
            foreach (var extra in t.GetComponentsInChildren<WebSpotPlacement>(true)
                         .Where(p => p != placement)
                         .ToArray())
            {
                Undo.DestroyObjectImmediate(extra);
            }

            if (string.IsNullOrWhiteSpace(placement.spotId) ||
                usedIds.Contains(placement.spotId.Trim()))
            {
                var id = NextId(idPrefix, usedIds);
                Undo.RecordObject(placement, "Set WebSpotPlacement id");
                placement.spotId = id;
                usedIds.Add(id);
            }
            else
            {
                usedIds.Add(placement.spotId.Trim());
            }

            Undo.RecordObject(placement, "Set WebSpotPlacement model");
            placement.model = modelPath;
            EditorUtility.SetDirty(placement);
        }

        EditorUtility.DisplayDialog(
            "Add WebSpotPlacement",
            $"{glbRoots.Length} GLB を設定しました（新規 {added} 件）。\n" +
            "各 GLB インスタンスが spots.json の 1 エントリになります。\n" +
            "続けて Export Spots JSON を実行してください。",
            "OK");
    }

    [MenuItem(MenuRoot + "Copy Selected Models to web/models", false, 12)]
    public static void CopyModelsToWeb()
    {
        var webModelsDir = GetWebModelsDir();
        Directory.CreateDirectory(webModelsDir);

        var copied = 0;
        var sources = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var obj in Selection.objects)
        {
            var path = AssetDatabase.GetAssetPath(obj);
            if (string.IsNullOrEmpty(path))
                continue;
            if (!path.EndsWith(".glb", StringComparison.OrdinalIgnoreCase) &&
                !path.EndsWith(".gltf", StringComparison.OrdinalIgnoreCase))
                continue;
            sources.Add(path);
        }

        foreach (var placement in UnityEngine.Object.FindObjectsByType<WebSpotPlacement>(
                     FindObjectsInactive.Exclude, FindObjectsSortMode.None))
        {
            var assetPath = FindAssetForModelField(placement.model);
            if (!string.IsNullOrEmpty(assetPath))
                sources.Add(assetPath);
        }

        // crowd 用 GLB が web にあればそれで足りる（元パックはコピーしない）
        var crowdWeb = Path.Combine(webModelsDir, "people-business-crowd.glb");
        if (File.Exists(crowdWeb))
        {
            // 元パックへの参照だけならスキップ可
        }

        if (sources.Count == 0)
        {
            EditorUtility.DisplayDialog(
                "Copy Models",
                "コピー対象の GLB/GLTF がありません。\nProject で GLB を選ぶか、WebSpotPlacement を付けてください。",
                "OK");
            return;
        }

        var projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        foreach (var assetPath in sources)
        {
            // 100MB 超の元パックは Web に載せない
            if (assetPath.IndexOf("Japanese_3D_People", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                Debug.Log($"[ExportWebSpots] スキップ（Web では {DefaultCrowdModel} を使用）: {assetPath}");
                continue;
            }

            var fullSrc = Path.GetFullPath(Path.Combine(projectRoot, assetPath));
            if (!File.Exists(fullSrc))
            {
                Debug.LogWarning($"[ExportWebSpots] ソースが見つかりません: {assetPath}");
                continue;
            }

            var destName = Path.GetFileName(assetPath);
            var dest = Path.Combine(webModelsDir, destName);
            File.Copy(fullSrc, dest, overwrite: true);
            copied++;
            Debug.Log($"[ExportWebSpots] Copied {assetPath} → {dest}");
        }

        EditorUtility.DisplayDialog(
            "Copy Models",
            $"{copied} ファイルをコピーしました:\n{webModelsDir}",
            "OK");
    }

    /// <summary>
    /// シーンに置いた GLB（モデル）インスタンスのルートを返す。
    /// transform.root（シーンルート）には上げない。
    /// </summary>
    static Transform ResolveGlbInstanceRoot(Transform t)
    {
        if (t == null)
            return null;

        // GLB/プレハブとして置いたときのインスタンス根
        var prefabRoot = PrefabUtility.GetNearestPrefabInstanceRoot(t.gameObject);
        if (prefabRoot != null)
        {
            var assetPath = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(prefabRoot);
            if (!string.IsNullOrEmpty(assetPath) &&
                (assetPath.EndsWith(".glb", StringComparison.OrdinalIgnoreCase) ||
                 assetPath.EndsWith(".gltf", StringComparison.OrdinalIgnoreCase) ||
                 assetPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)))
                return prefabRoot.transform;
            // プレハブでも GLB 由来なら根を使う
            if (prefabRoot != null)
                return prefabRoot.transform;
        }

        // ソースアセットが GLB の祖先を探す
        for (var p = t; p != null; p = p.parent)
        {
            var src = PrefabUtility.GetCorrespondingObjectFromSource(p.gameObject);
            if (src == null)
                continue;
            var path = AssetDatabase.GetAssetPath(src);
            if (string.IsNullOrEmpty(path))
                continue;
            if (path.EndsWith(".glb", StringComparison.OrdinalIgnoreCase) ||
                path.EndsWith(".gltf", StringComparison.OrdinalIgnoreCase))
                return p;
        }

        // 名前で GLB ルートらしいものを拾う
        var name = t.gameObject.name ?? "";
        if (LooksLikeGlbRootName(name))
            return t;

        for (var p = t.parent; p != null; p = p.parent)
        {
            if (LooksLikeGlbRootName(p.gameObject.name))
                return p;
        }

        var existing = t.GetComponentInParent<WebSpotPlacement>();
        if (existing != null)
            return existing.transform;

        return t;
    }

    static bool LooksLikeGlbRootName(string name)
    {
        if (string.IsNullOrEmpty(name))
            return false;
        if (name.IndexOf("Japanese_3D_People", StringComparison.OrdinalIgnoreCase) >= 0)
            return true;
        if (name.IndexOf("people-business", StringComparison.OrdinalIgnoreCase) >= 0)
            return true;
        if (name.EndsWith(".glb", StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }

    /// <summary>
    /// 子に付いた Placement を GLB ルートへ移し、重複を消す。
    /// </summary>
    static void NormalizePlacementsToGlbRoots(WebSpotPlacement[] placements)
    {
        var byRoot = placements
            .GroupBy(p => ResolveGlbInstanceRoot(p.transform))
            .Where(g => g.Key != null);

        foreach (var group in byRoot)
        {
            var root = group.Key;
            var keep = root.GetComponent<WebSpotPlacement>();
            if (keep == null)
            {
                var donor = group.First();
                keep = Undo.AddComponent<WebSpotPlacement>(root.gameObject);
                keep.spotId = donor.spotId;
                keep.model = donor.model;
                keep.heightOffset = donor.heightOffset;
                keep.scaleOverride = donor.scaleOverride;
                keep.visibility = donor.visibility;
                keep.sheetName = donor.sheetName;
                EditorUtility.SetDirty(keep);
            }

            keep.model = ResolveWebModelPath(root.gameObject, keep.model);
            EditorUtility.SetDirty(keep);

            foreach (var extra in root.GetComponentsInChildren<WebSpotPlacement>(true)
                         .Where(p => p != keep)
                         .ToArray())
            {
                Undo.DestroyObjectImmediate(extra);
            }
        }
    }

    static string IdPrefixFromModelPath(string modelPath)
    {
        if (string.IsNullOrWhiteSpace(modelPath))
            return "model";
        var file = Path.GetFileNameWithoutExtension(modelPath.Trim().Replace('\\', '/'));
        if (string.IsNullOrEmpty(file))
            return "model";
        return WebSpotPlacementSanitizeId(file);
    }

    // WebSpotPlacement.SanitizeId と同じ規則（Editor から呼ぶ用）
    static string WebSpotPlacementSanitizeId(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return "model";
        var chars = name.Trim().ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            var c = chars[i];
            if (char.IsLetterOrDigit(c) || c == '-' || c == '_')
                continue;
            chars[i] = '-';
        }
        return new string(chars).Trim('-').ToLowerInvariant();
    }

    static string NextId(string prefix, HashSet<string> usedIds)
    {
        var n = 1;
        string id;
        do
        {
            id = $"{prefix}-{n:D2}";
            n++;
        } while (usedIds.Contains(id));
        return id;
    }

    static void EnsureUniquePlacementIds(WebSpotPlacement[] placements)
    {
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var placement in placements.OrderBy(p => p.transform.GetSiblingIndex()))
        {
            var id = placement.ResolvedId;
            var prefix = IdPrefixFromModelPath(
                ResolveWebModelPath(placement.gameObject, placement.model));
            if (string.IsNullOrWhiteSpace(id) || !used.Add(id))
            {
                id = NextId(prefix, used);
                used.Add(id);
                Undo.RecordObject(placement, "Unique WebSpotPlacement id");
                placement.spotId = id;
                EditorUtility.SetDirty(placement);
            }
        }
    }

    static bool IsManagedPersonId(string id)
    {
        if (string.IsNullOrEmpty(id))
            return false;
        if (id.StartsWith("person-", StringComparison.OrdinalIgnoreCase))
            return true;
        if (id.StartsWith("crowd-", StringComparison.OrdinalIgnoreCase))
            return true;
        if (id.StartsWith("people-business-crowd", StringComparison.OrdinalIgnoreCase))
            return true;
        if (id.StartsWith("jpgv01_", StringComparison.OrdinalIgnoreCase))
            return true;
        if (id.IndexOf("japanese_3d_people", StringComparison.OrdinalIgnoreCase) >= 0)
            return true;
        return false;
    }

    static string ModelPathFromPersonName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return null;
        var m = Regex.Match(name, @"JPGV01_([MW])(\d+)", RegexOptions.IgnoreCase);
        if (!m.Success)
            return null;
        var sex = m.Groups[1].Value.ToLowerInvariant();
        var num = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        // Web に無い番号は 1–3 に折り返す
        var idx = ((num - 1) % 3) + 1;
        return $"models/person-business-{sex}{idx:D2}.glb";
    }

    /// <summary>
    /// 人物パック内の各人。H50k / L10k の両方を含む（Unity 上は別位置に並んでいる）。
    /// Web ではどちらも軽量 1 体 GLB にマッピングする。
    /// </summary>
    static List<Transform> FindPeopleTransforms(Transform root)
    {
        return root.GetComponentsInChildren<Transform>(true)
            .Where(t => t != root)
            .Where(t => Regex.IsMatch(t.name ?? "", @"JPGV01_[MW]\d+", RegexOptions.IgnoreCase))
            .OrderBy(t => t.GetSiblingIndex())
            .ToList();
    }

    static List<PersonRecord> BuildPeopleRecords(
        PLATEAUInstancedCityModel city,
        WebSpotPlacement placement)
    {
        var list = new List<PersonRecord>();
        using var geo = city.GeoReference;
        foreach (var tr in FindPeopleTransforms(placement.transform))
        {
            var pos = tr.position;
            var geoCoord = geo.Unproject(new PlateauVector3d(pos.x, pos.y, pos.z));
            list.Add(new PersonRecord
            {
                Model = ModelPathFromPersonName(tr.name) ?? "models/person-business-w01.glb",
                Lat = geoCoord.Latitude,
                Lon = geoCoord.Longitude,
                Height = geoCoord.Height,
                Heading = NormalizeDegrees(tr.eulerAngles.y),
                Scale = placement.ResolvedScale,
            });
        }
        return list;
    }

    /// <summary>
    /// Unity の人物アセット名を Web に実在する GLB パスへ差し替える。
    /// JPGV01_* → person-business-*.glb / パック全体 → people-business-crowd.glb
    /// </summary>
    static string ResolveWebModelPath(GameObject go, string currentModel)
    {
        // オブジェクト名から先に解決（個別に切り出した JPGV01_* 用）
        var fromName = ModelPathFromPersonName(go != null ? go.name : null);
        if (fromName != null)
            return fromName;

        var guessed = GuessModelPath(go);
        var raw = string.IsNullOrWhiteSpace(currentModel) ? guessed : currentModel;
        if (string.IsNullOrWhiteSpace(raw))
            return DefaultCrowdModel;
        raw = raw.Trim().Replace('\\', '/');

        var fromRaw = ModelPathFromPersonName(Path.GetFileNameWithoutExtension(raw));
        if (fromRaw != null)
            return fromRaw;

        if (raw.IndexOf("Japanese_3D_People", StringComparison.OrdinalIgnoreCase) >= 0)
            return DefaultCrowdModel;
        if (raw.IndexOf("people-business-crowd", StringComparison.OrdinalIgnoreCase) >= 0)
            return DefaultCrowdModel;
        if (raw.StartsWith("models/person-business-", StringComparison.OrdinalIgnoreCase))
            return raw;
        return raw;
    }

    static List<SpotRecord> BuildExportedSpots(
        PLATEAUInstancedCityModel city,
        WebSpotPlacement[] placements)
    {
        var list = new List<SpotRecord>();
        using var geo = city.GeoReference;

        // GLB インスタンス単位（Normalize 済み想定。念のため再集約）
        var glbPlacements = placements
            .Select(p =>
            {
                var root = ResolveGlbInstanceRoot(p.transform);
                var onRoot = root != null ? root.GetComponent<WebSpotPlacement>() : null;
                return onRoot != null ? onRoot : p;
            })
            .Distinct()
            .OrderBy(p => p.transform.GetSiblingIndex())
            .ToArray();

        foreach (var placement in glbPlacements)
        {
            var pos = placement.transform.position;
            var geoCoord = geo.Unproject(new PlateauVector3d(pos.x, pos.y, pos.z));
            var heading = NormalizeDegrees(placement.transform.eulerAngles.y);
            var visibility = string.IsNullOrWhiteSpace(placement.visibility)
                ? "both"
                : placement.visibility.Trim();
            var model = ResolveWebModelPath(placement.gameObject, placement.model);
            var people = IsPeoplePackModel(model)
                ? BuildPeopleRecords(city, placement)
                : null;

            list.Add(new SpotRecord
            {
                Id = placement.ResolvedId,
                SheetName = string.IsNullOrWhiteSpace(placement.sheetName)
                    ? null
                    : placement.sheetName.Trim(),
                Lat = geoCoord.Latitude,
                Lon = geoCoord.Longitude,
                Height = geoCoord.Height,
                HeightOffset = placement.heightOffset,
                Heading = heading,
                Scale = placement.ResolvedScale,
                Model = model,
                Visibility = visibility,
                People = people != null && people.Count > 0 ? people : null,
            });
        }

        return list;
    }

    static bool IsPeoplePackModel(string model)
    {
        if (string.IsNullOrEmpty(model))
            return false;
        return model.IndexOf("people-business-crowd", StringComparison.OrdinalIgnoreCase) >= 0
               || model.IndexOf("Japanese_3D_People", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    static PLATEAUInstancedCityModel FindCityModel()
    {
        return UnityEngine.Object.FindFirstObjectByType<PLATEAUInstancedCityModel>();
    }

    static string GetSpotsJsonPath()
    {
        // Assets → プロジェクト → リポジトリルート → web/data/spots.json
        return Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "web", "data", "spots.json"));
    }

    static string GetWebModelsDir()
    {
        return Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "web", "models"));
    }

    static string GuessModelPath(GameObject go)
    {
        if (go != null)
        {
            var fromName = ModelPathFromPersonName(go.name);
            if (fromName != null)
                return fromName;
        }

        var prefab = PrefabUtility.GetCorrespondingObjectFromSource(go);
        if (prefab == null)
            return DefaultCrowdModel;
        var path = AssetDatabase.GetAssetPath(prefab);
        if (string.IsNullOrEmpty(path))
            return DefaultCrowdModel;
        if (path.IndexOf("Japanese_3D_People", StringComparison.OrdinalIgnoreCase) >= 0)
            return DefaultCrowdModel;

        var fromFile = ModelPathFromPersonName(Path.GetFileNameWithoutExtension(path));
        if (fromFile != null)
            return fromFile;

        if (!path.EndsWith(".glb", StringComparison.OrdinalIgnoreCase) &&
            !path.EndsWith(".gltf", StringComparison.OrdinalIgnoreCase))
            return DefaultCrowdModel;
        return "models/" + Path.GetFileName(path);
    }

    static string FindAssetForModelField(string modelField)
    {
        if (string.IsNullOrWhiteSpace(modelField))
            return null;
        var fileName = Path.GetFileName(modelField.Trim().Replace('\\', '/'));
        var guids = AssetDatabase.FindAssets(Path.GetFileNameWithoutExtension(fileName));
        foreach (var guid in guids)
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            if (string.Equals(Path.GetFileName(path), fileName, StringComparison.OrdinalIgnoreCase))
                return path;
        }
        return null;
    }

    static double NormalizeDegrees(float degrees)
    {
        var d = degrees % 360f;
        if (d < 0f)
            d += 360f;
        return Math.Round(d, 2);
    }
}

[Serializable]
class SpotRecord
{
    public string Id;
    public string SheetName;
    public double Lat;
    public double Lon;
    public double Height;
    public double HeightOffset;
    public double Heading;
    public double Scale;
    public string Model;
    public string Visibility;
    public List<PersonRecord> People;
}

[Serializable]
class PersonRecord
{
    public string Model;
    public double Lat;
    public double Lon;
    public double Height;
    public double Heading;
    public double Scale;
}

/// <summary>
/// spots.json の最小パーサ／ライタ（既存エントリを消さないマージ用）。
/// </summary>
static class SpotJsonUtil
{
    public static List<SpotRecord> ReadSpots(string json)
    {
        var list = new List<SpotRecord>();
        if (string.IsNullOrWhiteSpace(json))
            return list;

        var spotsKey = json.IndexOf("\"spots\"", StringComparison.Ordinal);
        if (spotsKey < 0)
            return list;
        var arrayStart = json.IndexOf('[', spotsKey);
        if (arrayStart < 0)
            return list;

        var i = arrayStart + 1;
        while (i < json.Length)
        {
            SkipWs(json, ref i);
            if (i >= json.Length)
                break;
            if (json[i] == ']')
                break;
            if (json[i] != '{')
            {
                i++;
                continue;
            }

            var obj = ReadObject(json, ref i);
            var record = ParseObject(obj);
            if (!string.IsNullOrEmpty(record.Id))
                list.Add(record);

            SkipWs(json, ref i);
            if (i < json.Length && json[i] == ',')
                i++;
        }

        return list;
    }

    public static string WriteSpots(List<SpotRecord> spots)
    {
        var sb = new StringBuilder();
        sb.Append("{\n  \"spots\": [\n");
        for (var i = 0; i < spots.Count; i++)
        {
            AppendSpot(sb, spots[i], "    ");
            if (i < spots.Count - 1)
                sb.Append(',');
            sb.Append('\n');
        }
        sb.Append("  ]\n}\n");
        return sb.ToString();
    }

    static void AppendSpot(StringBuilder sb, SpotRecord s, string indent)
    {
        var hasPeople = s.People != null && s.People.Count > 0;
        sb.Append(indent).Append("{\n");
        WriteString(sb, indent, "id", s.Id, trailingComma: true);
        if (!string.IsNullOrEmpty(s.SheetName))
            WriteString(sb, indent, "sheetName", s.SheetName, trailingComma: true);
        WriteNumber(sb, indent, "lat", s.Lat, trailingComma: true);
        WriteNumber(sb, indent, "lon", s.Lon, trailingComma: true);
        WriteNumber(sb, indent, "height", s.Height, trailingComma: true);
        if (Math.Abs(s.HeightOffset) > 1e-9)
            WriteNumber(sb, indent, "heightOffset", s.HeightOffset, trailingComma: true);
        WriteNumber(sb, indent, "heading", s.Heading, trailingComma: true);
        WriteNumber(sb, indent, "scale", s.Scale, trailingComma: true);
        WriteString(sb, indent, "model", s.Model, trailingComma: true);
        WriteString(sb, indent, "visibility",
            string.IsNullOrEmpty(s.Visibility) ? "both" : s.Visibility,
            trailingComma: hasPeople);
        if (hasPeople)
        {
            sb.Append(indent).Append("  \"people\": [\n");
            for (var i = 0; i < s.People.Count; i++)
            {
                AppendPerson(sb, s.People[i], indent + "    ");
                if (i < s.People.Count - 1)
                    sb.Append(',');
                sb.Append('\n');
            }
            sb.Append(indent).Append("  ]");
        }
        sb.Append('\n').Append(indent).Append('}');
    }

    static void AppendPerson(StringBuilder sb, PersonRecord p, string indent)
    {
        sb.Append(indent).Append("{\n");
        WriteString(sb, indent, "model", p.Model, trailingComma: true);
        WriteNumber(sb, indent, "lat", p.Lat, trailingComma: true);
        WriteNumber(sb, indent, "lon", p.Lon, trailingComma: true);
        WriteNumber(sb, indent, "height", p.Height, trailingComma: true);
        WriteNumber(sb, indent, "heading", p.Heading, trailingComma: true);
        WriteNumber(sb, indent, "scale", p.Scale > 0 ? p.Scale : 1, trailingComma: false);
        sb.Append('\n').Append(indent).Append('}');
    }

    static void WriteString(StringBuilder sb, string indent, string key, string value, bool trailingComma)
    {
        sb.Append(indent).Append("  \"").Append(key).Append("\": \"")
            .Append(Escape(value)).Append('"');
        if (trailingComma)
            sb.Append(',');
        sb.Append('\n');
    }

    static void WriteNumber(StringBuilder sb, string indent, string key, double value, bool trailingComma)
    {
        sb.Append(indent).Append("  \"").Append(key).Append("\": ")
            .Append(value.ToString("0.########", CultureInfo.InvariantCulture));
        if (trailingComma)
            sb.Append(',');
        sb.Append('\n');
    }

    static string Escape(string s)
    {
        if (string.IsNullOrEmpty(s))
            return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    static SpotRecord ParseObject(string obj)
    {
        return new SpotRecord
        {
            Id = GetString(obj, "id"),
            SheetName = GetString(obj, "sheetName"),
            Lat = GetNumber(obj, "lat"),
            Lon = GetNumber(obj, "lon"),
            Height = GetNumber(obj, "height"),
            HeightOffset = GetNumber(obj, "heightOffset"),
            Heading = GetNumber(obj, "heading"),
            Scale = GetNumber(obj, "scale", 1),
            Model = GetString(obj, "model"),
            Visibility = GetString(obj, "visibility"),
            // people はマージ時に既存を捨てて再書き出しするため、読込は不要
            People = null,
        };
    }

    static string GetString(string obj, string key)
    {
        var pattern = $"\"{key}\"";
        var idx = obj.IndexOf(pattern, StringComparison.Ordinal);
        if (idx < 0)
            return null;
        var colon = obj.IndexOf(':', idx + pattern.Length);
        if (colon < 0)
            return null;
        var i = colon + 1;
        SkipWs(obj, ref i);
        if (i >= obj.Length || obj[i] != '"')
            return null;
        i++;
        var sb = new StringBuilder();
        while (i < obj.Length)
        {
            var c = obj[i++];
            if (c == '\\' && i < obj.Length)
            {
                sb.Append(obj[i++]);
                continue;
            }
            if (c == '"')
                break;
            sb.Append(c);
        }
        return sb.ToString();
    }

    static double GetNumber(string obj, string key, double fallback = 0)
    {
        var pattern = $"\"{key}\"";
        var idx = obj.IndexOf(pattern, StringComparison.Ordinal);
        if (idx < 0)
            return fallback;
        var colon = obj.IndexOf(':', idx + pattern.Length);
        if (colon < 0)
            return fallback;
        var i = colon + 1;
        SkipWs(obj, ref i);
        var start = i;
        while (i < obj.Length)
        {
            var c = obj[i];
            if (char.IsDigit(c) || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
            {
                i++;
                continue;
            }
            break;
        }
        if (i == start)
            return fallback;
        var token = obj.Substring(start, i - start);
        return double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
            ? v
            : fallback;
    }

    static string ReadObject(string json, ref int i)
    {
        var start = i;
        var depth = 0;
        var inString = false;
        var escape = false;
        for (; i < json.Length; i++)
        {
            var c = json[i];
            if (inString)
            {
                if (escape)
                {
                    escape = false;
                    continue;
                }
                if (c == '\\')
                {
                    escape = true;
                    continue;
                }
                if (c == '"')
                    inString = false;
                continue;
            }

            if (c == '"')
            {
                inString = true;
                continue;
            }
            if (c == '{')
                depth++;
            else if (c == '}')
            {
                depth--;
                if (depth == 0)
                {
                    i++;
                    return json.Substring(start, i - start);
                }
            }
        }
        return json.Substring(start);
    }

    static void SkipWs(string s, ref int i)
    {
        while (i < s.Length && char.IsWhiteSpace(s[i]))
            i++;
    }
}
