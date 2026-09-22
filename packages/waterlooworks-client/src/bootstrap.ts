import { ProtocolChangedError } from "./errors.js";

export interface JobColumn {
  title: string;
  key: string;
  isId: boolean;
  sortable: boolean;
  visible: boolean;
  tableColWidth?: number;
  /** JSON-visible portion of a page-defined DataViewer visualizer. */
  dataVisualizer?: Record<string, unknown>;
}

export interface JobSort {
  key: string;
  direction: string;
}

export interface JobFilterOption {
  value: string;
  label: string;
}

export interface JobFilter {
  key: string;
  label: string;
  type: string;
  advanced: boolean;
  quick: boolean;
  hidden: boolean;
  singleValue?: boolean;
  optionsFilter?: boolean;
  options?: JobFilterOption[];
}

export interface PostingActions {
  data?: string;
  overview?: string;
  preScreening?: string;
}

export interface AccountActions {
  folders?: string;
  postingsInFolders?: string;
  blacklistedPostings?: string;
  folderCounts?: string;
  stats?: string;
  defaultDocuments?: string;
}

export interface BootstrapPage {
  jobsAction: string;
  columns: JobColumn[];
  sort: JobSort[];
  postingActions: PostingActions;
  accountActions: AccountActions;
  employerReportAction?: string;
  defaultSelectedTerm?: string;
  filters: JobFilter[];
  savedFilters: unknown[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatchingDelimiter(source: string, start: number, open: string, close: string): number {
  if (source[start] !== open) throw new ProtocolChangedError(`Expected ${open} while parsing bootstrap JavaScript`);

  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new ProtocolChangedError(`Unterminated ${open}${close} structure in jobs page`);
}

/** Parse the small JSON-like literals embedded in the jobs page safely. */
function parseLiteral(source: string): unknown {
  let index = 0;

  function skipWhitespace(): void {
    while (/\s/.test(source[index] ?? "")) index += 1;
  }

  function parseString(): string {
    const quote = source[index];
    if (quote !== "'" && quote !== '"' && quote !== "`") {
      throw new Error("Expected a string literal");
    }
    index += 1;
    let value = "";
    while (index < source.length) {
      const character = source[index] ?? "";
      index += 1;
      if (character === quote) return value;
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escaped = source[index] ?? "";
      index += 1;
      if (escaped === "n") value += "\n";
      else if (escaped === "r") value += "\r";
      else if (escaped === "t") value += "\t";
      else if (escaped === "b") value += "\b";
      else if (escaped === "f") value += "\f";
      else if (escaped === "u") {
        const code = source.slice(index, index + 4);
        if (!/^[0-9a-f]{4}$/i.test(code)) throw new Error("Invalid unicode escape");
        value += String.fromCharCode(Number.parseInt(code, 16));
        index += 4;
      } else value += escaped;
    }
    throw new Error("Unterminated string literal");
  }

  function parseObject(): Record<string, unknown> {
    index += 1;
    const object: Record<string, unknown> = {};
    skipWhitespace();
    if (source[index] === "}") {
      index += 1;
      return object;
    }
    while (index < source.length) {
      skipWhitespace();
      const character = source[index] ?? "";
      const key = character === "'" || character === '"' || character === "`"
        ? parseString()
        : (() => {
            const match = /^[A-Za-z_$][\w$-]*/.exec(source.slice(index));
            if (!match) throw new Error("Invalid object key");
            index += match[0].length;
            return match[0];
          })();
      skipWhitespace();
      if (source[index] !== ":") throw new Error("Expected object key separator");
      index += 1;
      object[key] = parseValue();
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return object;
      }
      if (source[index] !== ",") throw new Error("Expected object entry separator");
      index += 1;
    }
    throw new Error("Unterminated object literal");
  }

  function parseArray(): unknown[] {
    index += 1;
    const array: unknown[] = [];
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return array;
    }
    while (index < source.length) {
      array.push(parseValue());
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return array;
      }
      if (source[index] !== ",") throw new Error("Expected array entry separator");
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return array;
      }
    }
    throw new Error("Unterminated array literal");
  }

  function parseValue(): unknown {
    skipWhitespace();
    const character = source[index] ?? "";
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === "'" || character === '"' || character === "`") return parseString();
    const remainder = source.slice(index);
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (remainder.startsWith(literal)) {
        index += literal.length;
        return value;
      }
    }
    const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(remainder);
    if (number) {
      index += number[0].length;
      return Number(number[0]);
    }
    throw new Error("Unsupported literal");
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== source.length) throw new Error("Unexpected trailing literal content");
  return value;
}

