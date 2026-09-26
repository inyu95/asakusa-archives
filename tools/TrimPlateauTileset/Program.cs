using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

if (args.Length < 2)
{
    Console.Error.WriteLine(
        "Usage: TrimPlateauTileset <sourceTilesetUrl> <output.json> [west] [south] [east] [north] [zoom]"
    );
    Console.Error.WriteLine(
        "  Degrees W/S/E/N default to Asakusa padded bounds: 139.787 35.707 139.804 35.723"
    );
    Console.Error.WriteLine(
        "  zoom defaults to 17. Collects ALL content tiles at that zoom that intersect the box,"
    );
    Console.Error.WriteLine(
        "  then writes a flat root→leaves tileset (no REPLACE hierarchy, no parent fallbacks)."
    );
    return 1;
}

var srcUrl = args[0];
var outPath = args[1];
double Deg(double d) => d * Math.PI / 180.0;
var west = Deg(args.Length > 2 ? double.Parse(args[2], CultureInfo.InvariantCulture) : 139.787);
var south = Deg(args.Length > 3 ? double.Parse(args[3], CultureInfo.InvariantCulture) : 35.707);
var east = Deg(args.Length > 4 ? double.Parse(args[4], CultureInfo.InvariantCulture) : 139.804);
var north = Deg(args.Length > 5 ? double.Parse(args[5], CultureInfo.InvariantCulture) : 35.723);
var targetZoom = args.Length > 6 ? int.Parse(args[6], CultureInfo.InvariantCulture) : 17;

var baseUrl = srcUrl.Contains('/') ? srcUrl[..(srcUrl.LastIndexOf('/') + 1)] : "";
var zoomInPath = new Regex(@"(?:^|/)(?<z>\d{1,2})/\d+/[^/]*$", RegexOptions.Compiled);

Console.WriteLine($"Downloading {srcUrl}...");
using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(2) };
var raw = await http.GetStringAsync(srcUrl);
Console.WriteLine($"Source: {Encoding.UTF8.GetByteCount(raw):N0} bytes");

var rootDoc = JsonNode.Parse(raw)!.AsObject();
var root = rootDoc["root"]!.AsObject();

bool Intersects(JsonNode? regionNode)
{
    if (regionNode is not JsonArray region || region.Count < 4) return true;
    var rw = region[0]!.GetValue<double>();
    var rs = region[1]!.GetValue<double>();
    var re = region[2]!.GetValue<double>();
    var rn = region[3]!.GetValue<double>();
    return !(re < west || rw > east || rn < south || rs > north);
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

void Collect(JsonObject node)
{
    var uri = node["content"]?["uri"]?.GetValue<string>();
    var zoom = ZoomOf(uri);
    if (zoom == targetZoom
        && uri != null
        && Intersects(node["boundingVolume"]?["region"]))
    {
        var abs = Absolutize(uri);
        if (seenUri.Add(abs))
        {
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
    }

    if (node["children"] is not JsonArray children) return;
    foreach (var child in children)
    {
        if (child is JsonObject childObj) Collect(childObj);
    }
}

Console.WriteLine($"Collecting z{targetZoom} tiles intersecting bounds...");
Collect(root);
if (leaves.Count == 0)
{
    Console.Error.WriteLine($"No z{targetZoom} tiles intersect the bounds.");
    return 1;
}

// 境界ボリュームを少し広げる（浅い俯角での水平線カリング／フラスタム漏れ防止）
const double PadRadians = 40.0 / 6_371_000.0; // ≈ 40 m
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

Console.WriteLine($"Wrote {new FileInfo(outPath).Length:N0} bytes, z{targetZoom} leaves={leaves.Count}");
Console.WriteLine(outPath);
return 0;
