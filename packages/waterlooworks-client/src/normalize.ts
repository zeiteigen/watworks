import type {
  JobLocation,
  JobPosting,
  JobPostingApplication,
  JobPreScreening,
  JobPreScreeningQuestion,
  JobSearchItem,
  JobTitleFlags,
  WaterlooWorksDocumentMetadata,
  WaterlooWorksEmployerReport,
  WaterlooWorksEmployerReportAnalytics,
  WaterlooWorksReportChart,
  WaterlooWorksReportTable,
} from "./types.js";
import { ProtocolChangedError } from "./errors.js";

export type RawWaterlooWorksJob = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function unwrapRowData(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) throw new ProtocolChangedError("A job search row is not an object");
  const data = row.data;
  if (Array.isArray(data)) {
    const fields: Record<string, unknown> = {};
    for (const item of data) {
      if (!isRecord(item) || typeof item.key !== "string" || !("value" in item)) {
        throw new ProtocolChangedError("A job search row contains an invalid field");
      }
      fields[item.key] = item.value;
    }
    return fields;
  }
  if (isRecord(data)) return data;
  throw new ProtocolChangedError("A job search row has no data fields");
}

function titleFromValue(value: unknown): string | undefined {
  if (isRecord(value)) return firstString(value, ["postingTitle", "title", "display"]);
  return asString(value);
}

function titleFlagsFromValue(value: unknown): JobTitleFlags | undefined {
  if (!isRecord(value)) return undefined;
  const flags: JobTitleFlags = {};
  const isNew = asBoolean(value.new);
  const featured = asBoolean(value.featured);
  const applied = asBoolean(value.applied);
  const viewed = asBoolean(value.viewed);
  if (isNew !== undefined) flags.isNew = isNew;
  if (featured !== undefined) flags.featured = featured;
  if (applied !== undefined) flags.applied = applied;
  if (viewed !== undefined) flags.viewed = viewed;
  return Object.keys(flags).length > 0 ? flags : undefined;
}

function safeSearchAttributes(fields: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/cookie|authorization|token|password|secret|action/i.test(key)) continue;
    attributes[key] = safeSearchValue(value);
  }
  return attributes;
}

function safeSearchValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => safeSearchValue(item));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/cookie|authorization|token|password|secret|action/i.test(key)) continue;
    result[key] = safeSearchValue(child);
  }
  return result;
}

export function normalizeJobSearchItem(raw: unknown): JobSearchItem {
  if (!isRecord(raw)) throw new ProtocolChangedError("A job search result is not an object");
  const fields = unwrapRowData(raw);
  const id = asString(raw.id) ?? firstString(fields, ["postingId", "Id"]);
  if (!id) throw new ProtocolChangedError("A job search result has no posting identifier");

  const item: JobSearchItem = { id, raw };
  const title = titleFromValue(fields.JobTitle);
  const titleFlags = titleFlagsFromValue(fields.JobTitle);
  const organization = firstString(fields, ["Organization"]);
  const division = firstString(fields, ["Division"]);
  const city = firstString(fields, ["City"]);
  const level = firstString(fields, ["Level"]);
  const deadline = firstString(fields, ["deadline", "Deadline"]);
  const deadlineDisplay = firstString(fields, ["Deadline"]);
  if (title !== undefined) item.title = title;
  if (titleFlags !== undefined) item.titleFlags = titleFlags;
  if (organization !== undefined) item.organization = organization;
  if (division !== undefined) item.division = division;
  if (city !== undefined) item.city = city;
  if (level !== undefined) item.level = level;
  if (deadline !== undefined) item.deadline = deadline;
  if (deadlineDisplay !== undefined) item.deadlineDisplay = deadlineDisplay;

  const openings = firstNumber(fields, ["Openings"]);
  const applicationCount = firstNumber(fields, ["ApplicationCount"]);
  if (openings !== undefined) item.openings = openings;
  if (applicationCount !== undefined) item.applicationCount = applicationCount;

  const canApply = asBoolean(fields.canApply);
  const hasApplication = asBoolean(fields.hasApplication);
  const online = asBoolean(fields.online);
  const apply = asBoolean(fields.apply);
  if (canApply !== undefined) item.canApply = canApply;
  if (hasApplication !== undefined) item.hasApplication = hasApplication;
  if (online !== undefined) item.online = online;
  if (apply !== undefined) item.apply = apply;
  const attributes = safeSearchAttributes(fields);
  if (Object.keys(attributes).length > 0) item.attributes = attributes;
  return item;
}

