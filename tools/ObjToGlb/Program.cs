using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;

if (args.Length < 2)
{
    Console.Error.WriteLine("Usage: ObjToGlb <input.obj> <output.glb> [cellSizeMeters]");
    Console.Error.WriteLine("  cellSizeMeters  Vertex clustering size (default 0.18). Larger = lighter.");
    return 1;
}

var inputPath = args[0];
var outputPath = args[1];
var cellSize = args.Length >= 3
    ? float.Parse(args[2], CultureInfo.InvariantCulture)
    : 0.18f;

Console.WriteLine($"Reading {inputPath}...");

var positions = new List<(float X, float Y, float Z)>(500_000);
var indices = new List<uint>(2_500_000);

using (var reader = new StreamReader(inputPath, Encoding.UTF8, detectEncodingFromByteOrderMarks: true))
{
    string? line;
    while ((line = reader.ReadLine()) is not null)
    {
        if (line.Length < 2) continue;

        if (line[0] == 'v' && line[1] == ' ')
        {
            var parts = line.AsSpan(2).Trim();
            var x = ParseFloat(ref parts);
            var y = ParseFloat(ref parts);
            var z = ParseFloat(ref parts);
            positions.Add((x, y, z));
        }
        else if (line[0] == 'f' && line[1] == ' ')
        {
            var tokens = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (tokens.Length < 4) continue;

            var face = new List<uint>(tokens.Length - 1);
            for (var i = 1; i < tokens.Length; i++)
            {
                var token = tokens[i];
                var slash = token.IndexOf('/');
                var indexText = slash >= 0 ? token.AsSpan(0, slash) : token.AsSpan();
                if (!int.TryParse(indexText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var idx))
                {
                    continue;
                }

                if (idx < 0) idx = positions.Count + idx + 1;
                face.Add((uint)(idx - 1));
            }

            for (var i = 1; i + 1 < face.Count; i++)
            {
                indices.Add(face[0]);
                indices.Add(face[i]);
                indices.Add(face[i + 1]);
            }
        }
    }
}

if (positions.Count == 0 || indices.Count == 0)
{
    Console.Error.WriteLine("No mesh data found.");
    return 1;
}

Console.WriteLine($"Raw vertices: {positions.Count:N0}, triangles: {indices.Count / 3:N0}");

if (cellSize > 0)
{
    Console.WriteLine($"Simplifying with cell size {cellSize:F3} m...");
    (positions, indices) = ClusterSimplify(positions, indices, cellSize);
    Console.WriteLine($"Simplified vertices: {positions.Count:N0}, triangles: {indices.Count / 3:N0}");
}

Console.WriteLine("Computing normals...");

var normals = new (float X, float Y, float Z)[positions.Count];
for (var i = 0; i < indices.Count; i += 3)
{
    var i0 = indices[i];
    var i1 = indices[i + 1];
    var i2 = indices[i + 2];
    var p0 = positions[(int)i0];
    var p1 = positions[(int)i1];
    var p2 = positions[(int)i2];

    var ux = p1.X - p0.X;
    var uy = p1.Y - p0.Y;
    var uz = p1.Z - p0.Z;
    var vx = p2.X - p0.X;
    var vy = p2.Y - p0.Y;
    var vz = p2.Z - p0.Z;

    var nx = uy * vz - uz * vy;
    var ny = uz * vx - ux * vz;
    var nz = ux * vy - uy * vx;

    Accumulate(ref normals[i0], nx, ny, nz);
    Accumulate(ref normals[i1], nx, ny, nz);
    Accumulate(ref normals[i2], nx, ny, nz);
}

for (var i = 0; i < normals.Length; i++)
{
    Normalize(ref normals[i]);
}

float minX = float.MaxValue, minY = float.MaxValue, minZ = float.MaxValue;
float maxX = float.MinValue, maxY = float.MinValue, maxZ = float.MinValue;
foreach (var p in positions)
{
    if (p.X < minX) minX = p.X;
    if (p.Y < minY) minY = p.Y;
    if (p.Z < minZ) minZ = p.Z;
    if (p.X > maxX) maxX = p.X;
    if (p.Y > maxY) maxY = p.Y;
    if (p.Z > maxZ) maxZ = p.Z;
}

var useUint16 = positions.Count <= 65535;
var indexStride = useUint16 ? 2 : 4;
var positionByteLength = positions.Count * 12;
var normalByteLength = positions.Count * 12;
var indexByteLength = indices.Count * indexStride;
var bufferByteLength = Align4(positionByteLength) + Align4(normalByteLength) + Align4(indexByteLength);

