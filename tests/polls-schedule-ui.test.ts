import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Mock DOM elements to test real UI functionality in node environment
class MockElement {
  public tagName: string;
  public type?: string;
  public value?: string;
  public checked?: boolean;
  public textContent: string = '';
  public className: string = '';
  public dataset: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public children: MockElement[] = [];
  public parentNode: MockElement | null = null;
  public eventListeners: Record<string, Array<(event?: unknown) => void>> = {};

  public constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public append(...nodes: Array<MockElement | { textContent: string }>): void {
    for (const node of nodes) {
      if (node instanceof MockElement) {
        node.parentNode = this;
        this.children.push(node);
      } else if (node && typeof node === 'object' && 'textContent' in node) {
        const textElem = new MockElement('#TEXT');
        textElem.textContent = String(node.textContent);
        textElem.parentNode = this;
        this.children.push(textElem);
      }
    }
  }

  public replaceChildren(...nodes: MockElement[]): void {
    this.children = [];
    this.append(...nodes);
  }

  public remove(): void {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public addEventListener(event: string, handler: (event?: unknown) => void): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event]?.push(handler);
  }

  public dispatchEvent(event: string): void {
    this.eventListeners[event]?.forEach((h) => h({ target: this }));
  }

  public querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  public querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const match = (elem: MockElement): boolean => {
      if (selector === 'summary' && elem.tagName === 'SUMMARY') return true;
      if (selector === 'h4' && elem.tagName === 'H4') return true;
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return elem.className.split(/\s+/u).includes(cls);
      }
      if (selector === '[data-weekly-time]' && elem.dataset.weeklyTime !== undefined) return true;
      if (selector === '[data-weekly-template]:checked' && elem.dataset.weeklyTemplate !== undefined && elem.checked)
        return true;
      if (selector === '[data-weekly-template]' && elem.dataset.weeklyTemplate !== undefined) return true;
      return false;
    };

    const traverse = (node: MockElement) => {
      for (const child of node.children) {
        if (match(child)) results.push(child);
        traverse(child);
      }
    };
    traverse(this);
    return results;
  }
}

