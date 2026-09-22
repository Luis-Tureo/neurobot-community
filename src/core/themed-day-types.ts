export type ThemedDayWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type ThemedDayConfiguration = {
  weekday: ThemedDayWeekday;
  enabled: boolean;
  name: string;
  description: string;
  publishTime: string;
  startTime: string;
  endTime: string;
  timezone: string;
};

export type ThemedDayDeliveryStatus = 'pending' | 'sent' | 'failed';

export type ThemedDayDeliveryRecord = {
  botId: string;
  weekday: ThemedDayWeekday;
  localDate: string;
  status: ThemedDayDeliveryStatus;
  attempts: number;
  errorCode: string | null;
  sentAt: string | null;
};