export function normalizeJobSearchResponse(raw: unknown): {
  items: JobSearchItem[];
  total: number;
} {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new ProtocolChangedError("The jobs search response is missing data");
  }
  const total = asNumber(raw.totalResults);
  if (total === undefined) {
    throw new ProtocolChangedError("The jobs search response is missing totalResults");
  }
  return {
    items: raw.data.map(normalizeJobSearchItem),
    total,
  };
}

function textField(record: Record<string, unknown>, keys: string[]): string | undefined {
  return firstString(record, keys);
}

function locationFromRecord(location: Record<string, unknown>, fallback?: Record<string, unknown>): JobLocation {
  const city = firstString(location, ["city", "City"]) ?? (fallback && firstString(fallback, ["city", "City"]));
  const region =
    firstString(location, ["region", "province", "state", "Region"]) ??
    (fallback && firstString(fallback, ["region", "province", "state", "Region"]));
  const country = firstString(location, ["country", "Country"]) ?? (fallback && firstString(fallback, ["country", "Country"]));
  const address = location.address;
  const addressParts = Array.isArray(address)
    ? address.map(asString).filter((value): value is string => value !== undefined && value.trim() !== "")
    : [];
  const addressLineOne = firstString(location, ["addressLineOne", "address1", "line1"]) ?? addressParts[0];
  const addressLineTwo = firstString(location, ["addressLineTwo", "address2", "line2"]) ?? addressParts[1];
  const postalCode = firstString(location, ["postalCode", "postal", "zip", "zipCode"]);
  const fullAddress =
    firstString(location, ["fullAddress", "addressText"]) ??
    (addressParts.length > 0 ? addressParts.join(", ") : undefined);
  const name = firstString(location, ["name"]);
  const title = firstString(location, ["title"]);
  const latitude = asNumber(location.latitude);
  const longitude = asNumber(location.longitude);
  const remote =
    typeof location.remote === "boolean"
      ? location.remote
      : fallback && typeof fallback.remote === "boolean"
        ? fallback.remote
        : undefined;

  const result: JobLocation = {};
  if (city !== undefined) result.city = city;
  if (region !== undefined) result.region = region;
  if (country !== undefined) result.country = country;
  if (remote !== undefined) result.remote = remote;
  if (addressLineOne !== undefined) result.addressLineOne = addressLineOne;
  if (addressLineTwo !== undefined) result.addressLineTwo = addressLineTwo;
  if (postalCode !== undefined) result.postalCode = postalCode;
  if (fullAddress !== undefined) result.fullAddress = fullAddress;
  if (name !== undefined) result.name = name;
  if (title !== undefined) result.title = title;
  if (latitude !== undefined) result.latitude = latitude;
  if (longitude !== undefined) result.longitude = longitude;
  return result;
}

function locationFromData(record: Record<string, unknown>): JobPosting["location"] {
  const locationValue = record.location ?? record.Location ?? record.geoData;
  const location = isRecord(locationValue) ? locationValue : {};
  const result = locationFromRecord(location, record);
  return Object.keys(result).length > 0 ? result : undefined;
}

