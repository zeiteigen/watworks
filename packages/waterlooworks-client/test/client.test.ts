import { describe, expect, test } from "bun:test";
import { WaterlooWorksClient } from "../src/client.js";
import { AuthenticationExpiredError, InvalidRequestError, ProtocolChangedError } from "../src/errors.js";
import { BrowserExtensionSessionProvider, createStaticSession } from "../src/session.js";
import type { WaterlooWorksSession } from "../../shared/src/protocol.js";

const root = new URL("./fixtures/", import.meta.url);
const page = await Bun.file(new URL("jobs-page.html", root)).text();
const emptyResults = await Bun.file(new URL("search-empty.json", root)).text();
const keywordResults = await Bun.file(new URL("search-keyword.json", root)).text();
const postingData = await Bun.file(new URL("posting-data.json", root)).text();
const postingOverview = await Bun.file(new URL("posting-overview.html", root)).text();

const fakeSession: WaterlooWorksSession = createStaticSession([
  {
    name: "WW_SESSION",
    value: "fake-cookie-value",
    domain: "waterlooworks.uwaterloo.ca",
    path: "/",
    secure: true,
    httpOnly: true,
  },
]);

interface MockCall {
  url: string;
  init: RequestInit | undefined;
}

function response(body: string, url: string, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    text: async () => body,
  } as Response;
}

function makeClient(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): WaterlooWorksClient {
  return new WaterlooWorksClient(new (class {
    async getSession() {
      return fakeSession;
    }
  })(), { fetchImpl });
}

