using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using NAudio.Wave;

namespace LanBrowser
{
    internal static class AudioCapture
    {
        private static readonly object OutputLock = new object();

        public static int Main(string[] args)
        {
            int parentPid;
            if (args.Length < 1 || !Int32.TryParse(args[0], out parentPid)) return 64;

            try
            {
                using (WasapiLoopbackCapture capture = new WasapiLoopbackCapture())
                using (Stream output = Console.OpenStandardOutput())
                using (BinaryWriter writer = new BinaryWriter(output))
                {
                    WaveFormat format = capture.WaveFormat;
                    bool isFloat = format.Encoding == WaveFormatEncoding.IeeeFloat ||
                        (format.Encoding == WaveFormatEncoding.Extensible && format.BitsPerSample == 32);
                    writer.Write(new byte[] { (byte)'L', (byte)'B', (byte)'A', (byte)'U' });
                    writer.Write(format.SampleRate);
                    writer.Write((ushort)format.Channels);
                    writer.Write((ushort)format.BitsPerSample);
                    writer.Write((byte)(isFloat ? 1 : 0));
                    writer.Write(new byte[] { 0, 0, 0 });
                    writer.Flush();

                    capture.DataAvailable += delegate(object sender, WaveInEventArgs eventArgs)
                    {
                        if (eventArgs.BytesRecorded <= 0) return;
                        lock (OutputLock)
                        {
                            output.Write(eventArgs.Buffer, 0, eventArgs.BytesRecorded);
                            output.Flush();
                        }
                    };
                    capture.StartRecording();

                    while (ParentIsRunning(parentPid)) Thread.Sleep(250);
                    capture.StopRecording();
                }
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.ToString());
                return 1;
            }
        }

        private static bool ParentIsRunning(int parentPid)
        {
            try { return !Process.GetProcessById(parentPid).HasExited; }
            catch { return false; }
        }
    }
}
