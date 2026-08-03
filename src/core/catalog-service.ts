import type { AppDatabase } from '../persistence/database.js';

export class CatalogService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly botId: string,
  ) {}

  public itemText(id: number): string {
    const item = this.database.listCatalogItems(this.botId).find((candidate) => candidate.id === id && candidate.enabled);
    if (item === undefined) return 'No tengo información actualizada sobre ese producto. Consulta directamente con el negocio.';
    const lines = [item.name];
    if (item.description !== '') lines.push(item.description);
    const price = item.offerPriceAmount ?? item.priceAmount;
    if (price === null) {
      lines.push('No tengo un precio actualizado. Consulta directamente con el negocio.');
    } else {
      lines.push(`Precio informado: ${formatMoney(price, item.currency)}.`);
    }
    if (item.availability !== '') lines.push(item.availability);
    return lines.slice(0, 5).join('\n').slice(0, 600);
  }

  public categoryText(categoryId: number | null): string {
    const items = this.database
      .listCatalogItems(this.botId)
      .filter((item) => item.enabled && (categoryId === null || item.categoryId === categoryId))
      .slice(0, 8);
    if (items.length === 0) return 'No hay productos o servicios activos en esta categoría.';
    return ['Productos o servicios disponibles:', ...items.map((item, index) => `${index + 1}. ${item.name}`)]
      .join('\n')
      .slice(0, 600);
  }
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount / 100);
  } catch {
    return `${currency} ${(amount / 100).toLocaleString('es-CL')}`;
  }
}
