import { sha256 } from "../../shared/src/sha256.js";
import {
  WATERLOOWORKS_ORIGIN,
  WATERLOOWORKS_JOBS_PATH,
  isBrowserCookie,
  type BridgeHealth,
  type BrowserCookie,
  type WaterlooWorksSession,
} from "../../shared/src/protocol.js";
import {
  AuthenticationExpiredError,
  InvalidRequestError,
  isRefreshableError,
  ProtocolChangedError,
  RateLimitedError,
  WaterlooWorksServerError,
} from "./errors.js";
import { parseBootstrapPage, requirePostingAction, type BootstrapPage } from "./bootstrap.js";
import {
  normalizeDocumentMetadata,
  normalizeEmployerReport,
  normalizeJobPosting,
  normalizeJobSearchResponse,
} from "./normalize.js";
import type {
  JobSearchMetadata,
  GetJobOptions,
  JobPosting,
  JobSearchQuery,
  JobSearchResult,
  WaterlooWorksAccountOverview,
  WaterlooWorksDocumentMetadata,
  WaterlooWorksEmployerReport,
  WaterlooWorksHealth,
} from "./types.js";
import { type FetchLike, type HealthAwareSessionProvider, type SessionProvider } from "./session.js";

const JOBS_PATH = WATERLOOWORKS_JOBS_PATH;
const ALL_RESULTS_PAGE = 1;
const ALL_RESULTS_ITEMS_PER_PAGE = 999_999;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;

export interface WaterlooWorksClientOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  maxConcurrentRequests?: number;
  logger?: WaterlooWorksLogger;
  postingCacheTtlMs?: number;
}

export interface WaterlooWorksLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface AccountOverviewOptions {
  selectedTerm?: string;
  numOfDays?: number;
}

const silentLogger: WaterlooWorksLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function actionFingerprint(value: string): string {
  return `action-${sha256(value).slice(0, 12)}`;
}

