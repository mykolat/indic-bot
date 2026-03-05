/**
 * Extracts the content of the "## External Insights" section from a soul.md string.
 * Returns the trimmed section text, or an empty string if the section is absent.
 */
export function extractExternalInsights(soulContent: string): string {
  const match = soulContent.match(/## External Insights\n([\s\S]*?)(?=\n## |$)/);
  return match?.[1]?.trim() ?? '';
}