function locationsFromData(record: Record<string, unknown>): JobLocation[] | undefined {
  if (!Array.isArray(record.defaultLocations)) return undefined;
  const locations = record.defaultLocations
    .filter(isRecord)
    .map((location) => locationFromRecord(location))
    .filter((location) => Object.keys(location).length > 0);
  return locations.length > 0 ? locations : undefined;
}

function mapLocationFromData(record: Record<string, unknown>): JobLocation | undefined {
  if (!isRecord(record.geoData)) return undefined;
  const location = locationFromRecord(record.geoData);
  return Object.keys(location).length > 0 ? location : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(asString).filter((item): item is string => item !== undefined && item.trim() !== "");
  return values.length > 0 ? values : undefined;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return named[lower] ?? entity;
  });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|li|h[1-6]|tr|td|section|label|span)>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const OVERVIEW_LABELS = [
  "Job - Address Line One",
  "Job - Address Line Two",
  "Job - Postal/Zip Code",
  "Application Documents Required",
  "Additional Application Information",
  "Targeted Degrees and Disciplines",
  "Employment Location Arrangement",
  "Work Term Duration",
  "Special Job Requirements",
  "Compensation and Benefits",
  "Application Deadline",
  "Application Method",
  "Job Responsibilities",
  "Required Skills",
  "Job Summary",
  "Number of Job Openings",
  "Work Term",
  "Job Type",
  "Job Title",
  "Level",
  "Region",
  "Job - City",
  "Job - Province/State",
  "Job - Country",
  "Organization",
  "Division",
].sort((left, right) => right.length - left.length);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ParsedPostingOverview {
  text: string;
  fields: Record<string, string>;
  serviceTeam: Array<{ role?: string; name?: string; contact?: string }>;
}