var bin = new byte[bufferByteLength];
var offset = 0;
foreach (var p in positions)
{
    BinaryPrimitives.WriteSingleLittleEndian(bin.AsSpan(offset), p.X); offset += 4;
    BinaryPrimitives.WriteSingleLittleEndian(bin.AsSpan(offset), p.Y); offset += 4;
    BinaryPrimitives.WriteSingleLittleEndian(bin.AsSpan(offset), p.Z); offset += 4;
}
offset = Align4(offset);
var normalOffset = offset;
foreach (var n in normals)
{
    BinaryPrimitives.WriteSingleLittleEndian(bin.AsSpan(offset), n.X); offset += 4;
    BinaryPrimitives.WriteSingleLittleEndian(bin.AsSpan(offset), n.Y); offset += 4;
    BinaryPrimitives.WriteSingleLittleEndian(bin.AsSpan(offset), n.Z); offset += 4;
}
offset = Align4(offset);
var indexOffset = offset;
if (useUint16)
{
    foreach (var idx in indices)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(bin.AsSpan(offset), (ushort)idx);
        offset += 2;
    }
}
else
{
    foreach (var idx in indices)
    {
        BinaryPrimitives.WriteUInt32LittleEndian(bin.AsSpan(offset), idx);
        offset += 4;
    }
}

var gltf = new Dictionary<string, object?>
{
    ["asset"] = new Dictionary<string, object?> { ["version"] = "2.0", ["generator"] = "asakusa-archives ObjToGlb" },
    ["scene"] = 0,
    ["scenes"] = new object[] { new Dictionary<string, object?> { ["nodes"] = new[] { 0 } } },
    ["nodes"] = new object[] { new Dictionary<string, object?> { ["mesh"] = 0 } },
    ["meshes"] = new object[]
    {
        new Dictionary<string, object?>
        {
            ["primitives"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["attributes"] = new Dictionary<string, object?>
                    {
                        ["POSITION"] = 0,
                        ["NORMAL"] = 1,
                    },
                    ["indices"] = 2,
                    ["mode"] = 4,
                    ["material"] = 0,
                }
            }
        }
    },
    ["materials"] = new object[]
    {
        new Dictionary<string, object?>
        {
            ["name"] = "Default",
            ["pbrMetallicRoughness"] = new Dictionary<string, object?>
            {
                ["baseColorFactor"] = new[] { 0.74, 0.74, 0.74, 1.0 },
                ["metallicFactor"] = 0.0,
                ["roughnessFactor"] = 0.85,
            },
            // 閉じた立体なので片面描画でフラグメント負荷を半減
            ["doubleSided"] = false,
        }
    },
    ["accessors"] = new object[]
    {
        new Dictionary<string, object?>
        {
            ["bufferView"] = 0,
            ["componentType"] = 5126,
            ["count"] = positions.Count,
            ["type"] = "VEC3",
            ["max"] = new[] { maxX, maxY, maxZ },
            ["min"] = new[] { minX, minY, minZ },
        },
        new Dictionary<string, object?>
        {
            ["bufferView"] = 1,
            ["componentType"] = 5126,
            ["count"] = positions.Count,
            ["type"] = "VEC3",
        },
        new Dictionary<string, object?>
        {
            ["bufferView"] = 2,
            ["componentType"] = useUint16 ? 5123 : 5125,
            ["count"] = indices.Count,
            ["type"] = "SCALAR",
        },
    },
    ["bufferViews"] = new object[]
    {
        new Dictionary<string, object?> { ["buffer"] = 0, ["byteOffset"] = 0, ["byteLength"] = positionByteLength, ["target"] = 34962 },
        new Dictionary<string, object?> { ["buffer"] = 0, ["byteOffset"] = normalOffset, ["byteLength"] = normalByteLength, ["target"] = 34962 },
        new Dictionary<string, object?> { ["buffer"] = 0, ["byteOffset"] = indexOffset, ["byteLength"] = indexByteLength, ["target"] = 34963 },
    },
    ["buffers"] = new object[]
    {
        new Dictionary<string, object?> { ["byteLength"] = bufferByteLength }
    },
};

