export function formatInsightDate(dateOrIso: string | Date | number): string {
  return new Date(dateOrIso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