export function parsePostingOverviewHtml(html: string): ParsedPostingOverview {
  const text = htmlToText(html);
  const labelPattern = OVERVIEW_LABELS.map(escapeRegExp).join("|");
  const expression = new RegExp(`(?:^|\\n)[ \t]*(${labelPattern})\\s*:\\s*`, "gi");
  const matches: Array<{ label: string; labelStart: number; valueStart: number }> = [];
  for (const match of text.matchAll(expression)) {
    const label = match[1];
    if (!label || match.index === undefined) continue;
    const labelStart = match.index + match[0].indexOf(label);
    matches.push({ label, labelStart, valueStart: match.index + match[0].length });
  }

  const fields: Record<string, string> = {};
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    if (!current) continue;
    const next = matches[index + 1];
    const value = text.slice(current.valueStart, next?.labelStart ?? text.length).trim();
    if (value) fields[current.label] = value;
  }

  const unlabeledField = "Application Deadline";
  const unlabeledStart = text.search(new RegExp(`\\b${escapeRegExp(unlabeledField)}\\b`, "i"));
  if (unlabeledStart >= 0 && !fields[unlabeledField]) {
    const valueStart = unlabeledStart + unlabeledField.length;
    const stopLabels = [
      "Application Documents Required",
      "Additional Application Information",
      "Application Method",
      "Company Information",
      "SERVICE TEAM",
    ];
    const stopPositions = stopLabels
      .map((label) => text.slice(valueStart).search(new RegExp(`\\b${escapeRegExp(label)}\\b`, "i")))
      .filter((position) => position >= 0)
      .map((position) => valueStart + position);
    const end = stopPositions.length > 0 ? Math.min(...stopPositions) : text.length;
    const value = text.slice(valueStart, end).replace(/^\s*:\s*/, "").trim();
    if (value) fields[unlabeledField] = value;
  }

  const trimFieldAtHeading = (field: string, headings: string[]): void => {
    const value = fields[field];
    if (!value) return;
    const positions = headings
      .map((heading) => value.search(new RegExp(`\\b${escapeRegExp(heading)}\\b`, "i")))
      .filter((position) => position >= 0);
    if (positions.length > 0) fields[field] = value.slice(0, Math.min(...positions)).trim();
  };
  trimFieldAtHeading("Targeted Degrees and Disciplines", ["Application Information", "Application Deadline"]);
  trimFieldAtHeading("Application Method", ["Application Deadline", "Company Information", "SERVICE TEAM"]);

  const targetedLists = [...html.matchAll(/<ul\b[^>]*class=["'][^"']*targetedClusters[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi)];
  const targetedItems = targetedLists.flatMap((list) =>
    [...(list[1] ?? "").matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((item) => htmlToText(item[1] ?? ""))
      .filter((item) => item !== ""),
  );
  if (targetedItems.length > 0) fields["Targeted Degrees and Disciplines"] = targetedItems.join(", ");

  const serviceTeam: ParsedPostingOverview["serviceTeam"] = [];
  const serviceTeamIndex = text.search(/\bSERVICE TEAM\b/i);
  if (serviceTeamIndex >= 0) {
    const serviceText = text.slice(serviceTeamIndex + "SERVICE TEAM".length).trim();
    const contactExpression = /(?:^|\s)([A-Z][A-Z0-9_-]*)\s+([^()]+?)\s*\(([^)]+)\)/g;
    for (const match of serviceText.matchAll(contactExpression)) {
      const role = match[1]?.trim();
      const name = match[2]?.trim();
      const contact = match[3]?.trim();
      if (role || name || contact) {
        const contactValue: ParsedPostingOverview["serviceTeam"][number] = {};
        if (role) contactValue.role = role;
        if (name) contactValue.name = name;
        if (contact) contactValue.contact = contact;
        serviceTeam.push(contactValue);
      }
    }
  }

  return { text, fields, serviceTeam };
}

export function parsePreScreeningHtml(html: string): JobPreScreening {
  const questions: JobPreScreeningQuestion[] = [];
  const spans = [...html.matchAll(/<span\b[^>]*class=["'][^"']*\blabel\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)];
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (!span) continue;
    const question = htmlToText(span[1] ?? "");
    if (!question) continue;
    const start = (span.index ?? 0) + span[0].length;
    const end = spans[index + 1]?.index ?? html.length;
    const section = html.slice(start, end);
    const options = [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((match) => htmlToText(match[1] ?? ""))
      .filter((value) => value !== "");
    questions.push(options.length > 0 ? { question, options } : { question });
  }

  const text = htmlToText(html);
  return text ? { questions, text } : { questions };
}

function splitDocuments(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const documents = value
    .split(/[,;]\s*/)
    .map((document) => document.trim())
    .filter((document) => document !== "");
  return documents.length > 0 ? documents : undefined;
}

function firstUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/https?:\/\/[^\s<)]+/i);
  return match?.[0]?.replace(/[.,;]+$/, "");
}

export function normalizeJobPosting(
  requestedId: string,
  postingData: unknown,
  overview: string | undefined,
  preScreeningHtml: string | undefined,
): JobPosting {
  const data = isRecord(postingData) ? postingData : {};
  const parsedOverview = overview && /<[^>]+>/.test(overview) ? parsePostingOverviewHtml(overview) : undefined;
  const overviewFields = parsedOverview?.fields ?? {};
  const posting: JobPosting = {
    id: firstString(data, ["postingId", "id", "Id"]) ?? requestedId,
  };

  const title = textField(data, ["position", "postingTitle", "jobTitle", "title"]);
  const organization = textField(data, ["organization", "Organization", "org", "employer", "Employer"]);
  const division = textField(data, ["division", "Division", "div"]);
  if (title !== undefined) posting.title = title;
  if (organization !== undefined) posting.organization = organization;
  if (division !== undefined) posting.division = division;

  const location = locationFromData(data);
  if (location !== undefined) posting.location = location;
  const locations = locationsFromData(data);
  if (locations !== undefined) posting.locations = locations;
  const mapLocation = mapLocationFromData(data);
  if (mapLocation !== undefined) posting.mapLocation = mapLocation;
  const openings = firstNumber(data, ["openings", "Openings", "numberOfPositions", "NumberOfPositions"]);
  const applicationCount = firstNumber(data, ["applicationCount", "ApplicationCount"]);
  const deadline = textField(data, ["deadline", "Deadline", "applicationDeadline"]) ?? overviewFields["Application Deadline"];
  const deadlineDisplay = textField(data, ["Deadline"]) ?? overviewFields["Application Deadline"];
  const normalizedDeadline = deadline ? singleLine(deadline) : undefined;
  const normalizedDeadlineDisplay = deadlineDisplay ? singleLine(deadlineDisplay) : undefined;
  if (openings !== undefined) posting.openings = openings;
  if (applicationCount !== undefined) posting.applicationCount = applicationCount;
  if (normalizedDeadline !== undefined) posting.deadline = normalizedDeadline;
  if (normalizedDeadlineDisplay !== undefined) posting.deadlineDisplay = normalizedDeadlineDisplay;

  const divisionId = firstString(data, ["divId", "divisionId"]);
  const status = firstString(data, ["status"]);
  const internalStatus = firstString(data, ["internalStatus"]);
  const tags = stringArray(data.tags ?? data.Tags);
  const hasPreScreening = asBoolean(data.hasPreScreening);
  if (divisionId !== undefined) posting.divisionId = divisionId;
  if (status !== undefined) posting.status = status;
  if (internalStatus !== undefined) posting.internalStatus = internalStatus;
  if (tags !== undefined) posting.tags = tags;
  if (hasPreScreening !== undefined) posting.hasPreScreening = hasPreScreening;

  const description =
    textField(data, ["description", "Description", "overview", "Overview"]) ??
    (parsedOverview && Object.keys(overviewFields).length > 0 ? parsedOverview.text : undefined) ??
    overview;
  const summary = textField(data, ["summary", "jobSummary", "JobSummary"]) ?? overviewFields["Job Summary"];
  const responsibilities =
    textField(data, ["responsibilities", "Responsibilities", "duties", "Duties"]) ??
    overviewFields["Job Responsibilities"];
  const qualifications =
    textField(data, ["qualifications", "Qualifications", "requirements", "Requirements"]) ??
    overviewFields.Qualifications;
  const skills =
    stringArray(data.skills ?? data.Skills);
  const requiredSkills = overviewFields["Required Skills"];
  const compensation =
    textField(data, ["compensation", "Compensation", "salary", "Salary"]) ??
    overviewFields["Compensation and Benefits"];
  const workTerm = textField(data, ["workTerm", "WorkTerm", "term", "Term"]) ?? overviewFields["Work Term"];
  const jobType = textField(data, ["jobType", "JobType"]) ?? overviewFields["Job Type"];
  const level = textField(data, ["level", "Level"]) ?? overviewFields.Level;
  const region = textField(data, ["region", "Region"]) ?? overviewFields.Region;
  const workArrangement =
    textField(data, ["workArrangement", "employmentLocationArrangement"]) ??
    overviewFields["Employment Location Arrangement"];
  const workTermDuration =
    textField(data, ["workTermDuration", "duration"]) ?? overviewFields["Work Term Duration"];
  const specialRequirements =
    textField(data, ["specialRequirements", "requirements"]) ?? overviewFields["Special Job Requirements"];
  const targetedDegreesAndDisciplines =
    textField(data, ["targetedDegreesAndDisciplines", "targetedDegrees", "targetedDisciplines"]) ??
    overviewFields["Targeted Degrees and Disciplines"];
  const applicationInstructions = textField(data, [
    "applicationInstructions",
    "ApplicationInstructions",
    "howToApply",
    "HowToApply",
  ]);
  const applicationData = isRecord(data.applicationData) ? data.applicationData : {};
  const canApply = asBoolean(data.canApply) ?? asBoolean(applicationData.canApply);
  const hasApplication = asBoolean(data.hasApplication) ?? asBoolean(applicationData.hasApplication);
  const canCancelApplication =
    asBoolean(data.canCancelApplication) ?? asBoolean(applicationData.canCancelApplication);
  const applicationWebsite =
    firstString(data, ["applicationWebsite", "website"]) ??
    firstString(applicationData, ["website"]) ??
    firstUrl(overviewFields["Additional Application Information"]);
  const buttonLabel = firstString(applicationData, ["buttonLabel"]);
  const applicationMethod = overviewFields["Application Method"] ? singleLine(overviewFields["Application Method"]) : undefined;
  const requiredDocuments = splitDocuments(overviewFields["Application Documents Required"]);
  const additionalInformation = overviewFields["Additional Application Information"];
  if (description !== undefined) posting.description = description;
  if (summary !== undefined) posting.summary = summary;
  if (responsibilities !== undefined) posting.responsibilities = responsibilities;
  if (qualifications !== undefined) posting.qualifications = qualifications;
  if (compensation !== undefined) posting.compensation = compensation;
  if (workTerm !== undefined) posting.workTerm = workTerm;
  if (jobType !== undefined) posting.jobType = jobType;
  if (level !== undefined) posting.level = level;
  if (region !== undefined) posting.region = region;
  if (workArrangement !== undefined) posting.workArrangement = workArrangement;
  if (workTermDuration !== undefined) posting.workTermDuration = workTermDuration;
  if (specialRequirements !== undefined) posting.specialRequirements = specialRequirements;
  if (targetedDegreesAndDisciplines !== undefined) posting.targetedDegreesAndDisciplines = targetedDegreesAndDisciplines;
  if (applicationInstructions !== undefined) posting.applicationInstructions = applicationInstructions;
  if (skills !== undefined) posting.skills = skills;
  if (requiredSkills !== undefined) posting.requiredSkills = requiredSkills;
  if (canApply !== undefined) posting.canApply = canApply;
  if (hasApplication !== undefined) posting.hasApplication = hasApplication;
  if (canCancelApplication !== undefined) posting.canCancelApplication = canCancelApplication;
  if (applicationWebsite !== undefined) posting.applicationWebsite = applicationWebsite;
  if (parsedOverview?.serviceTeam && parsedOverview.serviceTeam.length > 0) posting.serviceTeam = parsedOverview.serviceTeam;
  if (preScreeningHtml !== undefined) {
    const parsedPreScreening = parsePreScreeningHtml(preScreeningHtml);
    if (parsedPreScreening.text !== undefined || parsedPreScreening.questions.length > 0) {
      posting.preScreening = parsedPreScreening;
    }
  }

  const application: JobPostingApplication = {};
  if (canApply !== undefined) application.canApply = canApply;
  if (hasApplication !== undefined) application.hasApplication = hasApplication;
  if (canCancelApplication !== undefined) application.canCancelApplication = canCancelApplication;
  if (buttonLabel !== undefined) application.buttonLabel = buttonLabel;
  if (applicationMethod !== undefined) application.method = applicationMethod;
  if (applicationWebsite !== undefined) application.website = applicationWebsite;
  if (normalizedDeadlineDisplay !== undefined) application.deadline = normalizedDeadlineDisplay;
  if (requiredDocuments !== undefined) application.requiredDocuments = requiredDocuments;
  if (additionalInformation !== undefined) application.additionalInformation = additionalInformation;
  if (Object.keys(application).length > 0) posting.application = application;

  const raw: Record<string, unknown> = { postingData };
  if (overview !== undefined) raw.overview = overview;
  if (preScreeningHtml !== undefined) raw.preScreening = preScreeningHtml;
  posting.raw = raw;
  return posting;
}

export function normalizeDocumentMetadata(raw: unknown): WaterlooWorksDocumentMetadata {
  if (!isRecord(raw)) throw new ProtocolChangedError("Document metadata response is not an object");

  const docTypes: WaterlooWorksDocumentMetadata["docTypes"] = {};
  if (isRecord(raw.docTypes)) {
    for (const [key, value] of Object.entries(raw.docTypes)) {
      if (!isRecord(value)) continue;
      const docType: WaterlooWorksDocumentMetadata["docTypes"][string] = {};
      const id = asString(value.id) ?? key;
      const name = asString(value.name);
      const maxDefault = asNumber(value.maxDefault);
      if (id !== undefined) docType.id = id;
      if (name !== undefined) docType.name = name;
      if (maxDefault !== undefined) docType.maxDefault = maxDefault;
      docTypes[key] = docType;
    }
  }

  const defaultDocMap: Record<string, unknown[]> = {};
  if (isRecord(raw.defaultDocMap)) {
    for (const [key, value] of Object.entries(raw.defaultDocMap)) {
      defaultDocMap[key] = Array.isArray(value) ? value : [];
    }
  }

  const specialDocs: Record<string, Record<string, unknown>> = {};
  if (isRecord(raw.specialDocs)) {
    for (const [key, value] of Object.entries(raw.specialDocs)) {
      if (isRecord(value)) specialDocs[key] = { ...value };
    }
  }

  const result: WaterlooWorksDocumentMetadata = {
    docTypes,
    defaultDocMap,
    specialDocs,
  };
  const defaultPackageEnabled = asBoolean(raw.defaultPackageEnabled);
  if (defaultPackageEnabled !== undefined) result.defaultPackageEnabled = defaultPackageEnabled;
  if (isRecord(raw.defaultPkg)) result.defaultPackage = { ...raw.defaultPkg };
  const documentModuleUrl = firstString(raw, ["docModuleSe", "documentModuleUrl"]);
  if (documentModuleUrl !== undefined) result.documentModuleUrl = documentModuleUrl;
  return result;
}

function normalizeReportValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key === "y") {
      const numeric = asNumber(value);
      if (numeric !== undefined) return numeric;
    }
    return key === "title" || key === "description" || key === "value" || key === "page"
      ? htmlToText(value)
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeReportValue(item, key));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = normalizeReportValue(childValue, childKey);
    }
    return result;
  }
  return value;
}

