import { fingerprint } from "../../application-workflow/src/fingerprint.js";
import type { LibraryDocument } from "../../application-workflow/src/types.js";

/**
 * WaterlooWorks regenerates system records (Co-op Work History, Grade Report)
 * on its own, so their PDF bytes change without any user action, sometimes
 * within hours. Users cannot choose or edit them, so an approval pins which
 * record is attached rather than its current bytes. Callers still read the PDF
 * first so an unreadable record remains a blocker.
 */
export function pinSystemDocument(document: LibraryDocument): LibraryDocument {
  return { ...document, revision: fingerprint(["system", document.id, document.typeId, document.name]) };
}
