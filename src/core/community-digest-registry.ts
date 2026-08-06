import type { CommunityDigestService } from './community-digest-service.js';

const services = new Map<string, CommunityDigestService>();

export function registerCommunityDigestService(
  botId: string,
  service: CommunityDigestService,
): void {
  services.set(botId, service);
}

export function unregisterCommunityDigestService(
  botId: string,
  service?: CommunityDigestService,
): void {
  const current = services.get(botId);
  if (service !== undefined && current !== service) return;
  services.delete(botId);
}

export function getCommunityDigestService(botId: string): CommunityDigestService | null {
  return services.get(botId) ?? null;
}
