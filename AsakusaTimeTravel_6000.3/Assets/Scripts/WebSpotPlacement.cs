using UnityEngine;

/// <summary>
/// Web（spots.json）へ書き出すモデル配置マーカー。
/// 人物など、Unity で置いたオブジェクトに付けて Export する。
/// </summary>
public class WebSpotPlacement : MonoBehaviour
{
    [Tooltip("spots.json の id。空なら GameObject 名から生成")]
    public string spotId;

    [Tooltip("web/ からの相対パス（GLB 単位。人物パックは models/people-business-crowd.glb）")]
    public string model = "models/people-business-crowd.glb";

    [Tooltip("シートの name と照合する短縮名（任意）")]
    public string sheetName;

    [Tooltip("地形高からの追加オフセット（m）")]
    public float heightOffset;

    [Tooltip("scale を手動指定。0 以下なら Transform の lossyScale.x を使う")]
    public float scaleOverride;

    [Tooltip("both / map / ar など。空なら both")]
    public string visibility = "both";

    public string ResolvedId
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(spotId))
                return spotId.Trim();
            return SanitizeId(gameObject.name);
        }
    }

    public float ResolvedScale
    {
        get
        {
            if (scaleOverride > 0f)
                return scaleOverride;
            var s = transform.lossyScale.x;
            return s > 0f ? s : 1f;
        }
    }

    static string SanitizeId(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return "spot";
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
}
