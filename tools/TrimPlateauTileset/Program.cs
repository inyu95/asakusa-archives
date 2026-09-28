using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

// 浅草寺（Wikipedia: 北緯35.71472 東経139.796750）を中心に半径 1 km
const double DefaultCenterLonDeg = 139.796750;
const double DefaultCenterLatDeg = 35.71472;
const double DefaultRadiusMeters = 1000.0;
const int DefaultZoom = 17;
const double EarthRadiusMeters = 6_371_000.0;

if (args.Length < 2)
{
    Console.Error.WriteLine(
        "Usage: TrimPlateauTileset <sourceTilesetUrl> <output.json> [lon] [lat] [radiusMeters] [zoom]"
    );
    Console.Error.WriteLine(
        $"  Defaults: Senso-ji circle lon={DefaultCenterLonDeg} lat={DefaultCenterLatDeg} radius={DefaultRadiusMeters}m zoom={DefaultZoom}"
    );
    Console.Error.WriteLine(
        "  zoom >= 0: collect content tiles whose URI path contains that zoom and intersects the circle."
    );
    Console.Error.WriteLine(
        "  zoom = -1: collect content leaves (no children) that intersect the circle"
    );
    Console.Error.WriteLine(
        "                (for flat data/*.b3dm tilesets such as brid / some wards)."
    );
    Console.Error.WriteLine(
        "  Writes a flat root→leaves tileset (no REPLACE hierarchy, no parent fallbacks)."
    );
    return 1;
}

var srcUrl = args[0];
var outPath = args[1];
double Deg(double d) => d * Math.PI / 180.0;
double Rad(double r) => r * 180.0 / Math.PI;

var centerLonDeg = args.Length > 2
    ? double.Parse(args[2], CultureInfo.InvariantCulture)
    : DefaultCenterLonDeg;
var centerLatDeg = args.Length > 3
    ? double.Parse(args[3], CultureInfo.InvariantCulture)
    : DefaultCenterLatDeg;
var radiusMeters = args.Length > 4
    ? double.Parse(args[4], CultureInfo.InvariantCulture)
    : DefaultRadiusMeters;
var targetZoom = args.Length > 5
    ? int.Parse(args[5], CultureInfo.InvariantCulture)
    : DefaultZoom;

var centerLon = Deg(centerLonDeg);
var centerLat = Deg(centerLatDeg);

var baseUrl = srcUrl.Contains('/') ? srcUrl[..(srcUrl.LastIndexOf('/') + 1)] : "";
var zoomInPath = new Regex(@"(?:^|/)(?<z>\d{1,2})/\d+/[^/]*$", RegexOptions.Compiled);

Console.WriteLine($"Downloading {srcUrl}...");
using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(2) };
var raw = await http.GetStringAsync(srcUrl);
Console.WriteLine($"Source: {Encoding.UTF8.GetByteCount(raw):N0} bytes");
Console.WriteLine(
    $"Circle: lon={centerLonDeg.ToString(CultureInfo.InvariantCulture)} lat={centerLatDeg.ToString(CultureInfo.InvariantCulture)} r={radiusMeters.ToString(CultureInfo.InvariantCulture)}m z={targetZoom}"
);

var rootDoc = JsonNode.Parse(raw)!.AsObject();
var root = rootDoc["root"]!.AsObject();

/// <summary>矩形 region（ラジアン）が円と交差するか（最近傍点までの距離）。</summary>
bool IntersectsCircle(JsonNode? regionNode)
{
    if (regionNode is not JsonArray region || region.Count < 4) return true;
    var rw = region[0]!.GetValue<double>();
    var rs = region[1]!.GetValue<double>();
    var re = region[2]!.GetValue<double>();
    var rn = region[3]!.GetValue<double>();

    var closestLon = Math.Clamp(centerLon, rw, re);
    var closestLat = Math.Clamp(centerLat, rs, rn);
    return HaversineMeters(centerLon, centerLat, closestLon, closestLat) <= radiusMeters;
}

static double HaversineMeters(double lon1, double lat1, double lon2, double lat2)
{
    var dLat = lat2 - lat1;
    var dLon = lon2 - lon1;
    var a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2)
        + Math.Cos(lat1) * Math.Cos(lat2) * Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
    return 2 * EarthRadiusMeters * Math.Asin(Math.Min(1.0, Math.Sqrt(a)));
}

int? ZoomOf(string? uri)
{
    if (string.IsNullOrEmpty(uri)) return null;
    var m = zoomInPath.Match(uri);
    if (!m.Success) return null;
    return int.Parse(m.Groups["z"].Value, CultureInfo.InvariantCulture);
}

string Absolutize(string uri)
{
    if (string.IsNullOrEmpty(uri)
        || uri.StartsWith("http://", StringComparison.Ordinal)
        || uri.StartsWith("https://", StringComparison.Ordinal)
        || uri.StartsWith("data:", StringComparison.Ordinal))
    {
        return uri;
    }
    return baseUrl + uri.TrimStart('.', '/');
}

var leaves = new List<JsonObject>();
var seenUri = new HashSet<string>(StringComparer.Ordinal);
var leafMode = targetZoom < 0;

