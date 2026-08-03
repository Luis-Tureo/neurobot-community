import { createHash } from 'node:crypto';
import type { PollTemplate } from '../domain/types.js';
import type { PollRepository } from './poll-repository.js';

export class PollTemplateSelector {
  public constructor(private readonly repository: PollRepository) {}

  public select(
    localDate: string,
    selectionGroupId: string | null,
    now: Date,
  ): PollTemplate | null {
    const override = this.repository.override(localDate);
    if (override !== null) {
      const selected = this.repository.template(override.templateId);
      return selected !== null && isSelectable(selected, now) ? selected : null;
    }

    const active = this.repository.templates().filter((template) => isSelectable(template, now));
    if (active.length === 0) return null;
    const repeatDays = Math.max(1, this.repository.minimumRepeatDays());
    const allUsage = this.repository.usage(
      subtractLocalDays(localDate, repeatDays),
      selectionGroupId,
    );
    const recentCategories = latestDistinctDayCategories(allUsage);
    const blockedCategory =
      recentCategories.length >= this.repository.maximumCategoryStreak() &&
      new Set(recentCategories.slice(0, this.repository.maximumCategoryStreak())).size === 1
        ? recentCategories[0]
        : null;

    for (const windowDays of [...new Set([repeatDays, 21, 14, 7, 0])].sort((a, b) => b - a)) {
      const used = new Set(
        windowDays === 0
          ? []
          : this.repository
              .usage(subtractLocalDays(localDate, windowDays), selectionGroupId)
              .map((item) => item.templateId),
      );
      const withoutRecent = active.filter((template) => !used.has(template.id));
      if (withoutRecent.length === 0) continue;
      const categorySafe = withoutRecent.filter(
        (template) => blockedCategory === null || template.category !== blockedCategory,
      );
      if (categorySafe.length === 0) continue;
      const candidates = categorySafe;
      const favorites = candidates.filter((template) => template.favorite);
      return deterministicPick(
        favorites.length > 0 ? favorites : candidates,
        `${localDate}:${selectionGroupId ?? 'GLOBAL'}:${windowDays}`,
      );
    }
    const fallback = active.filter(
      (template) => blockedCategory === null || template.category !== blockedCategory,
    );
    return fallback.length === 0
      ? null
      : deterministicPick(fallback, `${localDate}:${selectionGroupId ?? 'GLOBAL'}:fallback`);
  }
}

function isSelectable(template: PollTemplate, now: Date): boolean {
  return (
    template.enabled &&
    (template.disabledUntil === null || new Date(template.disabledUntil).getTime() <= now.getTime())
  );
}

function deterministicPick(templates: PollTemplate[], key: string): PollTemplate {
  const ordered = [...templates].sort((left, right) => left.id - right.id);
  const digest = createHash('sha256')
    .update(`${key}:${ordered.map((template) => template.id).join(',')}`)
    .digest();
  return ordered[digest.readUInt32BE(0) % ordered.length] as PollTemplate;
}

function latestDistinctDayCategories(
  usage: Array<{ category: string; localDate: string }>,
): string[] {
  const categories: string[] = [];
  const dates = new Set<string>();
  for (const item of usage) {
    if (dates.has(item.localDate)) continue;
    dates.add(item.localDate);
    categories.push(item.category);
  }
  return categories;
}

function subtractLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
