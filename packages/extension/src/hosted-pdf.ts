type PdfJs = typeof import('pdfjs-dist');
let library: Promise<PdfJs> | undefined;

/** Loaded on first use, so pages that never show a PDF never parse pdf.js. */
function pdfjs(): Promise<PdfJs> {
  return library ??= import('pdfjs-dist').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('pdf.worker.min.mjs') : 'pdf.worker.min.mjs';
    return lib;
  }).catch(error => { library = undefined; throw error; });
}

/** A link on a rendered page, positioned in percent of that page so it scales with it. */
export interface PdfLink { url: string; page: HTMLElement; left: number; top: number; width: number; height: number }

/**
 * Draws every page of `data` into `container` as a canvas and returns its link areas.
 * Rendering is sharp at twice the CSS size; the page itself scales to the container width.
 */
export async function renderPdf(container: HTMLElement, data: Uint8Array, label: string): Promise<PdfLink[]> {
  const lib = await pdfjs();
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const task = lib.getDocument({ data: data.slice(), enableXfa: false }), document = await task.promise, links: PdfLink[] = [];
  try {
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number), base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: 2 });
      const sheet = container.ownerDocument.createElement('div'), canvas = container.ownerDocument.createElement('canvas');
      sheet.className = 'pdf-page'; sheet.style.aspectRatio = `${base.width} / ${base.height}`;
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${label}, page ${number} of ${document.numPages}`);
      sheet.appendChild(canvas); container.appendChild(sheet);
      await page.render({ canvas, viewport }).promise;
      for (const annotation of await page.getAnnotations({ intent: 'display' }) as Array<{ subtype?: string; url?: string; rect?: number[] }>) {
        if (annotation.subtype !== 'Link' || typeof annotation.url !== 'string' || annotation.rect?.length !== 4) continue;
        const [x1, y1] = base.convertToViewportPoint(annotation.rect[0]!, annotation.rect[1]!) as [number, number], [x2, y2] = base.convertToViewportPoint(annotation.rect[2]!, annotation.rect[3]!) as [number, number];
        links.push({
          url: annotation.url, page: sheet,
          left: Math.min(x1, x2) / base.width * 100, top: Math.min(y1, y2) / base.height * 100,
          width: Math.abs(x2 - x1) / base.width * 100, height: Math.abs(y2 - y1) / base.height * 100,
        });
      }
    }
  } finally { await task.destroy(); }
  return links;
}
