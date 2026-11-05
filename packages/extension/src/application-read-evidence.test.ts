import { expect, test } from "bun:test";
import { applicationReadEvidence } from "./application-read-evidence.js";

test("application diagnostics preserve request structure while redacting private literal values and comments",()=>{
  const evidence=applicationReadEvidence(`<script>
    const secret = \`PRIVATE-TEXT
      request.secret = PRIVATE-MULTILINE
    \`;
    // request.privateToken = PRIVATE-COMMENT
    const request = {action:"PRIVATE-ACTION", studentId:123456789, selectedTerm:"PRIVATE-TERM"};
    viewer.load(request);
    </script><input name="selectedTerm" value="PRIVATE-INPUT">`);
  const serialized=JSON.stringify(evidence);
  expect(serialized).toContain("studentId");
  expect(serialized).toContain("viewer.load(request)");
  expect(serialized).not.toContain("PRIVATE");
  expect(serialized).not.toContain("123456789");
  expect(evidence.fields).toEqual(["selectedTerm"]);
});