function normalizeReportTable(section: Record<string, unknown>): WaterlooWorksReportTable | undefined {
  if (section.type !== "table" || !Array.isArray(section.columns) || !Array.isArray(section.rows)) return undefined;

  const columns = section.columns.map((column) => asString(column) ?? "");
  const rows = section.rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      row.map((value, index) => {
        const normalized = normalizeReportValue(value);
        if (index >= 2 && typeof normalized === "string") return asNumber(normalized) ?? normalized;
        return normalized;
      }),
    );
  const table: WaterlooWorksReportTable = { type: "table", columns, rows };
  const title = asString(section.title);
  const description = asString(section.description);
  if (title !== undefined) table.title = title;
  if (description !== undefined) table.description = description;
  return table;
}

function normalizeReportChart(section: Record<string, unknown>): WaterlooWorksReportChart | undefined {
  const type = asString(section.type);
  if (type === undefined || !/chart$/i.test(type)) return undefined;

  const chart: WaterlooWorksReportChart = { type };
  const title = asString(section.title);
  const description = asString(section.description);
  const width = typeof section.width === "string" || typeof section.width === "number" ? section.width : undefined;
  const decimalPlaces = asNumber(section.decimalPlaces);
  const valueSuffix = asString(section.valueSuffix);
  const legend = asString(section.legend);
  if (title !== undefined) chart.title = title;
  if (description !== undefined) chart.description = description;
  if (width !== undefined) chart.width = width;
  if (decimalPlaces !== undefined) chart.decimalPlaces = decimalPlaces;
  if (valueSuffix !== undefined) chart.valueSuffix = valueSuffix;
  if (legend !== undefined) chart.legend = legend;
  if (Array.isArray(section.data)) chart.data = section.data;
  if (Array.isArray(section.series)) chart.series = section.series;
  if (Array.isArray(section.categories)) {
    chart.categories = section.categories.map((category) => asString(category) ?? "");
  }
  return chart;
}

