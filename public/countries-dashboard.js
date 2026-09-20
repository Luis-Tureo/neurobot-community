/**
 * Dashboard de Países de la Comunidad.
 *
 * Muestra la distribución geográfica estimada según el número de WhatsApp de los integrantes
 * o su declaración voluntaria mediante !pais.
 * Respeta estrictamente la privacidad:
 * - Agrupa países con < 5 integrantes en "Otros países".
 * - Nunca expone teléfonos, JIDs ni hashes.
 */

let dependencies = {
  api: null,
  botScopedPath: (path) => path,
  showNotice: () => undefined,
};

let currentCountries = [];

const numberFormatter = new Intl.NumberFormat('es-CL');

function normalizeSearchText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * Filtra la lista de estadísticas de países por nombre o código ISO.
 * Pure function exportada para tests y lógica de interfaz.
 */
export function filterCountries(countries, query) {
  if (!query || typeof query !== 'string' || query.trim() === '') {
    return countries ? [...countries] : [];
  }
  const normalizedQuery = normalizeSearchText(query);
  return (countries || []).filter((item) => {
    const nameNorm = normalizeSearchText(item.countryName);
    const codeNorm = (item.countryCode || '').toLowerCase();
    return (
      nameNorm.includes(normalizedQuery) ||
      codeNorm === normalizedQuery ||
      codeNorm.includes(normalizedQuery)
    );
  });
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function initializeCountriesDashboard(deps) {
  if (deps) {
    dependencies = { ...dependencies, ...deps };
  }

  const searchInput = document.querySelector('#countries-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderCountriesTable(searchInput.value);
    });
  }

  const syncBtn = document.querySelector('#countries-sync-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      await syncCountries();
    });
  }

  window.addEventListener('panel-section-activated', (event) => {
    if (event.detail?.name === 'countries') {
      void loadCountriesDashboard();
    }
  });

  window.addEventListener('bot-services-load', (event) => {
    const visibleModules = new Set(event.detail?.visibleModules || []);
    if (visibleModules.has('countries')) {
      void loadCountriesDashboard();
    }
  });
}

export async function loadCountriesDashboard() {
  const tableBody = document.querySelector('#countries-table-body');
  try {
    const path = dependencies.botScopedPath
      ? dependencies.botScopedPath('/api/community/countries')
      : '/api/community/countries';

    const summary = dependencies.api
      ? await dependencies.api.get(path)
      : await fetch(path).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        });

    currentCountries = summary.countries || [];

    renderKpis(summary);

    const searchInput = document.querySelector('#countries-search-input');
    renderCountriesTable(searchInput ? searchInput.value : '');
  } catch (error) {
    if (tableBody) {
      tableBody.innerHTML = `<tr><td colspan="5" class="text-center muted py-4">No fue posible cargar los datos de países.</td></tr>`;
    }
    dependencies.showNotice(error.message || 'Error al cargar países', true);
  }
}

function renderKpis(summary) {
  const totalEl = document.querySelector('#country-kpi-total');
  const identifiedEl = document.querySelector('#country-kpi-identified');
  const identifiedPctEl = document.querySelector('#country-kpi-identified-pct');
  const unidentifiedEl = document.querySelector('#country-kpi-unidentified');
  const countriesEl = document.querySelector('#country-kpi-countries');

  if (totalEl) totalEl.textContent = numberFormatter.format(summary.totalParticipants || 0);
  if (identifiedEl) identifiedEl.textContent = numberFormatter.format(summary.identified || 0);
  if (identifiedPctEl) {
    const pct =
      summary.totalParticipants > 0
        ? ((summary.identified / summary.totalParticipants) * 100).toFixed(1)
        : '0.0';
    identifiedPctEl.textContent = `${pct}% del total`;
  }
  if (unidentifiedEl)
    unidentifiedEl.textContent = numberFormatter.format(summary.unidentified || 0);
  if (countriesEl)
    countriesEl.textContent = numberFormatter.format(summary.countriesCount || 0);
}

function renderCountriesTable(query = '') {
  const tableBody = document.querySelector('#countries-table-body');
  const emptyState = document.querySelector('#countries-empty-state');
  if (!tableBody) return;

  const filtered = filterCountries(currentCountries, query);

  if (filtered.length === 0) {
    tableBody.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  const rowsHtml = filtered
    .map((c) => {
      const codeBadge = c.countryCode
        ? `<span class="country-badge" style="display:inline-block; font-size:0.75rem; padding:0.1rem 0.35rem; background:#e2e8f0; color:#334155; border-radius:0.25rem; margin-left:0.5rem; font-weight:500;">${escapeHtml(c.countryCode)}</span>`
        : '';

      const progressBar = `
        <div style="display:flex; align-items:center; gap:0.5rem; width:100%;">
          <div style="flex:1; background:#e2e8f0; height:8px; border-radius:4px; overflow:hidden;">
            <div style="background:#3b82f6; height:100%; width:${Math.min(100, Math.max(0, c.percentage))}%; border-radius:4px;"></div>
          </div>
          <span style="font-size:0.875rem; font-weight:600; min-width:3rem; text-align:right;">${c.percentage.toFixed(1)}%</span>
        </div>
      `;

      return `
        <tr>
          <td>
            <span style="font-size:1.25rem; margin-right:0.5rem; vertical-align:middle;">${c.flagEmoji || '🌐'}</span>
            <strong style="vertical-align:middle;">${escapeHtml(c.countryName)}</strong>
            ${codeBadge}
          </td>
          <td class="text-right" style="text-align:right; font-weight:600;">
            ${numberFormatter.format(c.participantCount)}
          </td>
          <td style="min-width:140px;">
            ${progressBar}
          </td>
          <td class="text-right muted" style="text-align:right;">
            ${numberFormatter.format(c.detectedCount)}
          </td>
          <td class="text-right muted" style="text-align:right;">
            ${numberFormatter.format(c.declaredCount)}
          </td>
        </tr>
      `;
    })
    .join('');

  tableBody.innerHTML = rowsHtml;
}

async function syncCountries() {
  const syncBtn = document.querySelector('#countries-sync-btn');
  const originalText = syncBtn ? syncBtn.textContent : '';

  try {
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = '↻ Sincronizando integrantes...';
    }

    const path = dependencies.botScopedPath
      ? dependencies.botScopedPath('/api/community/countries/sync')
      : '/api/community/countries/sync';

    const result = dependencies.api
      ? await dependencies.api.post(path, {})
      : await fetch(path, { method: 'POST' }).then((r) => r.json());

    dependencies.showNotice(
      `Sincronización completada: ${result.totalParticipants || 0} integrantes analizados (${result.inserted || 0} nuevos, ${result.updated || 0} actualizados).`,
      false,
    );

    await loadCountriesDashboard();
  } catch (error) {
    dependencies.showNotice(
      `Error en sincronización: ${error.message || 'No fue posible sincronizar'}`,
      true,
    );
  } finally {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.textContent = originalText;
    }
  }
}

// Auto-inicializar si ya se cargaron dependencias globales
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    // Si app-panel ya definió initializeCountriesDashboard, se ejecutará allí.
  });
}