describe("WaterlooWorksClient", () => {
  test("does not allow the browser session provider to use a remote bridge", () => {
    expect(() => new BrowserExtensionSessionProvider({ baseUrl: "https://example.com" })).toThrow(InvalidRequestError);
  });

  test("does not allow a configured base URL to redirect session cookies", () => {
    expect(() => new WaterlooWorksClient({ getSession: async () => fakeSession }, { baseUrl: "https://example.com" })).toThrow(
      InvalidRequestError,
    );
  });

  test("rejects foreign cookies from any session provider before making a request", async () => {
    let requestCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      requestCount += 1;
      return response(page, "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm");
    };
    const foreignSession = createStaticSession([
      {
        name: "SSO",
        value: "redacted-test-value",
        domain: "login.microsoftonline.com",
        path: "/",
        secure: true,
        httpOnly: true,
      },
    ]);

    await expect(
      new WaterlooWorksClient(new (class {
        async getSession() {
          return foreignSession;
        }
      })(), { fetchImpl }).searchJobs(),
    ).rejects.toBeInstanceOf(ProtocolChangedError);
    expect(requestCount).toBe(0);
  });

  test("bootstraps and searches with empty and keyword queries", async () => {
    const calls: MockCall[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("action")).toBe("fake-jobs-action-for-tests");
        expect(form.get("isDataViewer")).toBe("true");
        expect(form.get("filters")).toBe("null");
        expect(form.get("sort")).toBe(JSON.stringify([{ key: "Id", direction: "desc" }]));
        expect(form.get("page")).toBe("1");
        expect(form.get("itemsPerPage")).toBe("999999");
        const columns = JSON.parse(form.get("columns") ?? "null") as Array<Record<string, unknown>>;
        expect(columns[1]?.dataVisualizer).toEqual({
          template: "#jobTitleDataVisualizer",
          mixins: [{ props: {} }],
          computed: {},
        });
        return response(form.get("keyword") ? keywordResults : emptyResults, url);
      }
      return response(page, url);
    };

    const client = makeClient(fetchImpl);
    const empty = await client.searchJobs();
    expect(empty.total).toBe(1);
    expect(empty.items[0]).toMatchObject({
      id: "12345",
      title: "FPGA Design Co-op",
      organization: "Example Semiconductors",
      openings: 2,
      city: "Waterloo",
      applicationCount: 7,
      deadline: "2026-09-30T09:00:00-0400",
    });

    const keyword = await client.searchJobs({ keyword: "FPGA" });
    const keywordCall = calls.at(-1);
    expect(keyword.items[0]?.title).toBe("FPGA Design Co-op");
    expect(new URLSearchParams(String(keywordCall?.init?.body)).get("keyword")).toBe(
      JSON.stringify([{ value: "FPGA", op: "all" }]),
    );
    expect(keywordCall?.init?.headers).toMatchObject({ cookie: "WW_SESSION=fake-cookie-value" });
    expect(calls.filter((call) => call.init?.method === "GET")).toHaveLength(1);
  });

  test("retrieves structured posting data and overview without requiring browser automation", async () => {
    const calls: MockCall[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      if (!init?.method || init.method === "GET") return response(page, url);
      const form = new URLSearchParams(String(init.body));
      expect(form.get("postingId")).toBe("12345");
      if (form.get("action") === "fake-data-action-for-tests") return response(postingData, url);
      if (form.get("action") === "fake-overview-action-for-tests") return response(postingOverview, url);
      throw new Error("unexpected action in test");
    };

    const posting = await makeClient(fetchImpl).getJob("12345");
    expect(posting).toMatchObject({
      id: "12345",
      title: "FPGA Design Co-op",
      organization: "Example Semiconductors",
      openings: 2,
      location: { city: "Waterloo", region: "Ontario", country: "Canada" },
      description: postingOverview,
      skills: ["SystemVerilog", "FPGA", "Python"],
      canApply: true,
      hasApplication: false,
      canCancelApplication: false,
      applicationWebsite: "https://waterlooworks.uwaterloo.ca/",
    });
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(2);
  });

  test("retrieves read-only account metadata and employer reports from page-discovered actions", async () => {
    const advancedPage = `${page}
      <script>
        const savedFilterGroups = [];
        const account = { methods: {
          getFolders() { const request = { action: 'folders-action' }; },
          getPostingsInFolders() { const request = { action: 'postings-action' }; },
          getBlacklistedPostings() { const request = { action: 'blacklist-action' }; },
          getFoldersCounts() { const request = { action: 'counts-action' }; },
          getStats() { const request = { action: 'stats-action' }; },
          getDefaultDocuments() { const request = { action: 'documents-action' }; }
        }};
        function getWorkTermRatingReportJson(companyId, callback) {
          $.post('/myAccount/co-op/full/jobs.htm', { action: 'report-action' }, callback, 'json');
        }
      </script>`;
    const forms: URLSearchParams[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!init?.method || init.method === "GET") return response(advancedPage, url);
      const form = new URLSearchParams(String(init.body));
      forms.push(form);
      const action = form.get("action");
      const bodies: Record<string, string> = {
        "folders-action": JSON.stringify([{ id: 7, name: "Saved jobs" }]),
        "postings-action": JSON.stringify({ "7": ["12345"] }),
        "blacklist-action": JSON.stringify(["99999"]),
        "counts-action": JSON.stringify({ "7": 2 }),
        "stats-action": JSON.stringify({ applicationCount: 3 }),
        "documents-action": JSON.stringify({
          docTypes: { "67": { id: 67, name: "Résumé", maxDefault: 3 } },
          defaultDocMap: { "67": [] },
          defaultPackageEnabled: true,
          specialDocs: {},
        }),
        "report-action": JSON.stringify({ page: "Report", sections: [] }),
      };
      const body = bodies[action ?? ""];
      if (!body) throw new Error(`unexpected action ${action}`);
      return response(body, url);
    };

    const client = makeClient(fetchImpl);
    const overview = await client.getAccountOverview({ selectedTerm: "437", numOfDays: 0 });
    expect(overview).toEqual({
      folders: [{ id: "7", name: "Saved jobs" }],
      folderCounts: { "7": 2 },
      postingsInFolders: { "7": ["12345"] },
      blacklistedPostings: ["99999"],
      applicationCount: 3,
    });
    const statsForm = forms.find((form) => form.get("action") === "stats-action");
    expect(statsForm?.get("selectedTerm")).toBe("437");
    expect(statsForm?.get("numOfDays")).toBe("0");

    expect(await client.getDocumentMetadata()).toMatchObject({ defaultPackageEnabled: true });
    expect(await client.getEmployerReport("43015")).toEqual({ reportAvailable: true, title: "Report", sections: [] });
  });

  test("rebootstraps and retries once after an expired action response", async () => {
    let getCount = 0;
    let postCount = 0;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!init?.method || init.method === "GET") {
        getCount += 1;
        return response(page, url);
      }
      postCount += 1;
      return response(postCount === 1 ? "[]" : emptyResults, url);
    };

    const result = await makeClient(fetchImpl).searchJobs({ keyword: "FPGA" });
    expect(result.items).toHaveLength(1);
    expect(getCount).toBe(2);
    expect(postCount).toBe(2);
  });

  test("refreshes the session provider once after authentication failure", async () => {
    let getCount = 0;
    let postCount = 0;
    const provider = new (class {
      async getSession(options: { forceRefresh?: boolean } = {}) {
        expect(options.forceRefresh ?? false).toBe(getCount > 0);
        return fakeSession;
      }
    })();
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!init?.method || init.method === "GET") {
        getCount += 1;
        return response(getCount === 1 ? "unauthorized" : page, url, getCount === 1 ? 401 : 200);
      }
      postCount += 1;
      return response(emptyResults, url);
    };

    const result = await new WaterlooWorksClient(provider, { fetchImpl }).searchJobs();
    expect(result.total).toBe(1);
    expect(getCount).toBe(2);
    expect(postCount).toBe(1);
  });

  test("classifies WaterlooWorks notLoggedIn redirects as authentication expiry", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!init?.method || init.method === "GET") {
        return response("<html><body>Not logged in</body></html>", "https://waterlooworks.uwaterloo.ca/notLoggedIn.htm");
      }
      return response("unexpected", url);
    };

    await expect(makeClient(fetchImpl).searchJobs()).rejects.toBeInstanceOf(AuthenticationExpiredError);
  });

  test("does not follow an authentication redirect with the session Cookie header", async () => {
    let observedInit: RequestInit | undefined;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      observedInit = init;
      return {
        status: 302,
        ok: false,
        url: String(input),
        headers: new Headers({ location: "https://login.microsoftonline.com/example" }),
        text: async () => "",
      } as Response;
    };

    await expect(makeClient(fetchImpl).searchJobs()).rejects.toBeInstanceOf(AuthenticationExpiredError);
    expect(observedInit?.redirect).toBe("manual");
    expect((observedInit?.headers as Record<string, string>).cookie).toBe("WW_SESSION=fake-cookie-value");
  });

  test("raises ProtocolChangedError for malformed search data", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      return !init?.method || init.method === "GET"
        ? response(page, url)
        : response(JSON.stringify({ totalResults: 1, data: [{ id: "x" }], page: 1 }), url);
    };

    await expect(makeClient(fetchImpl).searchJobs()).rejects.toBeInstanceOf(ProtocolChangedError);
  });
});
