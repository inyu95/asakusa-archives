using System.IO;
using UnityEditor;
using UnityEngine;

/// <summary>
/// DefaultImporter のまま残った GLB を glTFast で再インポートする。
/// </summary>
public static class ForceGltfReimport
{
    const string MenuPath = "Asakusa Time Travel/Reimport All GLB (glTFast)";

    [MenuItem(MenuPath)]
    public static void ReimportAllGlb()
    {
        var guids = AssetDatabase.FindAssets("t:DefaultAsset");
        var glbPaths = Directory.GetFiles(
            Application.dataPath,
            "*.glb",
            SearchOption.AllDirectories);

        var count = 0;
        foreach (var full in glbPaths)
        {
            var assetPath = "Assets" + full.Substring(Application.dataPath.Length).Replace('\\', '/');
            var metaPath = full + ".meta";
            if (File.Exists(metaPath))
            {
                var meta = File.ReadAllText(metaPath);
                if (meta.Contains("DefaultImporter:"))
                {
                    File.Delete(metaPath);
                    count++;
                }
            }
            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);
        }

        AssetDatabase.Refresh();
        EditorUtility.DisplayDialog(
            "Reimport All GLB",
            $"GLB を再インポートしました。\nDefaultImporter の meta 削除: {count} 件\n\n" +
            "Hierarchy の赤い人物は削除し、Project から GLB を再度ドラッグしてください。",
            "OK");
    }
}
