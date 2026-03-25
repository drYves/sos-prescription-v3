"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCode39Svg = buildCode39Svg;
exports.buildCode39DataUri = buildCode39DataUri;
// src/pdf/assets/code39Svg.ts
const CODE39_PATTERNS = {
    "0": "000110100",
    "1": "100100001",
    "2": "001100001",
    "3": "101100000",
    "4": "000110001",
    "5": "100110000",
    "6": "001110000",
    "7": "000100101",
    "8": "100100100",
    "9": "001100100",
    A: "100001001",
    B: "001001001",
    C: "101001000",
    D: "000011001",
    E: "100011000",
    F: "001011000",
    G: "000001101",
    H: "100001100",
    I: "001001100",
    J: "000011100",
    K: "100000011",
    L: "001000011",
    M: "101000010",
    N: "000010011",
    O: "100010010",
    P: "001010010",
    Q: "000000111",
    R: "100000110",
    S: "001000110",
    T: "000010110",
    U: "110000001",
    V: "011000001",
    W: "111000000",
    X: "010010001",
    Y: "110010000",
    Z: "011010000",
    "-": "010000101",
    ".": "110000100",
    " ": "011000100",
    "$": "010101000",
    "/": "010100010",
    "+": "010001010",
    "%": "000101010",
    "*": "010010100",
};
function buildCode39Svg(text) {
    const encoded = normalizeCode39Text(text);
    if (encoded === "") {
        return "";
    }
    const payload = `*${encoded}*`;
    const quiet = 10;
    const narrow = 2;
    const wide = 5;
    const gap = narrow;
    const barHeight = 44;
    const textHeight = 16;
    const paddingTop = 4;
    const paddingBottom = 2;
    let x = quiet;
    const bars = [];
    for (const char of payload) {
        const pattern = CODE39_PATTERNS[char];
        if (!pattern) {
            return "";
        }
        for (let index = 0; index < pattern.length; index++) {
            const bit = pattern[index];
            const width = bit === "1" ? wide : narrow;
            const isBar = index % 2 === 0;
            if (isBar) {
                bars.push(`<rect x="${x}" y="${paddingTop}" width="${width}" height="${barHeight}" rx="0.4" ry="0.4" />`);
            }
            x += width;
        }
        x += gap;
    }
    const width = x + quiet - gap;
    const height = paddingTop + barHeight + textHeight + paddingBottom;
    const safeText = escapeXml(encoded);
    const textX = Math.floor(width / 2);
    const textY = paddingTop + barHeight + 12;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Code barre ${safeText}" shape-rendering="crispEdges">`,
        '  <rect width="100%" height="100%" fill="#ffffff"/>',
        '  <g fill="#0f172a">',
        `    ${bars.join("\n    ")}`,
        '  </g>',
        `  <text x="${textX}" y="${textY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="#334155">${safeText}</text>`,
        '</svg>',
    ].join("\n");
}
function buildCode39DataUri(text) {
    const svg = buildCode39Svg(text);
    if (svg === "") {
        return "";
    }
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
function normalizeCode39Text(text) {
    return String(text ?? "")
        .trim()
        .toUpperCase()
        .replace(/[^0-9A-Z.\- $/+%]/g, "");
}
function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
