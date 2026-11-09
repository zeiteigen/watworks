/** A missing fact written as `questionId: note` belongs to that form question, which answers it. */
export function factQuestionId(fact: string, questionIds: ReadonlySet<string>): string | undefined {
  const id = /^\s*([^\s:]+)\s*:\s*\S/.exec(fact)?.[1];
  return id !== undefined && questionIds.has(id) ? id : undefined;
}
