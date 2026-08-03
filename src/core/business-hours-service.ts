import type { AppDatabase } from '../persistence/database.js';

export class BusinessHoursService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly botId: string,
  ) {}

  public summary(): string {
    const hours = this.database.listBusinessHours(this.botId).filter((entry) => entry.localDate === null);
    if (hours.length === 0) return 'No tengo horarios de atención confirmados. Consulta directamente con el negocio.';
    const weekdays = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    return hours
      .slice(0, 5)
      .map((entry) => {
        const day = entry.weekday === null ? 'Fecha especial' : weekdays[entry.weekday];
        if (entry.closed) return `${day}: cerrado.`;
        return `${day}: ${entry.openingTime ?? '—'} a ${entry.closingTime ?? '—'}.`;
      })
      .join('\n')
      .slice(0, 600);
  }
}
