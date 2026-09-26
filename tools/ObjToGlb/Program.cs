using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;

if (args.Length < 2)
{
    Console.Error.WriteLine("Usage: ObjToGlb <input.obj> <output.glb>");
    return 1;
}

var inputPath = args[0];
var outputPath = args[1];

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

Console.WriteLine($"Vertices: {positions.Count:N0}, Triangles: {indices.Count / 3:N0}");
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

var positionByteLength = positions.Count * 12;
var normalByteLength = positions.Count * 12;
var indexByteLength = indices.Count * 4;
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
foreach (var idx in indices)
{
    BinaryPrimitives.WriteUInt32LittleEndian(bin.AsSpan(offset), idx); offset += 4;
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
            ["doubleSided"] = true,
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
            ["componentType"] = 5125,
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

Console.WriteLine($"Writing {outputPath} ({totalLength / (1024.0 * 1024.0):F1} MB)...");

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