function extractBalancedAfter(source: string, marker: string, open: string, close: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new ProtocolChangedError(`Could not locate ${marker} in jobs page`);
  const start = source.indexOf(open, markerIndex + marker.length);
  if (start < 0) throw new ProtocolChangedError(`Could not locate ${open} after ${marker}`);
  const end = findMatchingDelimiter(source, start, open, close);
  return source.slice(start, end + 1);
}

function extractStringProperty(source: string, property: string): string | undefined {
  const expression = new RegExp(
    `(?:^|[,\\n{])\\s*${escapeRegex(property)}\\s*:\\s*(["'])([\\s\\S]*?)\\1`,
  );
  const match = expression.exec(source);
  const value = match?.[2];
  if (!value) return undefined;
  return value.replace(/\\(["'\\])/g, "$1");
}

function requireStringProperty(source: string, property: string, context: string): string {
  const value = extractStringProperty(source, property);
  if (!value) throw new ProtocolChangedError(`Could not locate ${property} for ${context}`);
  return value;
}

function extractArrayProperty(source: string, property: string, context: string): unknown[] {
  const expression = new RegExp(`\\b${escapeRegex(property)}\\s*:\\s*`);
  const match = expression.exec(source);
  if (!match || match.index === undefined) {
    throw new ProtocolChangedError(`Could not locate ${property} for ${context}`);
  }
  const start = source.indexOf("[", match.index + match[0].length);
  if (start < 0) throw new ProtocolChangedError(`Could not locate ${property} array for ${context}`);
  const end = findMatchingDelimiter(source, start, "[", "]");
  const literal = source.slice(start, end + 1);
  try {
    const parsed = parseLiteral(literal);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch (error) {
    throw new ProtocolChangedError(`Could not parse ${property} for ${context}`, error);
  }
}

function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const expression = /([:@A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(expression)) {
    const name = match[1];
    if (name) attrs.set(name, match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function attrValue(attrs: Map<string, string>, name: string): string | undefined {
  return attrs.get(name) ?? attrs.get(`:${name}`);
}

function extractNamedObject(source: string, name: string, context: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw new ProtocolChangedError(`Invalid ${context} identifier in jobs page`);
  }
  const marker = new RegExp(`(?:const|let|var)\\s+${escapeRegex(name)}\\s*=`).exec(source);
  if (!marker || marker.index === undefined) {
    throw new ProtocolChangedError(`Could not locate ${context} definition ${name}`);
  }
  const start = source.indexOf("{", marker.index + marker[0].length);
  if (start < 0) throw new ProtocolChangedError(`Could not locate ${context} object ${name}`);
  const end = findMatchingDelimiter(source, start, "{", "}");
  return source.slice(start, end + 1);
}

function parseDataVisualizer(html: string, name: string): Record<string, unknown> {
  const literal = extractNamedObject(html, name, "DataViewer visualizer");
  const template = requireStringProperty(literal, "template", `DataViewer visualizer ${name}`);
  const visualizer: Record<string, unknown> = { template };

  // The supplied page references the shared mixin. Its function-valued
  // members disappear when WaterlooWorks JSON-serializes the columns, leaving
  // the observed { props: {} } shape. Do not execute arbitrary page code.
  const mixinsMatch = /\bmixins\s*:\s*\[/.exec(literal);
  if (mixinsMatch) {
    const start = literal.indexOf("[", mixinsMatch.index + mixinsMatch[0].length - 1);
    if (start < 0) throw new ProtocolChangedError(`Could not parse mixins for DataViewer visualizer ${name}`);
    const end = findMatchingDelimiter(literal, start, "[", "]");
    const mixins = literal.slice(start, end + 1);
    if (!mixins.includes("DataViewerTools.DataVisualizerMixin")) {
      throw new ProtocolChangedError(`Unsupported mixin in DataViewer visualizer ${name}`);
    }
    visualizer.mixins = [{ props: {} }];
  }

  // Computed properties are functions in the page source and therefore become
  // an empty object in the captured JSON request.
  if (/\bcomputed\s*:\s*\{/.test(literal)) visualizer.computed = {};
  return visualizer;
}

function parseColumns(html: string): JobColumn[] {
  const templateStart = html.indexOf('<template id="dataViewer">');
  if (templateStart < 0) throw new ProtocolChangedError("Could not locate the jobs DataViewer template");
  const templateEnd = html.indexOf("</template>", templateStart);
  if (templateEnd < 0) throw new ProtocolChangedError("The jobs DataViewer template is unterminated");
  const template = html.slice(templateStart, templateEnd);
  const columns: JobColumn[] = [];
  const columnExpression = /<data-column\b([^>]*)>/gi;
  for (const match of template.matchAll(columnExpression)) {
    const attrs = parseAttrs(match[1] ?? "");
    const key = attrValue(attrs, "col-key");
    const title = attrValue(attrs, "title");
    if (!key || !title) throw new ProtocolChangedError("A jobs DataViewer column is missing its key or title");

    const column: JobColumn = {
      title,
      key,
      isId: attrValue(attrs, "is-id") === "true",
      sortable: true,
      visible: true,
    };
    const width = attrValue(attrs, "table-col-width");
    if (width) {
      const parsedWidth = Number(width);
      if (Number.isFinite(parsedWidth)) column.tableColWidth = parsedWidth;
    }
    const visualizerName = attrValue(attrs, "data-visualizer");
    if (visualizerName) column.dataVisualizer = parseDataVisualizer(html, visualizerName);
    columns.push(column);
  }

  if (columns.length === 0) throw new ProtocolChangedError("No jobs DataViewer columns were found");
  return columns;
}

function parseFilters(html: string): JobFilter[] {
  const filters: JobFilter[] = [];
  const expression = /<data-filter\b([^>]*)>/gi;
  for (const match of html.matchAll(expression)) {
    const attrs = parseAttrs(match[1] ?? "");
    const key = attrValue(attrs, "filter-key");
    const label = attrValue(attrs, "label");
    const type = attrValue(attrs, "type");
    if (!key || !label || !type) continue;

    const filter: JobFilter = {
      key,
      label,
      type,
      advanced: attrValue(attrs, "is-advanced-filter") === "true",
      quick: attrValue(attrs, "is-quick-filter") === "true",
      hidden: attrValue(attrs, "hidden") === "true",
    };
    const singleValue = attrValue(attrs, "single-value");
    if (singleValue !== undefined) filter.singleValue = singleValue === "true";
    const optionsFilter = attrValue(attrs, "options-filter");
    if (optionsFilter !== undefined) filter.optionsFilter = optionsFilter === "true";

    const optionsLiteral = attrValue(attrs, "options");
    if (optionsLiteral) {
      try {
        const parsed = parseLiteral(optionsLiteral);
        if (Array.isArray(parsed)) {
          const options = parsed
            .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
            .map((item) => ({ value: String(item.value ?? ""), label: String(item.label ?? "") }))
            .filter((item) => item.value !== "" || item.label !== "");
          if (options.length > 0) filter.options = options;
        }
      } catch {
        // Custom filters can contain page JavaScript instead of literal data.
      }
    }
    filters.push(filter);
  }
  return filters;
}

function extractNamedArray(source: string, name: string, context: string): unknown[] | undefined {
  const marker = new RegExp(`(?:const|let|var)\\s+${escapeRegex(name)}\\s*=`).exec(source);
  if (!marker || marker.index === undefined) return undefined;
  const start = source.indexOf("[", marker.index + marker[0].length);
  if (start < 0) throw new ProtocolChangedError(`Could not locate ${context} array`);
  const end = findMatchingDelimiter(source, start, "[", "]");
  const parsed = parseLiteral(source.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new ProtocolChangedError(`${context} is not an array`);
  return parsed;
}

function extractFunctionBody(source: string, functionName: string): string | undefined {
  const marker = `function ${functionName}(`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const bodyStart = source.indexOf("{", markerIndex + marker.length);
  if (bodyStart < 0) throw new ProtocolChangedError(`Function ${functionName} has no body`);
  const bodyEnd = findMatchingDelimiter(source, bodyStart, "{", "}");
  return source.slice(bodyStart, bodyEnd + 1);
}

function extractFunctionAction(source: string, functionName: string): string | undefined {
  const body = extractFunctionBody(source, functionName);
  if (!body) return undefined;
  return extractStringProperty(body, "action");
}

function extractMethodBody(source: string, methodName: string): string | undefined {
  const marker = new RegExp(`(?:^|[,{\\n])\\s*(?:async\\s+)?${escapeRegex(methodName)}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  if (!marker || marker.index === undefined) return undefined;
  const bodyStart = source.indexOf("{", marker.index + marker[0].length - 1);
  if (bodyStart < 0) throw new ProtocolChangedError(`Method ${methodName} has no body`);
  const bodyEnd = findMatchingDelimiter(source, bodyStart, "{", "}");
  return source.slice(bodyStart, bodyEnd + 1);
}

function extractCallableAction(source: string, callableName: string): string | undefined {
  const functionAction = extractFunctionAction(source, callableName);
  if (functionAction) return functionAction;
  const methodBody = extractMethodBody(source, callableName);
  return methodBody ? extractStringProperty(methodBody, "action") : undefined;
}

function requireFunctionAction(source: string, functionName: string): string {
  const action = extractFunctionAction(source, functionName);
  if (!action) throw new ProtocolChangedError(`Could not locate action for ${functionName}`);
  return action;
}

function parseSort(value: unknown[], source: string): JobSort[] {
  const sort: JobSort[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { key?: unknown }).key !== "string" ||
      typeof (item as { direction?: unknown }).direction !== "string"
    ) {
      throw new ProtocolChangedError(`Invalid DataViewer sort in ${source}`);
    }
    sort.push({
      key: (item as { key: string }).key,
      direction: (item as { direction: string }).direction,
    });
  }
  if (sort.length === 0) throw new ProtocolChangedError("The jobs DataViewer supplied no sort definition");
  return sort;
}

export function parseBootstrapPage(html: string): BootstrapPage {
  const propsStart = html.indexOf("const dataViewerProps");
  if (propsStart < 0) throw new ProtocolChangedError("Could not locate jobs DataViewer bootstrap configuration");

  const dataParams = extractBalancedAfter(html.slice(propsStart), "dataParams", "{", "}");
  const jobsAction = requireStringProperty(dataParams, "action", "jobs DataViewer");
  if (!/\bisDataViewer\s*:\s*true\b/.test(dataParams)) {
    throw new ProtocolChangedError("Jobs DataViewer bootstrap is missing isDataViewer=true");
  }

  const propsRegion = html.slice(propsStart, Math.min(html.length, propsStart + 20_000));
  const sort = parseSort(extractArrayProperty(propsRegion, "sort", "jobs DataViewer"), "jobs DataViewer");
  const postingActions: PostingActions = {};
  const dataAction = extractCallableAction(html, "getPostingData");
  const overviewAction = extractCallableAction(html, "getPostingOverview");
  const preScreeningAction = extractCallableAction(html, "getPostingPreScreening");
  if (dataAction) postingActions.data = dataAction;
  if (overviewAction) postingActions.overview = overviewAction;
  if (preScreeningAction) postingActions.preScreening = preScreeningAction;

  const accountActions: AccountActions = {};
  const accountActionNames: Array<[keyof AccountActions, string]> = [
    ["folders", "getFolders"],
    ["postingsInFolders", "getPostingsInFolders"],
    ["blacklistedPostings", "getBlacklistedPostings"],
    ["folderCounts", "getFoldersCounts"],
    ["stats", "getStats"],
    ["defaultDocuments", "getDefaultDocuments"],
  ];
  for (const [key, name] of accountActionNames) {
    const action = extractCallableAction(html, name);
    if (action) accountActions[key] = action;
  }

  let savedFilters: unknown[] = [];
  try {
    savedFilters = extractNamedArray(html, "savedFilterGroups", "saved filter groups") ?? [];
  } catch {
    savedFilters = [];
  }

  const result: BootstrapPage = {
    jobsAction,
    columns: parseColumns(html),
    sort,
    postingActions,
    accountActions,
    filters: parseFilters(html),
    savedFilters,
  };
  const employerReportAction = extractCallableAction(html, "getWorkTermRatingReportJson");
  if (employerReportAction) result.employerReportAction = employerReportAction;
  const statsBody = extractMethodBody(html, "getStats");
  const defaultSelectedTerm = statsBody ? extractStringProperty(statsBody, "selectedTerm") : undefined;
  if (defaultSelectedTerm) result.defaultSelectedTerm = defaultSelectedTerm;
  return result;
}

export function requirePostingAction(
  bootstrap: BootstrapPage,
  kind: keyof PostingActions,
): string {
  const action = bootstrap.postingActions[kind];
  if (!action) throw new ProtocolChangedError(`The bootstrapped page has no posting ${kind} action`);
  return action;
}
