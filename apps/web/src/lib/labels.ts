import type { ClientStatus } from '@rep/shared';

export const CLIENT_STATUS: Record<
  ClientStatus,
  { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' }
> = {
  onboarding: { label: 'Alta en curso', tone: 'accent' },
  active: { label: 'Activo', tone: 'success' },
  paused: { label: 'En pausa', tone: 'warning' },
  archived: { label: 'Archivado', tone: 'neutral' },
};

export const MEMBER_STATUS = {
  invited: { label: 'Invitado', tone: 'accent' },
  active: { label: 'Activo', tone: 'success' },
  suspended: { label: 'Suspendido', tone: 'danger' },
} as const;

export const LANGUAGES = [
  { value: 'es', label: 'Español' },
  { value: 'ca', label: 'Català' },
  { value: 'gl', label: 'Galego' },
  { value: 'eu', label: 'Euskara' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'pt', label: 'Português' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
];

export const TIMEZONES = [
  'Europe/Madrid',
  'Atlantic/Canary',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Paris',
  'America/Mexico_City',
  'America/Bogota',
  'America/Argentina/Buenos_Aires',
  'UTC',
];
