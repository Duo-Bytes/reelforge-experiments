import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Exp-33 · On-Device Voice Isolation / Denoise",
  description:
    "DeepFilterNet3 / RNNoise on-device via onnxruntime-web (WebGPU) or WASM. Realtime A/B and offline render-to-OPFS. Never uploads audio.",
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