export function normalizeEmployerReport(raw: unknown): WaterlooWorksEmployerReport {
  if (!isRecord(raw)) throw new ProtocolChangedError("Employer report response is not an object");
  if (!Array.isArray(raw.sections)) {
    // WaterlooWorks uses this marker for employers with no hiring-history or
    // work-term-ratings report. It is a valid no-data response, not a
    // protocol error, and is common for employers with no prior co-op hires.
    if ("missingReportStructure" in raw) {
      return { sections: [], reportAvailable: false };
    }
    throw new ProtocolChangedError("Employer report response is missing sections");
  }

  const sections = raw.sections
    .filter(isRecord)
    .map((section) => normalizeReportValue(section) as Record<string, unknown>);
  const result: WaterlooWorksEmployerReport = {
    reportAvailable: true,
    sections: sections as WaterlooWorksEmployerReport["sections"],
  };
  const title = asString(raw.page);
  if (title !== undefined) result.title = htmlToText(title);
  const organization = sections
    .find((section) => section.type === "text" && typeof section.value === "string" && /^Organization:/i.test(section.value as string));
  const division = sections
    .find((section) => section.type === "text" && typeof section.value === "string" && /^Division:/i.test(section.value as string));
  if (organization && typeof organization.value === "string") result.organization = organization.value.replace(/^Organization:\s*/i, "");
  if (division && typeof division.value === "string") result.division = division.value.replace(/^Division:\s*/i, "");

  const tables = sections
    .map(normalizeReportTable)
    .filter((table): table is WaterlooWorksReportTable => table !== undefined);
  const charts = sections
    .map(normalizeReportChart)
    .filter((chart): chart is WaterlooWorksReportChart => chart !== undefined);
  const hiringHistory =
    tables.find((table) => /hiring history/i.test(table.title ?? "")) ?? (tables.length === 1 ? tables[0] : undefined);
  if (hiringHistory !== undefined || charts.length > 0) {
    const analytics: WaterlooWorksEmployerReportAnalytics = { charts };
    if (hiringHistory !== undefined) analytics.hiringHistory = hiringHistory;
    const workTermRatingsSummary = tables.find((table) => /work term ratings summary/i.test(table.title ?? ""));
    if (workTermRatingsSummary !== undefined) analytics.workTermRatingsSummary = workTermRatingsSummary;
    const hiresByFaculty = charts.find((chart) => /hires by faculty/i.test(chart.title ?? ""));
    const hiresByStudentWorkTermNumber = charts.find((chart) => /hires by student work term number/i.test(chart.title ?? ""));
    const mostFrequentlyHiredPrograms = charts.find((chart) => /most frequently hired programs/i.test(chart.title ?? ""));
    const overallWorkTermSatisfaction = charts.find((chart) => /overall work term satisfaction/i.test(chart.title ?? ""));
    const averageRatingByQuestion = charts.find((chart) => /average rating by question/i.test(chart.title ?? ""));
    if (hiresByFaculty !== undefined) analytics.hiresByFaculty = hiresByFaculty;
    if (hiresByStudentWorkTermNumber !== undefined) analytics.hiresByStudentWorkTermNumber = hiresByStudentWorkTermNumber;
    if (mostFrequentlyHiredPrograms !== undefined) analytics.mostFrequentlyHiredPrograms = mostFrequentlyHiredPrograms;
    if (overallWorkTermSatisfaction !== undefined) analytics.overallWorkTermSatisfaction = overallWorkTermSatisfaction;
    if (averageRatingByQuestion !== undefined) analytics.averageRatingByQuestion = averageRatingByQuestion;
    result.analytics = analytics;
  }
  return result;
}
