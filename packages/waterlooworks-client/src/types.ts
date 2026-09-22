import type { JobColumn, JobFilter, JobSort } from "./bootstrap.js";

export interface JobSearchQuery {
  keyword?: string;
  filters?: Record<string, unknown> | null;
  sort?: JobSort[];
}

export interface JobTitleFlags {
  isNew?: boolean;
  featured?: boolean;
  applied?: boolean;
  viewed?: boolean;
}

export interface JobSearchItem {
  id: string;
  title?: string;
  titleFlags?: JobTitleFlags;
  organization?: string;
  division?: string;
  openings?: number;
  city?: string;
  level?: string;
  applicationCount?: number;
  deadline?: string;
  deadlineDisplay?: string;
  canApply?: boolean;
  hasApplication?: boolean;
  online?: boolean;
  apply?: boolean;
  attributes?: Record<string, unknown>;
  raw?: unknown;
}

export interface JobSearchResult {
  items: JobSearchItem[];
  total: number;
  raw?: unknown;
}

export interface JobLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  addressLineOne?: string;
  addressLineTwo?: string;
  postalCode?: string;
  fullAddress?: string;
  name?: string;
  title?: string;
  latitude?: number;
  longitude?: number;
}

export interface JobPostingApplication {
  canApply?: boolean;
  hasApplication?: boolean;
  canCancelApplication?: boolean;
  buttonLabel?: string;
  method?: string;
  website?: string;
  deadline?: string;
  requiredDocuments?: string[];
  additionalInformation?: string;
}

export interface JobPreScreeningQuestion {
  question: string;
  options?: string[];
}

export interface JobPreScreening {
  questions: JobPreScreeningQuestion[];
  text?: string;
}

export interface JobServiceTeamContact {
  role?: string;
  name?: string;
  contact?: string;
}

export interface JobPosting {
  id: string;
  title?: string;
  organization?: string;
  division?: string;
  divisionId?: string;
  status?: string;
  internalStatus?: string;
  tags?: string[];
  hasPreScreening?: boolean;
  location?: JobLocation;
  locations?: JobLocation[];
  mapLocation?: JobLocation;
  openings?: number;
  applicationCount?: number;
  deadline?: string;
  deadlineDisplay?: string;
  workTerm?: string;
  jobType?: string;
  level?: string;
  region?: string;
  workArrangement?: string;
  workTermDuration?: string;
  specialRequirements?: string;
  description?: string;
  summary?: string;
  responsibilities?: string;
  qualifications?: string;
  skills?: string[];
  requiredSkills?: string;
  targetedDegreesAndDisciplines?: string;
  compensation?: string;
  applicationInstructions?: string;
  application?: JobPostingApplication;
  canApply?: boolean;
  hasApplication?: boolean;
  canCancelApplication?: boolean;
  applicationWebsite?: string;
  preScreening?: JobPreScreening;
  serviceTeam?: JobServiceTeamContact[];
  raw?: unknown;
}

export interface JobSearchMetadata {
  columns: JobColumn[];
  sort: JobSort[];
  filters: JobFilter[];
  savedFilters: unknown[];
}

export interface WaterlooWorksFolder {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface WaterlooWorksAccountOverview {
  folders: WaterlooWorksFolder[];
  folderCounts: Record<string, number>;
  postingsInFolders: Record<string, unknown>;
  blacklistedPostings: unknown[];
  applicationCount?: number;
}

export interface WaterlooWorksDocumentType {
  id?: string;
  name?: string;
  maxDefault?: number;
}

export interface WaterlooWorksDocumentMetadata {
  docTypes: Record<string, WaterlooWorksDocumentType>;
  defaultDocMap: Record<string, unknown[]>;
  defaultPackageEnabled?: boolean;
  defaultPackage?: Record<string, unknown>;
  specialDocs: Record<string, Record<string, unknown>>;
  documentModuleUrl?: string;
}

export interface WaterlooWorksReportSection {
  type?: string;
  title?: string;
  [key: string]: unknown;
}

export interface WaterlooWorksReportTable {
  type: "table";
  title?: string;
  description?: string;
  columns: string[];
  rows: unknown[][];
}

export interface WaterlooWorksReportChart {
  type: "pieChart" | "barChart" | string;
  title?: string;
  description?: string;
  width?: string | number;
  decimalPlaces?: number;
  valueSuffix?: string;
  legend?: string;
  data?: unknown[];
  series?: unknown[];
  categories?: string[];
}

export interface WaterlooWorksEmployerReportAnalytics {
  hiringHistory?: WaterlooWorksReportTable;
  workTermRatingsSummary?: WaterlooWorksReportTable;
  hiresByFaculty?: WaterlooWorksReportChart;
  hiresByStudentWorkTermNumber?: WaterlooWorksReportChart;
  mostFrequentlyHiredPrograms?: WaterlooWorksReportChart;
  overallWorkTermSatisfaction?: WaterlooWorksReportChart;
  averageRatingByQuestion?: WaterlooWorksReportChart;
  charts: WaterlooWorksReportChart[];
}

export interface WaterlooWorksEmployerReport {
  title?: string;
  organization?: string;
  division?: string;
  /** False when WaterlooWorks has no report structure for this employer. */
  reportAvailable: boolean;
  sections: WaterlooWorksReportSection[];
  analytics?: WaterlooWorksEmployerReportAnalytics;
}

export interface WaterlooWorksHealth {
  authenticated: boolean;
  bridgeConnected: boolean;
  bootstrapped: boolean;
  error?: string;
}

export interface GetJobOptions {
  includePreScreening?: boolean;
}
