declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = "/";

// Strip upstream Excalidraw CDN fallback URLs (e.g. esm.sh) so the browser
// only ever attempts to load self-hosted local fonts.
const OriginalFontFace = window.FontFace;
if (typeof OriginalFontFace === "function") {
  window.FontFace = class extends OriginalFontFace {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      let cleanSource = source;
      if (typeof cleanSource === "string") {
        cleanSource = cleanSource
          .split(",")
          .filter((part) => !part.includes("esm.sh"))
          .join(",");
      }
      super(family, cleanSource, descriptors);
    }
  } as unknown as typeof FontFace;
}

export {};
