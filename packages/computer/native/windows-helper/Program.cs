// Mountains' read-only Windows helper: lists windows (with the app hosted inside a UWP frame), reports one window's
// owner and geometry, captures one window's own pixels, reports process start times, and reports which window is in
// front and when the user last used the keyboard or mouse. Control trees and every action come from xa11y. It never
// activates, moves or sends input to anything.
// Protocol: one JSON object per line on stdin ({ "id": n, "op": ... }), one JSON reply per line on stdout
// ({ "id": n, "ok": true, ... } or { "id": n, "ok": false, "error": "..." }).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Mountains
{
    static class Native
    {
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("d3d11.dll")] public static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint levelCount, uint sdkVersion, out IntPtr device, out int level, out IntPtr context);
        [DllImport("d3d11.dll")] public static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
        public const uint GW_OWNER = 4, PW_RENDERFULLCONTENT = 2;
    }

    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
        IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
    }

    static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };

        [MTAThread]
        static int Main()
        {
            // Physical pixels everywhere; the adapter scales them to the coordinates xa11y reports.
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                object id = null;
                Dictionary<string, object> reply;
                try
                {
                    var request = Json.Deserialize<Dictionary<string, object>>(line);
                    request.TryGetValue("id", out id);
                    reply = Handle(request);
                    reply["ok"] = true;
                }
                catch (Exception error)
                {
                    reply = new Dictionary<string, object> { ["ok"] = false, ["error"] = Describe(error) };
                }
                reply["id"] = id;
                stdout.WriteLine(Json.Serialize(reply));
            }
            return 0;
        }

        static string Describe(Exception error)
        {
            var e = error is AggregateException aggregate && aggregate.InnerException != null ? aggregate.InnerException : error;
            return e.GetType().Name + ": " + e.Message;
        }

        static Dictionary<string, object> Handle(Dictionary<string, object> request)
        {
            var op = request.TryGetValue("op", out var o) ? o as string : null;
            switch (op)
            {
                case "ping": return new Dictionary<string, object> { ["pid"] = Process.GetCurrentProcess().Id };
                case "windows": return new Dictionary<string, object> { ["windows"] = Windows() };
                case "process": return ProcessInfo(Int(request, "pid"));
                case "processes": return Processes(request);
                case "window": return WindowInfo(Hwnd(request));
                case "capture": return Capture(Hwnd(request), Str(request, "file"));
                case "foreground": return Foreground();
                case "last_input": return LastInput();
                default: throw new ArgumentException("unknown op " + (op ?? "(none)"));
            }
        }

        static int Int(Dictionary<string, object> r, string key, int? fallback = null)
        {
            if (r.TryGetValue(key, out var v) && v != null) return Convert.ToInt32(v);
            if (fallback.HasValue) return fallback.Value;
            throw new ArgumentException("missing " + key);
        }
        static string Str(Dictionary<string, object> r, string key)
        {
            if (r.TryGetValue(key, out var v) && v is string s && s.Length > 0) return s;
            throw new ArgumentException("missing " + key);
        }
        static IntPtr Hwnd(Dictionary<string, object> r)
        {
            var h = new IntPtr(Convert.ToInt64(r.TryGetValue("hwnd", out var v) ? v : throw new ArgumentException("missing hwnd")));
            if (!Native.IsWindow(h)) throw new InvalidOperationException("the window is gone");
            return h;
        }
        static Dictionary<string, object> Rect(Native.RECT r) => new Dictionary<string, object> { ["x"] = r.Left, ["y"] = r.Top, ["width"] = r.Right - r.Left, ["height"] = r.Bottom - r.Top };
        static string Text(IntPtr hwnd, bool cls)
        {
            var b = new StringBuilder(512);
            if (cls) Native.GetClassName(hwnd, b, b.Capacity); else Native.GetWindowText(hwnd, b, b.Capacity);
            return b.ToString();
        }

        // Visible, unowned top-level windows in z-order (front first). A UWP frame (ApplicationFrameWindow) also
        // names the CoreWindow it hosts and that window's process, which is the app the user sees.
        static List<object> Windows()
        {
            var list = new List<object>();
            Native.EnumWindows((hwnd, _) =>
            {
                if (!Native.IsWindowVisible(hwnd) || Native.GetWindow(hwnd, Native.GW_OWNER) != IntPtr.Zero) return true;
                var title = Text(hwnd, false);
                if (title.Length == 0) return true;
                Native.GetWindowThreadProcessId(hwnd, out var pid);
                Native.GetWindowRect(hwnd, out var rect);
                Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_CLOAKED, out int cloaked, 4);
                var cls = Text(hwnd, true);
                var w = new Dictionary<string, object> { ["hwnd"] = hwnd.ToInt64(), ["pid"] = pid, ["title"] = title, ["class"] = cls, ["bounds"] = Rect(rect), ["minimized"] = Native.IsIconic(hwnd), ["cloaked"] = cloaked != 0 };
                if (cls == "ApplicationFrameWindow")
                {
                    var core = Native.FindWindowEx(hwnd, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
                    if (core != IntPtr.Zero)
                    {
                        Native.GetWindowThreadProcessId(core, out var hostedPid);
                        w["hostedPid"] = hostedPid;
                        try { w["hostedProcess"] = Process.GetProcessById(hostedPid).ProcessName; } catch { }
                    }
                }
                list.Add(w);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        // One window's owner and geometry, read again before every use of a window number.
        static Dictionary<string, object> WindowInfo(IntPtr hwnd)
        {
            Native.GetWindowThreadProcessId(hwnd, out var pid);
            Native.GetWindowRect(hwnd, out var rect);
            Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_CLOAKED, out int cloaked, 4);
            return new Dictionary<string, object> { ["hwnd"] = hwnd.ToInt64(), ["pid"] = pid, ["title"] = Text(hwnd, false), ["class"] = Text(hwnd, true), ["bounds"] = Rect(rect), ["frame"] = Rect(FrameBounds(hwnd)), ["visible"] = Native.IsWindowVisible(hwnd), ["minimized"] = Native.IsIconic(hwnd), ["cloaked"] = cloaked != 0 };
        }

        // The window the user is working in right now (0 when none is in front, such as on the lock screen). It only
        // reads: nothing is activated.
        static Dictionary<string, object> Foreground()
        {
            var hwnd = Native.GetForegroundWindow();
            var pid = 0;
            if (hwnd != IntPtr.Zero) Native.GetWindowThreadProcessId(hwnd, out pid);
            return new Dictionary<string, object> { ["hwnd"] = hwnd.ToInt64(), ["pid"] = pid };
        }

        // When the user last pressed a key or moved the mouse, as the 32-bit millisecond tick Windows keeps (it wraps
        // after about 49 days, so callers compare ticks for equality and never subtract them). "now" is the same clock.
        static Dictionary<string, object> LastInput()
        {
            var info = new Native.LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(Native.LASTINPUTINFO)) };
            if (!Native.GetLastInputInfo(ref info)) throw new InvalidOperationException("GetLastInputInfo failed");
            return new Dictionary<string, object> { ["tick"] = (long)info.dwTime, ["now"] = (long)unchecked((uint)Environment.TickCount) };
        }

        // Start times of many processes at once; a process that is gone or not readable is left out.
        static Dictionary<string, object> Processes(Dictionary<string, object> request)
        {
            var found = new Dictionary<string, object>();
            if (request.TryGetValue("pids", out var list) && list is System.Collections.ArrayList pids)
                foreach (var value in pids)
                {
                    var pid = Convert.ToInt32(value);
                    try { found[pid.ToString(System.Globalization.CultureInfo.InvariantCulture)] = ProcessInfo(pid); } catch { }
                }
            return new Dictionary<string, object> { ["processes"] = found };
        }

        static Dictionary<string, object> ProcessInfo(int pid)
        {
            using (var p = Process.GetProcessById(pid))
            {
                var r = new Dictionary<string, object> { ["pid"] = pid, ["name"] = p.ProcessName, ["start"] = p.StartTime.ToUniversalTime().ToString("o") };
                try { r["path"] = p.MainModule.FileName; } catch { }
                return r;
            }
        }

        // ---- one window's own pixels: Windows.Graphics.Capture first, PrintWindow when it is unavailable ----
        static Dictionary<string, object> Capture(IntPtr hwnd, string file)
        {
            if (Native.IsIconic(hwnd)) throw new InvalidOperationException("the window is minimized");
            string wgcError = null;
            try
            {
                var area = FrameBounds(hwnd);
                var size = CaptureWithGraphicsCapture(hwnd, file);
                Native.GetWindowRect(hwnd, out var whole);
                return new Dictionary<string, object> { ["method"] = "graphics-capture", ["width"] = size.Width, ["height"] = size.Height, ["area"] = Rect(area), ["windowRect"] = Rect(whole) };
            }
            catch (Exception error) { wgcError = Describe(error); }
            Native.GetWindowRect(hwnd, out var rect);
            var w = rect.Right - rect.Left; var h = rect.Bottom - rect.Top;
            if (w <= 0 || h <= 0) throw new InvalidOperationException("the window has no size");
            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                bool ok;
                using (var g = Graphics.FromImage(bmp)) { var hdc = g.GetHdc(); ok = Native.PrintWindow(hwnd, hdc, Native.PW_RENDERFULLCONTENT); g.ReleaseHdc(hdc); }
                if (!ok) throw new InvalidOperationException("PrintWindow failed; graphics capture: " + wgcError);
                bmp.Save(file, ImageFormat.Png);
            }
            return new Dictionary<string, object> { ["method"] = "print-window", ["width"] = w, ["height"] = h, ["area"] = Rect(rect), ["windowRect"] = Rect(rect), ["graphicsCaptureError"] = wgcError };
        }

        static Native.RECT FrameBounds(IntPtr hwnd)
        {
            if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out Native.RECT r, Marshal.SizeOf(typeof(Native.RECT))) == 0) return r;
            Native.GetWindowRect(hwnd, out r);
            return r;
        }

        static IDirect3DDevice device;
        static IDirect3DDevice Device()
        {
            if (device != null) return device;
            // Hardware first, then WARP (software), which virtual machines without a GPU driver still have.
            foreach (var driver in new[] { 1, 5 })
            {
                if (Native.D3D11CreateDevice(IntPtr.Zero, driver, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out var d3d, out _, out var context) != 0) continue;
                try
                {
                    var dxgiId = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
                    if (Marshal.QueryInterface(d3d, ref dxgiId, out var dxgi) != 0) continue;
                    try
                    {
                        if (Native.CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var inspectable) != 0) continue;
                        try { device = (IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable); return device; }
                        finally { Marshal.Release(inspectable); }
                    }
                    finally { Marshal.Release(dxgi); }
                }
                finally { Marshal.Release(d3d); if (context != IntPtr.Zero) Marshal.Release(context); }
            }
            throw new InvalidOperationException("no Direct3D 11 device");
        }

        static GraphicsCaptureItem ItemForWindow(IntPtr hwnd)
        {
            var interop = (IGraphicsCaptureItemInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
            var iid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            var pointer = interop.CreateForWindow(hwnd, ref iid);
            try { return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(pointer); }
            finally { Marshal.Release(pointer); }
        }

        static Size CaptureWithGraphicsCapture(IntPtr hwnd, string file)
        {
            if (!GraphicsCaptureSession.IsSupported()) throw new NotSupportedException("graphics capture is not supported here");
            var item = ItemForWindow(hwnd);
            using (var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(Device(), DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size))
            using (var session = pool.CreateCaptureSession(item))
            {
                // No yellow capture border and no pointer in the image, where this Windows build allows it.
                try { session.IsBorderRequired = false; } catch { }
                try { session.IsCursorCaptureEnabled = false; } catch { }
                Direct3D11CaptureFrame frame = null;
                using (var arrived = new ManualResetEventSlim())
                {
                    pool.FrameArrived += (p, _) => { if (frame == null) { frame = p.TryGetNextFrame(); arrived.Set(); } };
                    session.StartCapture();
                    if (!arrived.Wait(3000)) throw new TimeoutException("no frame within 3 s");
                }
                using (frame)
                {
                    var bitmap = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Premultiplied).AsTask().Result;
                    using (var stream = new InMemoryRandomAccessStream())
                    {
                        var encoder = BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream).AsTask().Result;
                        encoder.SetSoftwareBitmap(bitmap);
                        encoder.FlushAsync().AsTask().Wait();
                        var bytes = new byte[stream.Size];
                        using (var reader = new DataReader(stream.GetInputStreamAt(0)))
                        {
                            reader.LoadAsync((uint)stream.Size).AsTask().Wait();
                            reader.ReadBytes(bytes);
                        }
                        File.WriteAllBytes(file, bytes);
                    }
                    return new Size(bitmap.PixelWidth, bitmap.PixelHeight);
                }
            }
        }
    }
}