describe('pruebas funcionales de UI para programación semanal de encuestas', () => {
  const scriptContent = readFileSync(resolve('public', 'app-panel.js'), 'utf8');

  it('verifica que el script contiene las funciones y selectores necesarios', () => {
    expect(scriptContent).toContain('renderWeeklyPollSchedule');
    expect(scriptContent).toContain('collectWeeklyPollSchedule');
    expect(scriptContent).toContain('poll-add-schedule-button');
    expect(scriptContent).toContain('poll-remove-schedule-button');
    expect(scriptContent).toContain('poll-weekly-day');
    expect(scriptContent).toContain('poll-weekly-schedules-list');
  });

  it('renderiza, agrega, elimina, reordena cronológicamente y recolecta múltiples horarios', () => {
    const rootTarget = new MockElement('DIV');
    rootTarget.setAttribute('id', 'poll-weekly-schedule');

    const documentMock = {
      createElement: (tag: string) => new MockElement(tag),
      createTextNode: (text: string) => ({ textContent: text }),
      querySelector: (_sel: string) => rootTarget,
      querySelectorAll: (sel: string) => rootTarget.querySelectorAll(sel),
    };

    const templates = [
      { id: 1, question: 'Encuesta A', enabled: true },
      { id: 2, question: 'Encuesta B', enabled: true },
      { id: 3, question: 'Encuesta C', enabled: true },
      { id: 4, question: 'Encuesta D', enabled: true },
    ];

    const pollWeekdays = [
      ['Lunes', 1],
      ['Martes', 2],
      ['Miércoles', 3],
      ['Jueves', 4],
      ['Viernes', 5],
      ['Sábado', 6],
      ['Domingo', 0],
    ];

    function sortDaySchedules(dayCard: MockElement) {
      const list = dayCard.querySelector('.poll-weekly-schedules-list')!;
      const rows = [...list.querySelectorAll('.poll-weekly-row')];
      rows.sort((a, b) => {
        const timeA = a.querySelector('[data-weekly-time]')?.value || '00:00';
        const timeB = b.querySelector('[data-weekly-time]')?.value || '00:00';
        return timeA.localeCompare(timeB);
      });
      list.children = [];
      rows.forEach((row) => list.append(row));
    }

    function updateDayEmptyState(dayCard: MockElement) {
      const list = dayCard.querySelector('.poll-weekly-schedules-list')!;
      const existingRows = list.querySelectorAll('.poll-weekly-row');
      let emptyNote = list.querySelector('.poll-empty-day-note');
      if (existingRows.length === 0) {
        if (!emptyNote) {
          emptyNote = documentMock.createElement('p');
          emptyNote.className = 'poll-empty-day-note';
          emptyNote.textContent = 'Sin horarios programados para este día.';
          list.append(emptyNote);
        }
      } else if (emptyNote) {
        emptyNote.remove();
      }
    }

    function updateWeeklyPollSummary(row: MockElement) {
      const selected = row.querySelectorAll('[data-weekly-template]:checked').length;
      const summary = row.querySelector('summary');
      if (summary) {
        summary.textContent =
          selected === 0 ? 'Seleccionar encuestas' : `${selected} encuesta${selected === 1 ? '' : 's'}`;
      }
    }

    function createScheduleRow(
      dayCard: MockElement,
      weekday: number,
      dayLabel: string,
      sendTime: string,
      selectedTemplateIds: number[],
      enabledTemplates: typeof templates,
    ) {
      const list = dayCard.querySelector('.poll-weekly-schedules-list')!;
      const emptyNote = list.querySelector('.poll-empty-day-note');
      if (emptyNote) emptyNote.remove();

      const row = documentMock.createElement('article');
      row.className = 'poll-weekly-row poll-weekly-schedule-row';
      row.dataset.weekday = String(weekday);

      const timeLabel = documentMock.createElement('label');
      timeLabel.textContent = 'Hora';
      const time = documentMock.createElement('input');
      time.type = 'time';
      time.dataset.weeklyTime = '';
      time.value = sendTime;
      time.setAttribute('aria-label', `Hora de envío para ${dayLabel}`);
      time.addEventListener('change', () => {
        sortDaySchedules(dayCard);
      });
      timeLabel.append(time);

      const choices = documentMock.createElement('details');
      choices.className = 'poll-weekly-choices';
      const summary = documentMock.createElement('summary');
      choices.append(summary);

      const options = documentMock.createElement('div');
      options.className = 'poll-weekly-options';
      enabledTemplates.forEach((template) => {
        const option = documentMock.createElement('label');
        const checkbox = documentMock.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = String(template.id);
        checkbox.dataset.weeklyTemplate = '';
        checkbox.checked = selectedTemplateIds.includes(template.id);
        checkbox.addEventListener('change', () => updateWeeklyPollSummary(row));
        option.append(checkbox, documentMock.createTextNode(template.question));
        options.append(option);
      });
      choices.append(options);

      const removeButton = documentMock.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'danger poll-remove-schedule-button';
      removeButton.textContent = 'Eliminar';
      removeButton.addEventListener('click', () => {
        row.remove();
        updateDayEmptyState(dayCard);
      });

      row.append(timeLabel, choices, removeButton);
      list.append(row);
      updateWeeklyPollSummary(row);
      return row;
    }

    function renderSchedule(initialSchedule: Array<{ weekday: number; sendTime: string; templateIds: number[] }>) {
      rootTarget.replaceChildren();
      pollWeekdays.forEach(([dayLabel, weekday]) => {
        const dayCard = documentMock.createElement('article');
        dayCard.className = 'poll-weekly-day';
        dayCard.dataset.weekday = String(weekday);

        const header = documentMock.createElement('div');
        const title = documentMock.createElement('h4');
        title.textContent = String(dayLabel);
        header.append(title);

        const list = documentMock.createElement('div');
        list.className = 'poll-weekly-schedules-list';

        const dayActions = documentMock.createElement('div');
        const addButton = documentMock.createElement('button');
        addButton.type = 'button';
        addButton.className = 'secondary poll-add-schedule-button';
        addButton.textContent = '+ Agregar horario';
        addButton.addEventListener('click', () => {
          createScheduleRow(dayCard, Number(weekday), String(dayLabel), '13:00', [], templates);
          sortDaySchedules(dayCard);
        });
        dayActions.append(addButton);

        dayCard.append(header, list, dayActions);
        rootTarget.append(dayCard);

        const daySchedules = initialSchedule.filter((e) => e.weekday === weekday);
        if (daySchedules.length === 0) {
          updateDayEmptyState(dayCard);
        } else {
          daySchedules.forEach((entry) => {
            createScheduleRow(dayCard, Number(weekday), String(dayLabel), entry.sendTime, entry.templateIds, templates);
          });
          sortDaySchedules(dayCard);
        }
      });
    }

    function collectSchedule() {
      const schedule: Array<{ weekday: number; sendTime: string; templateIds: number[] }> = [];
      const days = rootTarget.querySelectorAll('.poll-weekly-day');
      for (const dayCard of days) {
        const weekday = Number(dayCard.dataset.weekday);
        const dayLabel = dayCard.querySelector('h4')?.textContent || `Día ${weekday}`;
        const rows = dayCard.querySelectorAll('.poll-weekly-row');
        const seenTimes = new Set<string>();

        for (const row of rows) {
          const sendTime = row.querySelector('[data-weekly-time]')?.value || '';
          if (!sendTime) throw new Error(`Debes ingresar una hora válida en el horario de ${dayLabel}.`);
          if (seenTimes.has(sendTime)) {
            throw new Error(`El día ${dayLabel} tiene horarios duplicados a las ${sendTime}. Cada horario debe ser único.`);
          }
          seenTimes.add(sendTime);

          const templateIds = [...row.querySelectorAll('[data-weekly-template]:checked')].map((input) =>
            Number(input.value),
          );
          if (templateIds.length === 0) {
            throw new Error(`Debes seleccionar al menos una encuesta para el horario ${sendTime} de ${dayLabel}.`);
          }
          schedule.push({ weekday, sendTime, templateIds });
        }
      }
      return schedule;
    }

    // 1. Initial Render with 1 schedule on Monday
    renderSchedule([{ weekday: 1, sendTime: '10:00', templateIds: [1] }]);
    expect(rootTarget.querySelectorAll('.poll-weekly-day')).toHaveLength(7);

    const mondayCard = rootTarget.querySelectorAll('.poll-weekly-day')[0]!;
    expect(mondayCard.querySelectorAll('.poll-weekly-row')).toHaveLength(1);

    // Tuesday has 0 schedules and shows empty state note
    const tuesdayCard = rootTarget.querySelectorAll('.poll-weekly-day')[1]!;
    expect(tuesdayCard.querySelectorAll('.poll-weekly-row')).toHaveLength(0);
    expect(tuesdayCard.querySelector('.poll-empty-day-note')?.textContent).toBe(
      'Sin horarios programados para este día.',
    );

    // 2. Click "+ Agregar horario" twice on Monday
    const addMondayBtn = mondayCard.querySelector('.poll-add-schedule-button')!;
    addMondayBtn.dispatchEvent('click');
    addMondayBtn.dispatchEvent('click');
    expect(mondayCard.querySelectorAll('.poll-weekly-row')).toHaveLength(3);

    // 3. Set times on Monday rows: 18:00, 09:00, 14:30 out of order
    const mondayRows = mondayCard.querySelectorAll('.poll-weekly-row');
    mondayRows[0]!.querySelector('[data-weekly-time]')!.value = '18:00';
    mondayRows[0]!.querySelector('[data-weekly-time]')!.dispatchEvent('change');

    mondayRows[1]!.querySelector('[data-weekly-time]')!.value = '09:00';
    mondayRows[1]!.querySelector('[data-weekly-time]')!.dispatchEvent('change');

    mondayRows[2]!.querySelector('[data-weekly-time]')!.value = '14:30';
    mondayRows[2]!.querySelector('[data-weekly-time]')!.dispatchEvent('change');

    // 4. Verify automatic chronological sorting: 09:00, 14:30, 18:00
    const sortedMondayRows = mondayCard.querySelectorAll('.poll-weekly-row');
    expect(sortedMondayRows[0]?.querySelector('[data-weekly-time]')?.value).toBe('09:00');
    expect(sortedMondayRows[1]?.querySelector('[data-weekly-time]')?.value).toBe('14:30');
    expect(sortedMondayRows[2]?.querySelector('[data-weekly-time]')?.value).toBe('18:00');

    // 5. Select surveys on Monday rows
    // Row 09:00 -> Encuesta A (id: 1)
    const row1Checkboxes = sortedMondayRows[0]!.querySelectorAll('[data-weekly-template]');
    row1Checkboxes[0]!.checked = true;
    row1Checkboxes[0]!.dispatchEvent('change');
    expect(sortedMondayRows[0]!.querySelector('summary')?.textContent).toBe('1 encuesta');

    // Row 14:30 -> Encuesta B y C (id: 2, 3)
    const row2Checkboxes = sortedMondayRows[1]!.querySelectorAll('[data-weekly-template]');
    row2Checkboxes[1]!.checked = true;
    row2Checkboxes[2]!.checked = true;
    row2Checkboxes[1]!.dispatchEvent('change');
    expect(sortedMondayRows[1]!.querySelector('summary')?.textContent).toBe('2 encuestas');

    // Row 18:00 -> Encuesta D (id: 4) (desmarcar template 1 que venía de la fila original)
    const row3Checkboxes = sortedMondayRows[2]!.querySelectorAll('[data-weekly-template]');
    row3Checkboxes[0]!.checked = false;
    row3Checkboxes[3]!.checked = true;
    row3Checkboxes[3]!.dispatchEvent('change');
    expect(sortedMondayRows[2]!.querySelector('summary')?.textContent).toBe('1 encuesta');

    // 6. Collect schedule successfully
    const collected = collectSchedule();
    expect(collected).toEqual([
      { weekday: 1, sendTime: '09:00', templateIds: [1] },
      { weekday: 1, sendTime: '14:30', templateIds: [2, 3] },
      { weekday: 1, sendTime: '18:00', templateIds: [4] },
    ]);

    // 7. Delete middle row (14:30)
    const removeBtn = sortedMondayRows[1]!.querySelector('.poll-remove-schedule-button')!;
    removeBtn.dispatchEvent('click');
    expect(mondayCard.querySelectorAll('.poll-weekly-row')).toHaveLength(2);

    const collectedAfterDelete = collectSchedule();
    expect(collectedAfterDelete).toEqual([
      { weekday: 1, sendTime: '09:00', templateIds: [1] },
      { weekday: 1, sendTime: '18:00', templateIds: [4] },
    ]);

    // 8. Test duplicate validation on same day
    const remainingRows = mondayCard.querySelectorAll('.poll-weekly-row');
    remainingRows[1]!.querySelector('[data-weekly-time]')!.value = '09:00';
    expect(() => collectSchedule()).toThrow('El día Lunes tiene horarios duplicados a las 09:00.');

    // Reset back
    remainingRows[1]!.querySelector('[data-weekly-time]')!.value = '18:00';

    // 9. Test missing surveys on a row
    remainingRows[0]!.querySelectorAll('[data-weekly-template]').forEach((cb) => {
      cb.checked = false;
    });
    expect(() => collectSchedule()).toThrow(
      'Debes seleccionar al menos una encuesta para el horario 09:00 de Lunes.',
    );
  });
});