void AddLeaf(JsonObject node, string uri)
{
    var abs = Absolutize(uri);
    if (!seenUri.Add(abs)) return;
    var leaf = JsonNode.Parse(node.ToJsonString())!.AsObject();
    leaf.Remove("children");
    if (leaf["content"] is JsonObject content)
    {
        content["uri"] = abs;
    }
    leaf["geometricError"] = JsonValue.Create(0.0);
    leaf["refine"] = "REPLACE";
    leaves.Add(leaf);
}

void Collect(JsonObject node)
{
    var uri = node["content"]?["uri"]?.GetValue<string>();
    var children = node["children"] as JsonArray;
    var hasChildren = children is { Count: > 0 };

    if (uri != null && IntersectsCircle(node["boundingVolume"]?["region"]))
    {
        if (leafMode)
        {
            // 平坦 data/*.b3dm 系: 子が無い content ノードだけ採用
            if (!hasChildren) AddLeaf(node, uri);
        }
        else if (ZoomOf(uri) == targetZoom)
        {
            AddLeaf(node, uri);
        }
    }

    if (!hasChildren || children is null) return;
    foreach (var child in children)
    {
        if (child is JsonObject childObj) Collect(childObj);
    }
}

Console.WriteLine(
    leafMode
        ? "Collecting content leaves intersecting circle..."
        : $"Collecting z{targetZoom} tiles intersecting circle..."
);
Collect(root);
if (leaves.Count == 0)
{
    Console.Error.WriteLine(
        leafMode
            ? "No content leaves intersect the circle."
            : $"No z{targetZoom} tiles intersect the circle."
    );
    return 1;
}

// 境界ボリュームを少し広げる（浅い俯角での水平線カリング／フラスタム漏れ防止）
const double PadRadians = 40.0 / EarthRadiusMeters; // ≈ 40 m
const double PadHeightDown = 80.0;
const double PadHeightUp = 200.0;

void PadRegion(JsonArray region)
{
    region[0] = JsonValue.Create(region[0]!.GetValue<double>() - PadRadians);
    region[1] = JsonValue.Create(region[1]!.GetValue<double>() - PadRadians);
    region[2] = JsonValue.Create(region[2]!.GetValue<double>() + PadRadians);
    region[3] = JsonValue.Create(region[3]!.GetValue<double>() + PadRadians);
    region[4] = JsonValue.Create(region[4]!.GetValue<double>() - PadHeightDown);
    region[5] = JsonValue.Create(region[5]!.GetValue<double>() + PadHeightUp);
}

double minW = double.PositiveInfinity, minS = double.PositiveInfinity;
double maxE = double.NegativeInfinity, maxN = double.NegativeInfinity;
double minH = double.PositiveInfinity, maxH = double.NegativeInfinity;
foreach (var leaf in leaves)
{
    if (leaf["boundingVolume"]?["region"] is not JsonArray leafRegion || leafRegion.Count < 6)
    {
        continue;
    }
    PadRegion(leafRegion);
    minW = Math.Min(minW, leafRegion[0]!.GetValue<double>());
    minS = Math.Min(minS, leafRegion[1]!.GetValue<double>());
    maxE = Math.Max(maxE, leafRegion[2]!.GetValue<double>());
    maxN = Math.Max(maxN, leafRegion[3]!.GetValue<double>());
    minH = Math.Min(minH, leafRegion[4]!.GetValue<double>());
    maxH = Math.Max(maxH, leafRegion[5]!.GetValue<double>());
}

var unionRegion = new JsonArray();
unionRegion.Add(JsonValue.Create(minW));
unionRegion.Add(JsonValue.Create(minS));
unionRegion.Add(JsonValue.Create(maxE));
unionRegion.Add(JsonValue.Create(maxN));
unionRegion.Add(JsonValue.Create(minH));
unionRegion.Add(JsonValue.Create(maxH));

var children = new JsonArray();
foreach (var leaf in leaves) children.Add(leaf);

// ルートに content が無い平坦 tileset では geometricError を大きくする。
// 小さいと SSE 判定で子へ精緻化されず、アングルによっては建物が消える。
const double RootGeometricError = 1e7;

var flatRoot = new JsonObject
{
    ["boundingVolume"] = new JsonObject { ["region"] = unionRegion },
    ["geometricError"] = JsonValue.Create(RootGeometricError),
    ["refine"] = "ADD",
    ["children"] = children,
};

var output = new JsonObject
{
    ["asset"] = rootDoc["asset"]?.DeepClone() ?? new JsonObject { ["version"] = "1.1" },
    ["geometricError"] = JsonValue.Create(RootGeometricError),
    ["root"] = flatRoot,
};

Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
var json = output.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
await File.WriteAllTextAsync(outPath, json, new UTF8Encoding(false));

Console.WriteLine(
    $"Wrote {new FileInfo(outPath).Length:N0} bytes, mode={(leafMode ? "leaf" : $"z{targetZoom}")} leaves={leaves.Count}"
);
Console.WriteLine(
    $"Union deg W/S/E/N: {Rad(minW):F6} {Rad(minS):F6} {Rad(maxE):F6} {Rad(maxN):F6}"
);
Console.WriteLine(outPath);
return 0;
