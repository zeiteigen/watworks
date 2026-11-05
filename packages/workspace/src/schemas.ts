import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Use lowercase letters, digits, and hyphens");
const line = z.string().trim().min(1).max(300);
const optionalLine = z.string().trim().max(300).optional();
const bullet = z.string().trim().min(1).max(600);

export const ProfileSchema = z.object({
  version: z.literal(1).default(1),
  name: line,
  email: z.string().email(),
  phone: optionalLine,
  location: optionalLine,
  links: z.array(z.object({ label: line, url: z.string().url() }).strict()).max(8).default([]),
  education: z.array(z.object({
    institution: line, program: line, location: optionalLine, start: optionalLine, end: optionalLine,
    term: optionalLine.describe("Current academic term, for example 3A"),
  }).strict()).default([]),
  workAuthorization: z.object({
    canada: z.enum(["citizen", "permanent_resident", "study_permit", "work_permit", "none"]),
    unitedStates: z.enum(["citizen", "permanent_resident", "visa_holder", "none"]),
    needsSponsorship: z.object({ canada: z.boolean(), unitedStates: z.boolean() }).strict(),
    otherCountries: z.array(line).default([]),
    notes: z.string().max(2000).optional(),
  }).strict(),
  targets: z.array(z.object({
    id: slug,
    label: line,
    keywords: z.array(line).min(1).max(20),
    resumeVariant: slug,
    notes: z.string().max(2000).optional(),
  }).strict()).min(1).max(20),
  preferences: z.object({
    locations: z.array(line).default([]),
    arrangements: z.array(z.enum(["on_site", "hybrid", "remote"])).default([]),
    terms: z.array(line).default([]),
    minHourlyPay: z.number().positive().optional(),
    avoid: z.array(line).default([]).describe("Employers or keywords to skip"),
    notes: z.string().max(2000).optional(),
  }).strict().default({}),
  /** Reusable answers to common pre-screening questions; never invented by agents. */
  standardAnswers: z.array(z.object({ question: z.string().trim().min(1).max(1000), answer: z.string().trim().min(1).max(5000) }).strict()).max(100).default([]),
}).strict();
export type Profile = z.infer<typeof ProfileSchema>;

const resumeContact = z.object({ text: line, url: z.string().max(500).optional() }).strict();
const datedEntry = { dates: optionalLine, location: optionalLine, bullets: z.array(bullet).max(12).default([]) };

