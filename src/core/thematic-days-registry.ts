import type { ThematicDaysService } from './thematic-days-service.js';

const services = new Map<string, ThematicDaysService>();

export function registerThematicDaysService(botId: string, service: ThematicDaysService): void {
  services.set(botId, service);
}

export function unregisterThematicDaysService(botId: string, service?: ThematicDaysService): void {
  const current = services.get(botId);
  if (service !== undefined && current !== service) return;
  services.delete(botId);
}

export function getThematicDaysService(botId: string): ThematicDaysService | null {
  return services.get(botId) ?? null;
}
