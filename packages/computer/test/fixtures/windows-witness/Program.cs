// The disposable window for test/windows-live.ts: ordinary WinForms controls whose changes it writes to a JSON file of
// its own, independently of Mountains, so the check can compare what Mountains claims with what the app experienced.
//
//   mountains-windows-witness.exe <stamp> <state.json> [--no-activate] [--parent <pid>] [--at <x>,<y>]
//
//   <stamp>        the window is titled "Mountains Witness <stamp>"
//   <state.json>   written (atomically: temp file, then replace) on start and after every change
//   --no-activate  accepted for explicitness; showing without activation is always the default
//   --parent <pid> close when that process ends, so a killed driver never leaves the window behind
//   --at <x>,<y>   screen position of the window's top-left corner (physical pixels)
//
// The app never calls Activate or SetForegroundWindow, and never moves focus by itself.
// Controls (accessible names are set explicitly, so the UI Automation names do not depend on label heuristics):
//   Button "Add one" (counts, shown in a label)   CheckBox "Remember me"   ComboBox "Size" (Small, Medium, Large)
//   TextBox "Note"   TrackBar "Volume" (0-100, starts at 50)   TreeView "Folder tree" with a node "Folders" (2 children)
//
// State file: { pid, hwnd, title, stamp, startedAt, revision, counter, checked, size, note, volume, folderExpanded,
//   active, containsFocus, activations, deactivations, keyDown, keyPress, keyUp, mouseDown, mouseUp,
//   bounds, backColor, writeFailures, events: [{ at, event }] }.
// A control changed from outside the app's own event handlers (a trackbar position set by message, for example) is
// found by a 100 ms poll and recorded as "poll: ...".
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Mountains.Witness
{
    sealed class WitnessForm : Form
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        static readonly string[] Fields = { "counter", "checked", "size", "note", "volume", "folderExpanded" };
        static readonly Color Back = Color.FromArgb(230, 217, 242);
        const int MaxEvents = 300;

        readonly string statePath, stamp, startedAt = Now();
        readonly bool noActivate;
        readonly Button addOne = new Button();
        readonly Label count = new Label();
        readonly CheckBox remember = new CheckBox();
        readonly ComboBox size = new ComboBox();
        readonly TextBox note = new TextBox();
        readonly TrackBar volume = new TrackBar();
        readonly TreeView folders = new TreeView();
        readonly TreeNode root = new TreeNode("Folders");
        readonly List<KeyValuePair<string, string>> events = new List<KeyValuePair<string, string>>();
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 100 };
        string[] last = new string[0];
        int counter, activations, deactivations, revision, writeFailures;
        int keyDown, keyPress, keyUp, mouseDown, mouseUp;
        bool writePending;

        public WitnessForm(string stamp, string statePath, bool noActivate, Point? at)
        {
            this.stamp = stamp; this.statePath = statePath; this.noActivate = noActivate;
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = "Mountains Witness " + stamp;
            Name = "witness";
            BackColor = Back;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            ClientSize = new Size(440, 360);
            if (at.HasValue) { StartPosition = FormStartPosition.Manual; Location = at.Value; }

            addOne.Text = "Add one"; addOne.AccessibleName = "Add one"; addOne.Name = "addOne";
            addOne.SetBounds(12, 12, 96, 28);
            addOne.Click += (s, e) => { counter++; count.Text = "Count: " + counter.ToString(Inv); Save("Click Add one counter=" + counter.ToString(Inv)); };

            count.Text = "Count: 0"; count.Name = "count"; count.SetBounds(120, 18, 120, 20);

            remember.Text = "Remember me"; remember.AccessibleName = "Remember me"; remember.Name = "remember";
            remember.SetBounds(12, 52, 160, 22);
            remember.CheckedChanged += (s, e) => Save("CheckedChanged checked=" + Bool(remember.Checked));

            size.DropDownStyle = ComboBoxStyle.DropDownList; size.AccessibleName = "Size"; size.Name = "size";
            size.Items.AddRange(new object[] { "Small", "Medium", "Large" });
            size.SelectedIndex = 0;
            size.SetBounds(12, 84, 160, 24);
            size.SelectedIndexChanged += (s, e) => Save("SelectedIndexChanged size=" + SizeText());

            note.AccessibleName = "Note"; note.Name = "note"; note.SetBounds(12, 116, 300, 24);
            note.TextChanged += (s, e) => Save("TextChanged note=" + note.Text);

            volume.Minimum = 0; volume.Maximum = 100; volume.Value = 50; volume.TickFrequency = 10; volume.SmallChange = 1; volume.LargeChange = 10;
            volume.AccessibleName = "Volume"; volume.Name = "volume"; volume.SetBounds(12, 148, 300, 45);
            volume.ValueChanged += (s, e) => Save("ValueChanged volume=" + volume.Value.ToString(Inv));

            root.Nodes.Add("Documents"); root.Nodes.Add("Pictures");
            folders.Nodes.Add(root);
            folders.AccessibleName = "Folder tree"; folders.Name = "folders"; folders.HideSelection = false;
            folders.SetBounds(12, 204, 300, 140);
            folders.AfterExpand += (s, e) => Save("AfterExpand folderExpanded=" + Bool(root.IsExpanded));
            folders.AfterCollapse += (s, e) => Save("AfterCollapse folderExpanded=" + Bool(root.IsExpanded));

            Controls.AddRange(new Control[] { addOne, count, remember, size, note, volume, folders });
            foreach (Control c in new Control[] { addOne, remember, size, note, volume, folders })
            {
                var name = c.Name;
                c.GotFocus += (s, e) => Save("GotFocus " + name);
                c.LostFocus += (s, e) => Save("LostFocus " + name);
                c.KeyDown += (s, e) => { keyDown++; Save("KeyDown " + name); };
                c.KeyPress += (s, e) => { keyPress++; Save("KeyPress " + name); };
                c.KeyUp += (s, e) => { keyUp++; Save("KeyUp " + name); };
                c.MouseDown += (s, e) => { mouseDown++; Save("MouseDown " + name); };
                c.MouseUp += (s, e) => { mouseUp++; Save("MouseUp " + name); };
            }

            Load += (s, e) => Save("Load");
            Shown += (s, e) => Save("Shown");
            Activated += (s, e) => { activations++; Save("Activated"); };
            Deactivate += (s, e) => { deactivations++; Save("Deactivate"); };
            GotFocus += (s, e) => Save("GotFocus");
            LostFocus += (s, e) => Save("LostFocus");
            KeyDown += (s, e) => { keyDown++; Save("KeyDown form"); };
            KeyPress += (s, e) => { keyPress++; Save("KeyPress form"); };
            KeyUp += (s, e) => { keyUp++; Save("KeyUp form"); };
            MouseDown += (s, e) => { mouseDown++; Save("MouseDown form"); };
            MouseUp += (s, e) => { mouseUp++; Save("MouseUp form"); };
            FormClosing += (s, e) => Save("FormClosing");
            poll.Tick += (s, e) => Poll();
            poll.Start();
        }

        // The app is shown without being activated when started with --no-activate; it never activates itself.
        protected override bool ShowWithoutActivation { get { return noActivate; } }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            // Captions are painted, not controls, so the UI Automation tree holds only the controls above.
            foreach (var pair in new[] { new KeyValuePair<string, Control>("Size", size), new KeyValuePair<string, Control>("Note", note), new KeyValuePair<string, Control>("Volume", volume), new KeyValuePair<string, Control>("Folders", folders) })
                TextRenderer.DrawText(e.Graphics, pair.Key, Font, new Point(322, pair.Value.Top + 4), SystemColors.GrayText);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) poll.Dispose();
            base.Dispose(disposing);
        }

        static string Now() { return DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", Inv); }
        static string Bool(bool value) { return value ? "true" : "false"; }
        string SizeText() { return Convert.ToString(size.SelectedItem, Inv) ?? ""; }

        string[] Values()
        {
            return new[] { counter.ToString(Inv), Bool(remember.Checked), SizeText(), note.Text, volume.Value.ToString(Inv), Bool(root.IsExpanded) };
        }

        void Record(string what)
        {
            events.Add(new KeyValuePair<string, string>(Now(), what));
            if (events.Count > MaxEvents) events.RemoveRange(0, events.Count - MaxEvents);
        }

        // Anything the event handlers did not see: a control changed by message or by a UI Automation provider.
        void Poll()
        {
            var now = Values();
            var changed = new List<string>();
            for (int i = 0; i < now.Length; i++) if (i >= last.Length || now[i] != last[i]) changed.Add(Fields[i]);
            if (changed.Count > 0) Save("poll: " + string.Join(", ", changed.ToArray()));
            else if (writePending) writePending = !Write(Json());
        }

        void Save(string what)
        {
            Record(what);
            last = Values();
            revision++;
            writePending = !Write(Json());
        }

        string Json()
        {
            var v = Values();
            var b = new StringBuilder(2048);
            b.Append('{');
            b.Append("\"pid\":").Append(Process.GetCurrentProcess().Id.ToString(Inv));
            b.Append(",\"hwnd\":").Append(IsHandleCreated ? Handle.ToInt64().ToString(Inv) : "0");
            b.Append(",\"title\":"); Str(b, Text);
            b.Append(",\"stamp\":"); Str(b, stamp);
            b.Append(",\"startedAt\":"); Str(b, startedAt);
            b.Append(",\"revision\":").Append(revision.ToString(Inv));
            b.Append(",\"counter\":").Append(v[0]);
            b.Append(",\"checked\":").Append(v[1]);
            b.Append(",\"size\":"); Str(b, v[2]);
            b.Append(",\"note\":"); Str(b, v[3]);
            b.Append(",\"volume\":").Append(v[4]);
            b.Append(",\"folderExpanded\":").Append(v[5]);
            b.Append(",\"active\":").Append(Bool(ActiveForm == this));
            b.Append(",\"containsFocus\":").Append(Bool(ContainsFocus));
            b.Append(",\"activations\":").Append(activations.ToString(Inv));
            b.Append(",\"deactivations\":").Append(deactivations.ToString(Inv));
            b.Append(",\"keyDown\":").Append(keyDown.ToString(Inv));
            b.Append(",\"keyPress\":").Append(keyPress.ToString(Inv));
            b.Append(",\"keyUp\":").Append(keyUp.ToString(Inv));
            b.Append(",\"mouseDown\":").Append(mouseDown.ToString(Inv));
            b.Append(",\"mouseUp\":").Append(mouseUp.ToString(Inv));
            var r = Bounds;
            b.Append(",\"bounds\":{\"x\":").Append(r.X.ToString(Inv)).Append(",\"y\":").Append(r.Y.ToString(Inv)).Append(",\"width\":").Append(r.Width.ToString(Inv)).Append(",\"height\":").Append(r.Height.ToString(Inv)).Append('}');
            b.Append(",\"backColor\":[").Append(Back.R.ToString(Inv)).Append(',').Append(Back.G.ToString(Inv)).Append(',').Append(Back.B.ToString(Inv)).Append(']');
            b.Append(",\"writeFailures\":").Append(writeFailures.ToString(Inv));
            b.Append(",\"events\":[");
            for (int i = 0; i < events.Count; i++)
            {
                if (i > 0) b.Append(',');
                b.Append("{\"at\":"); Str(b, events[i].Key); b.Append(",\"event\":"); Str(b, events[i].Value); b.Append('}');
            }
            b.Append("]}");
            return b.ToString();
        }

        // JSON string, ASCII only (\uXXXX per UTF-16 unit), so the file reads the same under any encoding.
        static void Str(StringBuilder b, string s)
        {
            b.Append('"');
            foreach (char c in s ?? "")
            {
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4", Inv)); else b.Append(c);
                        break;
                }
            }
            b.Append('"');
        }

        // Temp file, then replace: a reader sees the old file or the new one, never half of one.
        bool Write(string json)
        {
            var temp = statePath + ".tmp";
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    File.WriteAllText(temp, json, new UTF8Encoding(false));
                    if (File.Exists(statePath)) File.Replace(temp, statePath, null); else File.Move(temp, statePath);
                    return true;
                }
                catch (IOException) { Thread.Sleep(15); }
                catch (UnauthorizedAccessException) { Thread.Sleep(15); }
            }
            writeFailures++;
            return false;
        }

        public void CloseWhenParentEnds(int parentPid)
        {
            var watcher = new Thread(() =>
            {
                try { using (var parent = Process.GetProcessById(parentPid)) parent.WaitForExit(); }
                catch (ArgumentException) { /* already gone */ }
                try { BeginInvoke(new Action(Close)); }
                catch (InvalidOperationException) { /* the window is already closed */ }
            }) { IsBackground = true };
            bool started = false;
            HandleCreated += (s, e) => { if (!started) { started = true; watcher.Start(); } };
        }
    }

    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [STAThread]
        static int Main(string[] args)
        {
            string stamp = null, statePath = null;
            bool noActivate = true;
            int parent = 0;
            Point? at = null;
            for (int i = 0; i < args.Length; i++)
            {
                var a = args[i];
                if (a == "--no-activate") noActivate = true;
                else if (a == "--parent" && i + 1 < args.Length && int.TryParse(args[++i], NumberStyles.None, CultureInfo.InvariantCulture, out parent)) { }
                else if (a == "--at" && i + 1 < args.Length)
                {
                    var p = args[++i].Split(',');
                    int x, y;
                    if (p.Length != 2 || !int.TryParse(p[0], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out x) || !int.TryParse(p[1], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out y)) return 2;
                    at = new Point(x, y);
                }
                else if (a.StartsWith("--", StringComparison.Ordinal)) return 2;
                else if (stamp == null) stamp = a;
                else if (statePath == null) statePath = a;
                else return 2;
            }
            if (string.IsNullOrEmpty(stamp) || string.IsNullOrEmpty(statePath)) return 2;

            // Physical pixels, like the Windows helper and the live check; must come before any window exists.
            SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // An unhandled error must not open the framework's modal error dialog (which would take the front).
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            int exitCode = 0;
            Application.ThreadException += (s, e) => { exitCode = 1; try { File.WriteAllText(statePath + ".error", e.Exception.ToString(), new UTF8Encoding(false)); } catch { } Application.Exit(); };

            using (var form = new WitnessForm(stamp, statePath, noActivate, at))
            {
                if (parent > 0) form.CloseWhenParentEnds(parent);
                Application.Run(form);
            }
            return exitCode;
        }
    }
}
