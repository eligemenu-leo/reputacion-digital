/** Fechas: se almacenan en UTC y se presentan en la zona horaria del usuario/cliente. */
export function formatInTimeZone(
  isoUtc: string | Date,
  timeZone: string,
  locale = 'es-ES',
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const d = typeof isoUtc === 'string' ? new Date(isoUtc) : isoUtc;
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(d);
}
