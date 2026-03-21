// src/pdf/assets/qrSvg.ts
import QRCode from "qrcode";

export interface QrSvgOptions {
  size?: number;
  margin?: number;
  darkColor?: string;
  lightColor?: string;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
}

const DEFAULT_SIZE = 256;
const DEFAULT_MARGIN = 1;
const DEFAULT_DARK = "#0f172a";
const DEFAULT_LIGHT = "#ffffff";

export async function buildQrSvg(text: string, options: QrSvgOptions = {}): Promise<string> {
  const value = normalizeInput(text);
  if (value === "") {
    return "";
  }

  try {
    return await QRCode.toString(value, {
      type: "svg",
      width: clampInt(options.size, 64, 1024, DEFAULT_SIZE),
      margin: clampInt(options.margin, 0, 16, DEFAULT_MARGIN),
      errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
      color: {
        dark: normalizeColor(options.darkColor, DEFAULT_DARK),
        light: normalizeColor(options.lightColor, DEFAULT_LIGHT),
      },
    });
  } catch (_err) {
    return "";
  }
}

export async function buildQrDataUri(text: string, options: QrSvgOptions = {}): Promise<string> {
  const svg = await buildQrSvg(text, options);
  return svg !== "" ? svgToDataUri(svg) : "";
}

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function normalizeInput(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeColor(value: string | undefined, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw !== "" ? raw : fallback;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const safe = Math.trunc(Number(value));
  return Math.max(min, Math.min(max, safe));
}
