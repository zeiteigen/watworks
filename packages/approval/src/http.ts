import { timingSafeEqual } from "node:crypto";
import { attachmentDisposition } from "./documents.js";
import { REVIEW_PAGE } from "./review-page.js";
import { REVIEW_SCRIPT } from "./review-script.js";
import { REVIEW_STYLE } from "./review-style.js";
import type { ReviewRecord, ReviewStatus } from "./types.js";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function reviewResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

interface ReviewHttpBackend {
  get(id: string): ReviewRecord | undefined;
  decide(id: string, hash: string, nonce: string, decision: "approve" | "reject"): ReviewStatus | undefined;
}

function authenticated(request: Request, token: string): boolean {
  const supplied = request.headers.get("authorization");
  const expected = `Bearer ${token}`;
  return supplied !== null && Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function readDecision(request: Request): Promise<{ manifestHash: string; nonce: string } | undefined> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return undefined;
  const body = await request.text();
  if (Buffer.byteLength(body) > 4096) return undefined;
  const value: unknown = JSON.parse(body);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.manifestHash !== "string" || typeof record.nonce !== "string") return undefined;
  return { manifestHash: record.manifestHash, nonce: record.nonce };
}

export function createReviewFetch(origin: () => string, backend: ReviewHttpBackend): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const expectedOrigin = origin();
      if (request.headers.get("host") !== new URL(expectedOrigin).host) return reviewResponse({ error: "Forbidden host" }, 403);
      if (request.method === "POST" && request.headers.get("origin") !== expectedOrigin) return reviewResponse({ error: "Forbidden origin" }, 403);
      const url = new URL(request.url);
      if (url.origin !== expectedOrigin) return reviewResponse({ error: "Forbidden origin" }, 403);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/review.js" || url.pathname === "/review.css")) {
        const script = url.pathname === "/review.js";
        const style = url.pathname === "/review.css";
        return new Response(script ? REVIEW_SCRIPT : style ? REVIEW_STYLE : REVIEW_PAGE, {
          headers: { ...SECURITY_HEADERS, "content-type": script ? "application/javascript; charset=utf-8" : style ? "text/css; charset=utf-8" : "text/html; charset=utf-8" },
        });
      }
      const match = /^\/api\/reviews\/([A-Za-z0-9_-]{1,128})(?:\/(approve|reject)|\/documents\/([A-Za-z0-9_-]{1,128}))?$/.exec(url.pathname);
      if (!match?.[1]) return reviewResponse({ error: "Not found" }, 404);
      const review = backend.get(match[1]);
      if (!review || !authenticated(request, review.token)) return reviewResponse({ error: "Unauthorized" }, 401);
      if (request.method === "GET" && match[3]) {
        const document = review.documents.get(match[3]);
        if (!document) return reviewResponse({ error: "Document not found" }, 404);
        return new Response(new Uint8Array(document.bytes), {
          headers: {
            ...SECURITY_HEADERS,
            "content-type": "application/pdf",
            "content-disposition": attachmentDisposition(document.name),
            "content-length": String(document.bytes.byteLength),
          },
        });
      }
      if (request.method === "GET" && !match[2] && !match[3]) {
        return reviewResponse({
          operationId: review.id,
          status: review.status,
          manifest: review.manifest,
          manifestHash: review.manifestHash,
          actionLabel: review.actionLabel,
          expiresAt: review.expiresAt,
          nonce: review.nonce,
          documents: Array.from(review.documents.values(), document => ({ id: document.id, name: document.name, size: document.bytes.byteLength })),
          ...(review.result === undefined ? {} : { result: review.result }),
        });
      }
      if (request.method === "POST" && (match[2] === "approve" || match[2] === "reject")) {
        const body = await readDecision(request);
        if (!body) return reviewResponse({ error: "Invalid decision" }, 400);
        const state = backend.decide(review.id, body.manifestHash, body.nonce, match[2]);
        if (!state) return reviewResponse({ error: "Review is no longer available or decision does not match" }, 409);
        return reviewResponse(state, match[2] === "approve" ? 202 : 200);
      }
      return reviewResponse({ error: "Method not allowed" }, 405);
    } catch {
      return reviewResponse({ error: "Invalid review request" }, 400);
    }
  };
}