var jsonBytes = JsonSerializer.SerializeToUtf8Bytes(gltf);
var jsonPadding = (4 - (jsonBytes.Length % 4)) % 4;
var jsonChunkLength = jsonBytes.Length + jsonPadding;
var binPadding = (4 - (bin.Length % 4)) % 4;
var binChunkLength = bin.Length + binPadding;
var totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength;

Console.WriteLine($"Writing {outputPath} ({totalLength / (1024.0 * 1024.0):F2} MB)...");

Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
using (var fs = File.Create(outputPath))
using (var bw = new BinaryWriter(fs))
{
    bw.Write(0x46546C67); // glTF
    bw.Write(2);
    bw.Write(totalLength);

    bw.Write(jsonChunkLength);
    bw.Write(0x4E4F534A); // JSON
    bw.Write(jsonBytes);
    for (var i = 0; i < jsonPadding; i++) bw.Write((byte)0x20);

    bw.Write(binChunkLength);
    bw.Write(0x004E4942); // BIN\0
    bw.Write(bin);
    for (var i = 0; i < binPadding; i++) bw.Write((byte)0x00);
}

Console.WriteLine("Done.");
Console.WriteLine($"Bounds Y: {minY:F2} .. {maxY:F2} (height ~{maxY - minY:F2} m)");
return 0;

/// <summary>
/// 頂点クラスタリングでメッシュを軽量化する。
/// 同じ格子セル内の頂点を平均位置にマージし、縮退三角形を捨てる。
/// </summary>
static (List<(float X, float Y, float Z)> Positions, List<uint> Indices) ClusterSimplify(
    List<(float X, float Y, float Z)> positions,
    List<uint> indices,
    float cellSize)
{
    var inv = 1f / cellSize;
    var cellMap = new Dictionary<(int X, int Y, int Z), int>(positions.Count / 4);
    var sums = new List<(float X, float Y, float Z, int Count)>(positions.Count / 4);
    var remap = new int[positions.Count];

    for (var i = 0; i < positions.Count; i++)
    {
        var p = positions[i];
        var key = (
            (int)MathF.Floor(p.X * inv),
            (int)MathF.Floor(p.Y * inv),
            (int)MathF.Floor(p.Z * inv)
        );

        if (!cellMap.TryGetValue(key, out var cluster))
        {
            cluster = sums.Count;
            cellMap[key] = cluster;
            sums.Add((p.X, p.Y, p.Z, 1));
        }
        else
        {
            var s = sums[cluster];
            sums[cluster] = (s.X + p.X, s.Y + p.Y, s.Z + p.Z, s.Count + 1);
        }

        remap[i] = cluster;
    }

    var newPositions = new List<(float X, float Y, float Z)>(sums.Count);
    foreach (var s in sums)
    {
        var invCount = 1f / s.Count;
        newPositions.Add((s.X * invCount, s.Y * invCount, s.Z * invCount));
    }

    var newIndices = new List<uint>(indices.Count);
    var seen = new HashSet<(uint, uint, uint)>(indices.Count / 3);

    for (var i = 0; i < indices.Count; i += 3)
    {
        var a = (uint)remap[indices[i]];
        var b = (uint)remap[indices[i + 1]];
        var c = (uint)remap[indices[i + 2]];
        if (a == b || b == c || c == a) continue;

        // 向きを正規化して重複面を落とす
        uint x = a, y = b, z = c;
        if (y < x) (x, y) = (y, x);
        if (z < x) (x, z) = (z, x);
        if (z < y) (y, z) = (z, y);
        if (!seen.Add((x, y, z))) continue;

        newIndices.Add(a);
        newIndices.Add(b);
        newIndices.Add(c);
    }

    return (newPositions, newIndices);
}

static float ParseFloat(ref ReadOnlySpan<char> span)
{
    span = span.TrimStart();
    var end = 0;
    while (end < span.Length && !char.IsWhiteSpace(span[end])) end++;
    var value = float.Parse(span[..end], CultureInfo.InvariantCulture);
    span = span[end..];
    return value;
}

static void Accumulate(ref (float X, float Y, float Z) n, float x, float y, float z)
{
    n.X += x;
    n.Y += y;
    n.Z += z;
}

static void Normalize(ref (float X, float Y, float Z) n)
{
    var len = MathF.Sqrt(n.X * n.X + n.Y * n.Y + n.Z * n.Z);
    if (len < 1e-8f)
    {
        n = (0, 1, 0);
        return;
    }
    n.X /= len;
    n.Y /= len;
    n.Z /= len;
}

static int Align4(int value) => (value + 3) & ~3;

