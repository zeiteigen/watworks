import { describe, expect, test } from "bun:test";
import { parseBootstrapPage } from "../src/bootstrap.js";
import { ProtocolChangedError } from "../src/errors.js";

const fixturePath = new URL("./fixtures/jobs-page.html", import.meta.url);

describe("bootstrap parser", () => {
  test("extracts the DataViewer action, columns, sort, and posting actions", async () => {
    const html = await Bun.file(fixturePath).text();
    const parsed = parseBootstrapPage(html);

    expect(parsed.jobsAction).toBe("fake-jobs-action-for-tests");
    expect(parsed.columns.map((column) => column.key)).toEqual([
      "Id",
      "JobTitle",
      "Organization",
      "Division",
      "Openings",
      "City",
      "Level",
      "ApplicationCount",
      "Deadline",
    ]);
    expect(parsed.columns[1]).toEqual({
      key: "JobTitle",
      title: "Job Title",
      isId: false,
      sortable: true,
      visible: true,
      tableColWidth: 325,
      dataVisualizer: {
        template: "#jobTitleDataVisualizer",
        mixins: [{ props: {} }],
        computed: {},
      },
    });
    expect(parsed.sort).toEqual([{ key: "Id", direction: "desc" }]);
    expect(parsed.postingActions).toEqual({
      data: "fake-data-action-for-tests",
      overview: "fake-overview-action-for-tests",
      preScreening: "fake-prescreening-action-for-tests",
    });
  });

  test("fails loudly when DataViewer configuration is absent", () => {
    expect(() => parseBootstrapPage("<html><body>logged out</body></html>")).toThrow(ProtocolChangedError);
  });

  test("discovers account/report actions and page-defined filter metadata without exposing actions", () => {
    const html = `
      <template id="dataViewer">
        <data-column col-key="Id" title="ID"></data-column>
      </template>
      <data-filter filter-key="viewed" label="Viewed" type="options"
        :is-quick-filter="true" :options="[{'value':'viewed','label':'Viewed'}]"></data-filter>
      <script>
        const dataViewerProps = { dataParams: { action: 'jobs-action', isDataViewer: true }, sort: [{key: 'Id', direction: 'desc'}] };
        const savedFilterGroups = [{id: '1', name: 'Saved'}];
        const account = { methods: {
          getFolders() { const request = { action: 'folders-action' }; },
          getPostingsInFolders() { const request = { action: 'postings-action' }; },
          getBlacklistedPostings() { const request = { action: 'blacklist-action' }; },
          getFoldersCounts() { const request = { action: 'counts-action' }; },
          getStats() { const request = { action: 'stats-action' }; },
          getDefaultDocuments() { const request = { action: 'documents-action' }; }
        }};
        function getWorkTermRatingReportJson(companyId, callback) {
          $.post('/myAccount/co-op/full/jobs.htm', { action: 'report-action', reportHolderId: companyId }, callback, 'json');
        }
      </script>`;

    const parsed = parseBootstrapPage(html);
    expect(parsed.accountActions).toEqual({
      folders: "folders-action",
      postingsInFolders: "postings-action",
      blacklistedPostings: "blacklist-action",
      folderCounts: "counts-action",
      stats: "stats-action",
      defaultDocuments: "documents-action",
    });
    expect(parsed.employerReportAction).toBe("report-action");
    expect(parsed.filters).toMatchObject([
      {
        key: "viewed",
        label: "Viewed",
        type: "options",
        quick: true,
        options: [{ value: "viewed", label: "Viewed" }],
      },
    ]);
    expect(parsed.savedFilters).toEqual([{ id: "1", name: "Saved" }]);
  });
});