function cookieHeader(cookies: BrowserCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function likelyLoginPage(responseUrl: string, body: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(responseUrl);
  } catch {
    return true;
  }
  if (parsed.origin !== WATERLOOWORKS_ORIGIN) return true;
  if (/login|signin|sso|notloggedin|not-logged-in/i.test(parsed.pathname)) return true;
  return /<input[^>]+type=["']password["']/i.test(body) || /microsoftonline\.com/i.test(body);
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

interface ResponseBody {
  response: Response;
  text: string;
}

interface CachedPosting {
  posting: JobPosting;
  expiresAt: number;
}

export class WaterlooWorksClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly logger: WaterlooWorksLogger;
  private readonly limiter: Semaphore;
  private readonly postingCacheTtlMs: number;
  private session: WaterlooWorksSession | undefined;
  private bootstrapState: BootstrapPage | undefined;
  private bootstrapInFlight: Promise<void> | undefined;
  private readonly postingCache = new Map<string, CachedPosting>();

  constructor(private readonly sessionProvider: SessionProvider, options: WaterlooWorksClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = validateClientBaseUrl(options.baseUrl ?? WATERLOOWORKS_ORIGIN);
    this.logger = options.logger ?? silentLogger;
    const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || maxConcurrentRequests > 10) {
      throw new InvalidRequestError("maxConcurrentRequests must be an integer between 1 and 10");
    }
    this.limiter = new Semaphore(maxConcurrentRequests);
    this.postingCacheTtlMs = options.postingCacheTtlMs ?? 5 * 60_000;
  }

  async bootstrap(): Promise<void> {
    await this.bootstrapInternal(false);
  }

  async searchJobs(query: JobSearchQuery = {}): Promise<JobSearchResult> {
    const normalizedQuery = validateSearchQuery(query);
    return this.withRefresh("search", async () => {
      await this.ensureBootstrapped();
      const state = this.requireBootstrap();
      this.logger.info("search.start", {
        keyword: normalizedQuery.keyword ?? "",
      });
      const body = await this.postForm(state.jobsAction, buildSearchForm(state, normalizedQuery));
      const raw = parseJson(body.text, "jobs search");
      const normalized = normalizeJobSearchResponse(raw);
      this.logger.info("search.success", { itemCount: normalized.items.length, total: normalized.total });
      return { ...normalized, raw };
    });
  }

  async getSearchMetadata(): Promise<JobSearchMetadata> {
    return this.withRefresh("search-metadata", async () => {
      await this.ensureBootstrapped();
      const state = this.requireBootstrap();
      return {
        columns: state.columns,
        sort: state.sort,
        filters: state.filters,
        savedFilters: state.savedFilters.map((filter) => sanitizeAccountValue(filter)),
      };
    });
  }

  async getJob(jobId: string, options: GetJobOptions = {}): Promise<JobPosting> {
    const normalizedId = validateJobId(jobId);
    const cached = this.postingCache.get(normalizedId);
    if (cached && cached.expiresAt > Date.now() && !options.includePreScreening) return cached.posting;

    const posting = await this.withRefresh("get-job", async () => {
      await this.ensureBootstrapped();
      const state = this.requireBootstrap();
      const dataAction = requirePostingAction(state, "data");
      const overviewAction = requirePostingAction(state, "overview");
      this.logger.info("posting.start", { jobId: normalizedId });

      const dataBody = await this.postForm(dataAction, new URLSearchParams({ postingId: normalizedId }));
      const postingData = parseJson(dataBody.text, "posting data");
      if (!isRecord(postingData)) throw new ProtocolChangedError("Posting data response is not an object");

      const overviewBody = await this.postForm(overviewAction, new URLSearchParams({ postingId: normalizedId }));
      const overview = parseTextOrJsonString(overviewBody.text);
      let preScreening: string | undefined;
      if (options.includePreScreening) {
        const preScreeningAction = requirePostingAction(state, "preScreening");
        const preScreeningBody = await this.postForm(
          preScreeningAction,
          new URLSearchParams({ postingId: normalizedId }),
        );
        preScreening = parseTextOrJsonString(preScreeningBody.text);
      }

      const result = normalizeJobPosting(normalizedId, postingData, overview, preScreening);
      this.logger.info("posting.success", { jobId: normalizedId, hasDescription: result.description !== undefined });
      return result;
    });

    if (!options.includePreScreening) {
      this.postingCache.set(normalizedId, { posting, expiresAt: Date.now() + this.postingCacheTtlMs });
    }
    return posting;
  }

  async getAccountOverview(options: AccountOverviewOptions = {}): Promise<WaterlooWorksAccountOverview> {
    return this.withRefresh("account-overview", async () => {
      await this.ensureBootstrapped();
      const state = this.requireBootstrap();
      const actions = state.accountActions;

      const [folders, postingsInFolders, blacklistedPostings, folderCounts, stats] = await Promise.all([
        this.postOptionalJson(actions.folders),
        this.postOptionalJson(actions.postingsInFolders),
        this.postOptionalJson(actions.blacklistedPostings),
        this.postOptionalJson(actions.folderCounts),
        this.postOptionalJson(
          actions.stats,
          {
            selectedTerm: options.selectedTerm ?? state.defaultSelectedTerm ?? "",
            numOfDays: String(options.numOfDays ?? 0),
          },
        ),
      ]);

      const overview: WaterlooWorksAccountOverview = {
        folders: normalizeFolders(folders),
        folderCounts: normalizeFolderCounts(folderCounts),
        postingsInFolders: isRecord(postingsInFolders) ? sanitizeAccountRecord(postingsInFolders) : {},
        blacklistedPostings: Array.isArray(blacklistedPostings)
          ? blacklistedPostings.map((value) => sanitizeAccountValue(value))
          : [],
      };
      if (isRecord(stats)) {
        const applicationCount = asFiniteNumber(stats.applicationCount);
        if (applicationCount !== undefined) overview.applicationCount = applicationCount;
      }
      return overview;
    });
  }

  async getDocumentMetadata(): Promise<WaterlooWorksDocumentMetadata> {
    return this.withRefresh("document-metadata", async () => {
      await this.ensureBootstrapped();
      const action = this.requireAccountAction("defaultDocuments");
      const body = await this.postForm(action, new URLSearchParams());
      return normalizeDocumentMetadata(parseJson(body.text, "document metadata"));
    });
  }

  async getEmployerReport(companyId: string): Promise<WaterlooWorksEmployerReport> {
    const normalizedId = validateJobId(companyId);
    return this.withRefresh("employer-report", async () => {
      await this.ensureBootstrapped();
      const state = this.requireBootstrap();
      if (!state.employerReportAction) {
        throw new ProtocolChangedError("The bootstrapped page has no employer report action");
      }
      const body = await this.postForm(
        state.employerReportAction,
        new URLSearchParams({
          reportHolder: "com.orbis.web.content.crm.Company",
          reportHolderId: normalizedId,
          reportHolderField: "t100",
        }),
      );
      return normalizeEmployerReport(parseJson(body.text, "employer report"));
    });
  }

  async health(): Promise<WaterlooWorksHealth> {
    let bridgeConnected = true;
    let bridgeError: string | undefined;
    const provider = this.sessionProvider as Partial<HealthAwareSessionProvider>;
    if (typeof provider.health === "function") {
      try {
        const bridge: BridgeHealth = await provider.health();
        bridgeConnected = bridge.bridgeConnected;
      } catch (error) {
        bridgeConnected = false;
        bridgeError = safeErrorMessage(error);
      }
    }

    try {
      // Revalidate the browser session for every status check. This prevents a
      // cached bootstrap from surviving a WaterlooWorks logout and lets a
      // newly issued cookie become usable without restarting the MCP server.
      this.bootstrapState = undefined;
      this.session = undefined;
      this.postingCache.clear();
      try {
        await this.bootstrapInternal(false);
      } catch (error) {
        // If the bridge still holds a stale session, ask the extension for the
        // current cookies once before reporting authentication failure.
        if (!isRefreshableError(error)) throw error;
        this.bootstrapState = undefined;
        this.session = undefined;
        await this.bootstrapInternal(true);
      }
      const result: WaterlooWorksHealth = {
        authenticated: true,
        bridgeConnected,
        bootstrapped: true,
      };
      if (bridgeError) result.error = bridgeError;
      return result;
    } catch (error) {
      const result: WaterlooWorksHealth = {
        authenticated: false,
        bridgeConnected,
        bootstrapped: this.bootstrapState !== undefined,
        error: safeErrorMessage(error),
      };
      return result;
    }
  }

  private async postOptionalJson(action: string | undefined, fields?: Record<string, string>): Promise<unknown> {
    if (!action) return undefined;
    const form = new URLSearchParams(fields ?? {});
    const body = await this.postForm(action, form);
    return parseJson(body.text, "account metadata");
  }

  private async ensureBootstrapped(): Promise<void> {
    if (this.bootstrapState) return;
    await this.bootstrapInternal(false);
  }

  private requireBootstrap(): BootstrapPage {
    if (!this.bootstrapState) throw new ProtocolChangedError("WaterlooWorks client is not bootstrapped");
    return this.bootstrapState;
  }

  private requireAccountAction(kind: keyof BootstrapPage["accountActions"]): string {
    const action = this.requireBootstrap().accountActions[kind];
    if (!action) throw new ProtocolChangedError(`The bootstrapped page has no account ${kind} action`);
    return action;
  }

  private async bootstrapInternal(forceSessionRefresh: boolean): Promise<void> {
    if (this.bootstrapInFlight) return this.bootstrapInFlight;
    this.bootstrapInFlight = (async () => {
      const session = await this.sessionProvider.getSession({ forceRefresh: forceSessionRefresh });
      validateSessionCookies(session);
      const body = await this.getPage(session);
      if (likelyLoginPage(body.response.url, body.text)) {
        throw new AuthenticationExpiredError();
      }
      const parsed = parseBootstrapPage(body.text);
      this.session = session;
      this.bootstrapState = parsed;
      this.logger.info("bootstrap.success", {
        columns: parsed.columns.length,
        jobsAction: actionFingerprint(parsed.jobsAction),
        postingActions: Object.keys(parsed.postingActions).length,
      });
    })();

    try {
      await this.bootstrapInFlight;
    } finally {
      this.bootstrapInFlight = undefined;
    }
  }

  private async getPage(session: WaterlooWorksSession): Promise<ResponseBody> {
    return this.request(session, "GET", JOBS_PATH);
  }

  private async postForm(action: string, form: URLSearchParams): Promise<ResponseBody> {
    if (!this.session) throw new AuthenticationExpiredError("No WaterlooWorks session is available");
    form.set("action", action);
    return this.request(this.session, "POST", JOBS_PATH, form);
  }

  private async request(
    session: WaterlooWorksSession,
    method: "GET" | "POST",
    path: string,
    form?: URLSearchParams,
  ): Promise<ResponseBody> {
    return this.limiter.run(async () => {
      const requestUrl = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = {
        accept: method === "GET" ? "text/html,application/xhtml+xml" : "application/json, text/plain, */*",
        cookie: cookieHeader(session.cookies),
        referer: `${this.baseUrl}${JOBS_PATH}`,
      };
      const init: RequestInit = { method, headers, redirect: "manual" };
      if (method === "POST" && form) {
        headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        headers.origin = this.baseUrl;
        headers["x-requested-with"] = "XMLHttpRequest";
        init.body = form.toString();
      }

      let response: Response;
      try {
        response = await this.fetchImpl(requestUrl, init);
      } catch (error) {
        throw new WaterlooWorksServerError(`WaterlooWorks ${method} request failed`, error);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        let target: URL | undefined;
        try {
          if (location) target = new URL(location, requestUrl);
        } catch {
          // The redirect is still an authentication/protocol failure even if
          // WaterlooWorks supplied an invalid Location header.
        }
        const targetDescription = target && target.origin === WATERLOOWORKS_ORIGIN ? "WaterlooWorks" : "an external origin";
        throw new AuthenticationExpiredError(`WaterlooWorks redirected the ${method} request to ${targetDescription}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationExpiredError(`WaterlooWorks rejected the ${method} request`);
      }
      if (response.status === 429) throw new RateLimitedError();
      if (response.status >= 500) {
        throw new WaterlooWorksServerError(`WaterlooWorks returned HTTP ${response.status}`);
      }
      const text = await readResponseText(response);
      if (!response.ok) throw new WaterlooWorksServerError(`WaterlooWorks returned HTTP ${response.status}`);
      return { response, text };
    });
  }

  private async withRefresh<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!isRefreshableError(error)) throw error;
      this.logger.warn("session.refresh", { operation, reason: error.code });
      this.bootstrapState = undefined;
      this.session = undefined;
      await this.bootstrapInternal(true);
      return work();
    }
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sanitizeAccountValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeAccountValue(item));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/cookie|authorization|token|password|secret|action/i.test(key)) continue;
    result[key] = sanitizeAccountValue(child);
  }
  return result;
}

function sanitizeAccountRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeAccountValue(value) as Record<string, unknown>;
}

function normalizeFolders(value: unknown): WaterlooWorksAccountOverview["folders"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((folder) => {
      const sanitized = sanitizeAccountValue(folder) as WaterlooWorksAccountOverview["folders"][number];
      if (sanitized.id !== undefined) sanitized.id = String(sanitized.id);
      if (sanitized.name !== undefined) sanitized.name = String(sanitized.name);
      return sanitized;
    });
}

function normalizeFolderCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const counts: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const count = asFiniteNumber(item);
    if (count !== undefined) counts[key] = count;
  }
  return counts;
}

function validateJobId(jobId: string): string {
  const normalized = jobId.trim();
  if (!/^\d+$/.test(normalized)) throw new InvalidRequestError("jobId must be a numeric WaterlooWorks posting ID");
  return normalized;
}

function validateClientBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new InvalidRequestError("baseUrl must be a valid WaterlooWorks origin", error);
  }
  if (parsed.origin !== WATERLOOWORKS_ORIGIN || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new InvalidRequestError("baseUrl must be https://waterlooworks.uwaterloo.ca");
  }
  return parsed.origin;
}

function validateSessionCookies(session: WaterlooWorksSession): void {
  if (!session || !Array.isArray(session.cookies)) {
    throw new ProtocolChangedError("The session provider returned an invalid session");
  }
  for (const cookie of session.cookies) {
    if (!isBrowserCookie(cookie)) throw new ProtocolChangedError("The session provider returned an invalid cookie");
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    if (domain !== "waterlooworks.uwaterloo.ca") {
      throw new ProtocolChangedError("The session provider returned a cookie outside WaterlooWorks");
    }
  }
}

function validateSearchQuery(query: JobSearchQuery): JobSearchQuery {
  if (query.keyword !== undefined && typeof query.keyword !== "string") {
    throw new InvalidRequestError("keyword must be a string");
  }
  if (query.filters !== undefined && query.filters !== null && !isRecord(query.filters)) {
    throw new InvalidRequestError("filters must be an object or null");
  }
  if (query.sort !== undefined) {
    if (!Array.isArray(query.sort) || query.sort.length === 0) {
      throw new InvalidRequestError("sort must be a non-empty array");
    }
    for (const item of query.sort) {
      if (!item || typeof item.key !== "string" || typeof item.direction !== "string") {
        throw new InvalidRequestError("each sort item must contain key and direction strings");
      }
    }
  }
  return { ...query };
}

function buildSearchForm(bootstrap: BootstrapPage, query: JobSearchQuery): URLSearchParams {
  const form = new URLSearchParams();
  form.set("page", String(ALL_RESULTS_PAGE));
  form.set("sort", JSON.stringify(query.sort ?? bootstrap.sort));
  form.set("itemsPerPage", String(ALL_RESULTS_ITEMS_PER_PAGE));
  form.set("filters", query.filters === undefined || query.filters === null ? "null" : JSON.stringify(query.filters));
  form.set("columns", JSON.stringify(bootstrap.columns));
  const keyword = query.keyword ?? "";
  form.set("keyword", keyword ? JSON.stringify([{ value: keyword, op: "all" }]) : "");
  form.set("isDataViewer", "true");
  return form;
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch (error) {
    throw new ProtocolChangedError(`WaterlooWorks returned non-JSON ${operation} data`, error);
  }
}

function parseTextOrJsonString(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    return text;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return "Unknown WaterlooWorks error";
}

async function readResponseText(response: Response): Promise<string> {
  // Some WaterlooWorks JSON/HTML responses contain Windows-1252 characters
  // despite omitting a charset. A fatal UTF-8 pass preserves normal responses;
  // the legacy fallback keeps names such as “Résumé” intact.
  if (typeof response.arrayBuffer !== "function") return response.text();
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
