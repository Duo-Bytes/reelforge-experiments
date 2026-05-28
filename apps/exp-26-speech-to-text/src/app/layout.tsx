import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Exp-26 · Speech-to-Text / Auto-Captions On-Device",
  description:
    "On-device transcription: 16k resampling via OfflineAudioContext, chunking, VAD, and real Whisper/Moonshine inference via Transformers.js on the WebGPU EP. Word-level timestamps. Audio never leaves the machine.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
