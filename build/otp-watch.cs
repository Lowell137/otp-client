// OTP Client League watcher ("Start with League" setting).
//
// A tiny background program registered to run at Windows sign-in instead of the
// whole app. Every 3 s it checks whether the League client (LeagueClientUx.exe) is
// running; when the client starts and OTP Client is not open, it starts OTP Client.
// Usage: otp-watch.exe "<path to OTP Client.exe>"
//
// Build (no SDK needed, .NET Framework compiler that ships with Windows):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /optimize+ /out:build\otp-watch.exe build\otp-watch.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class OtpWatch
{
    // Hand unused pages back to Windows: the .NET runtime touches ~25 MB at start,
    // the loop itself needs very little.
    [DllImport("psapi.dll")] static extern bool EmptyWorkingSet(IntPtr process);
    static void Trim() { try { GC.Collect(); EmptyWorkingSet(Process.GetCurrentProcess().Handle); } catch { } }

    static bool Running(string name)
    {
        Process[] list = Process.GetProcessesByName(name);
        bool any = list.Length > 0;
        foreach (Process p in list) p.Dispose();
        return any;
    }

    static void Main(string[] args)
    {
        bool first;
        using (Mutex one = new Mutex(true, "Local\\OTPClientLeagueWatch", out first))
        {
            if (!first) return; // already watching
            if (args.Length < 1 || !File.Exists(args[0])) return;
            string app = args[0];
            bool was = Running("LeagueClientUx");
            Trim();
            int ticks = 0;
            while (true)
            {
                Thread.Sleep(3000);
                // The app was uninstalled: stop quietly.
                if (!File.Exists(app)) return;
                bool now = Running("LeagueClientUx");
                if (now && !was && !Running("OTP Client"))
                {
                    try
                    {
                        ProcessStartInfo si = new ProcessStartInfo(app);
                        si.UseShellExecute = true;
                        si.WorkingDirectory = Path.GetDirectoryName(app);
                        Process.Start(si);
                    }
                    catch { }
                }
                was = now;
                if (++ticks % 100 == 0) Trim(); // every ~5 min
            }
        }
    }
}
