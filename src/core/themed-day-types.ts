export const THEMED_DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type ThemedDayKey = (typeof THEMED_DAY_KEYS)[number];

export type ThemedDaySettings = {
  key: ThemedDayKey;
  enabled: boolean;
  startTime: string;
  title: string;
  description: string;
  imagePath: string | null;
};

export type ThemedDaysConfiguration = {
  timezone: string;
  groupKeys: string[];
  days: ThemedDaySettings[];
};

export type ThemedDayDelivery = {
  dayKey: string;
  groupKey: string;
  localDate: string;
  status: string;
  attempts: number;
  errorCode: string | null;
  sentAt: string | null;
};

export type ThemedDaysRunSummary = {
  due: boolean;
  sent: number;
  failed: number;
  skipped: number;
};

export const THEMED_DAY_WEEKDAYS: Record<
  ThemedDayKey,
  'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};
