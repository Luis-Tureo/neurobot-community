import type { ThemedDayService } from './themed-day-service.js';

const services = new Map<string, ThemedDayService>();

export function registerThemedDayService(botId: string, service: ThemedDayService): void {
  services.set(botId, service);
}

export function unregisterThemedDayService(botId: string, service?: ThemedDayService): void {
  const current = services.get(botId);
  if (service !== undefined && current !== service) return;
  services.delete(botId);
}

export function getThemedDayService(botId: string): ThemedDayService | null {
  return services.get(botId) ?? null;
}