export const ResumeSectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("education"), title: line.default("Education"), entries: z.array(z.object({ institution: line, degree: line, ...datedEntry }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal("experience"), title: line.default("Experience"), entries: z.array(z.object({ role: line, organization: line, ...datedEntry }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal("projects"), title: line.default("Projects"), entries: z.array(z.object({ name: line, technologies: optionalLine, url: z.string().max(500).optional(), ...datedEntry }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal("skills"), title: line.default("Technical Skills"), groups: z.array(z.object({ label: line, items: z.array(line).min(1) }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal("list"), title: line, items: z.array(bullet).min(1) }).strict(),
]);

/**
 * Structured resume content rendered through data/templates/resume.tex.
 * Bullets may use **bold** for emphasis; everything else is escaped.
 */
export const ResumeDocumentSchema = z.object({
  heading: z.object({ name: line, contacts: z.array(resumeContact).max(8).default([]) }).strict(),
  sections: z.array(ResumeSectionSchema).min(1).max(10),
}).strict();
export type ResumeDocument = z.infer<typeof ResumeDocumentSchema>;
export type ResumeSection = z.infer<typeof ResumeSectionSchema>;

export const ResumeVariantSchema = z.object({
  variant: slug,
  label: line,
  targets: z.array(slug).default([]),
  updatedAt: z.string(),
  resume: ResumeDocumentSchema,
}).strict();
export type ResumeVariant = z.infer<typeof ResumeVariantSchema>;

export const ResumeUploadsSchema = z.object({
  uploads: z.array(z.object({ source: slug, sha256: z.string().regex(/^[a-f0-9]{64}$/), documentId: z.string().min(1), name: line, uploadedAt: z.string() }).strict()).default([]),
}).strict();
export type ResumeUploads = z.infer<typeof ResumeUploadsSchema>;

export const CoverLetterSchema = z.object({
  date: optionalLine,
  recipient: z.object({ name: optionalLine, title: optionalLine, company: line, addressLines: z.array(line).max(4).default([]) }).strict(),
  greeting: line.default("Dear Hiring Manager,"),
  paragraphs: z.array(z.string().trim().min(1).max(3000)).min(1).max(8),
  closing: line.default("Sincerely,"),
}).strict();
export type CoverLetter = z.infer<typeof CoverLetterSchema>;

/** Any other job-specific document: project summary, writing sample, portfolio notes, statement of interest. */
export const JobDocumentSchema = z.object({
  title: line,
  subtitle: optionalLine,
  sections: z.array(z.object({
    heading: optionalLine,
    paragraphs: z.array(z.string().trim().min(1).max(5000)).max(20).default([]),
    bullets: z.array(bullet).max(30).default([]),
  }).strict().refine(section => section.paragraphs.length || section.bullets.length, "A section needs paragraphs or bullets")).min(1).max(20),
}).strict();
export type JobDocument = z.infer<typeof JobDocumentSchema>;

export const JobSummarySchema = z.object({
  source: slug,
  jobId: z.string(),
  title: z.string(),
  employer: z.string(),
  location: z.string().optional(),
  deadline: z.string().optional(),
  term: z.string().optional(),
  arrangement: z.string().optional(),
  compensation: z.string().optional(),
  hasApplication: z.boolean().optional(),
  requiredDocuments: z.array(z.string()).default([]),
}).strict();
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const StoredPostingSchema = z.object({
  savedAt: z.string(),
  summary: JobSummarySchema,
  posting: z.record(z.unknown()),
}).strict();
export type StoredPosting = z.infer<typeof StoredPostingSchema>;

const answerValue = z.union([z.string().max(20_000), z.boolean(), z.number().finite(), z.array(z.string().max(1000)).max(100)]);

export const ApplicationPlanSchema = z.object({
  resumeVariant: slug,
  /** Attachment slots filled with generated or user-supplied PDFs. */
  attachments: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cover_letter"), requirementId: z.string().min(1).max(128) }).strict(),
    z.object({ kind: z.literal("document"), requirementId: z.string().min(1).max(128), document: slug }).strict(),
    z.object({ kind: z.literal("file"), requirementId: z.string().min(1).max(128), path: z.string().min(1).max(4096) }).strict(),
  ])).max(8).default([]),
  answers: z.array(z.object({ questionId: z.string().min(1).max(200), value: answerValue }).strict()).max(200).default([]),
  rank: z.number().int().positive().optional(),
  fit: z.string().trim().min(1).max(2000),
  caveats: z.array(z.string().max(500)).max(10).default([]),
}).strict();
export type ApplicationPlan = z.infer<typeof ApplicationPlanSchema>;

export const JOB_STATES = ["found", "planned", "ready", "skipped", "applying", "confirm_required", "form_filled", "applied", "failed", "outcome_unknown"] as const;
export type JobState = typeof JOB_STATES[number];

export const JobStatusSchema = z.object({
  removedFromQueueAt: z.string().datetime().optional(),
  state: z.enum(JOB_STATES),
  updatedAt: z.string(),
  reason: z.string().max(2000).optional(),
  blockers: z.array(z.string()).default([]),
  applicationId: z.string().optional(),
  externalSteps: z.array(z.string()).default([]),
}).strict();
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const SearchRecordSchema = z.object({
  at: z.string(),
  source: slug,
  query: z.object({ keyword: z.string().optional(), filters: z.record(z.unknown()).nullable().optional() }).strict(),
  total: z.number().int().nonnegative(),
  results: z.array(JobSummarySchema),
}).strict();
export type SearchRecord = z.infer<typeof SearchRecordSchema>;
