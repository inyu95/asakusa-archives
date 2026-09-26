using System.Net;

var root = Path.GetFullPath(args.Length > 0 ? args[0] : "web");
var port = args.Length > 1 && int.TryParse(args[1], out var p) ? p : 5173;

if (!Directory.Exists(root))
{
    Console.Error.WriteLine($"Directory not found: {root}");
    return 1;
}

var listener = new HttpListener();
listener.Prefixes.Add($"http://127.0.0.1:{port}/");
listener.Start();
Console.WriteLine($"Serving {root}");
Console.WriteLine($"http://127.0.0.1:{port}/");

while (true)
{
    var ctx = await listener.GetContextAsync();
    _ = Task.Run(() => Handle(ctx, root));
}

static void Handle(HttpListenerContext ctx, string root)
{
    try
    {
        var path = Uri.UnescapeDataString(ctx.Request.Url!.AbsolutePath.TrimStart('/'));
        if (string.IsNullOrEmpty(path) || path.EndsWith('/')) path += "index.html";
        var full = Path.GetFullPath(Path.Combine(root, path));
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
        {
            ctx.Response.StatusCode = 404;
            using var w = new StreamWriter(ctx.Response.OutputStream);
            w.Write("Not Found");
            return;
        }

        var ext = Path.GetExtension(full).ToLowerInvariant();
        ctx.Response.ContentType = ext switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".glb" => "model/gltf-binary",
            ".gltf" => "model/gltf+json",
            ".obj" => "text/plain",
            ".mtl" => "text/plain",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            _ => "application/octet-stream",
        };
        ctx.Response.AddHeader("Access-Control-Allow-Origin", "*");
        var bytes = File.ReadAllBytes(full);
        ctx.Response.ContentLength64 = bytes.Length;
        if (ctx.Request.HttpMethod != "HEAD")
        {
            ctx.Response.OutputStream.Write(bytes);
        }
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine(ex.Message);
        try { ctx.Response.StatusCode = 500; } catch { /* ignore */ }
    }
    finally
    {
        try { ctx.Response.OutputStream.Close(); } catch { /* ignore */ }
    }
}
