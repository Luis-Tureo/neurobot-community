import type { AppDatabase } from '../persistence/database.js';
import { containsWholeTerm } from '../utils/text.js';
import type { ResponseProvider, ResponseRequest, SelectedResponse } from './response-provider.js';

export class RuleBasedResponseProvider implements ResponseProvider {
  public constructor(private readonly database: AppDatabase) {}

  public select(request: ResponseRequest): SelectedResponse | null {
    if (request.activation === 'command' && request.commandName !== undefined) {
      const command = this.database.getCommand(request.commandName);
      if (command === null || !command.enabled) return this.fallback();
      if (command.name === 'reglas') {
        return {
          text: this.database.getAutomaticMessageConfiguration().dailyRules.template,
          commandName: command.name,
        };
      }
      if (command.name === 'grupos') {
        const publicGroups = this.database.listPublicOperationalGroups();
        const text =
          publicGroups.length === 0
            ? command.custom
              ? command.response
              : '💬 No hay espacios públicos disponibles en este momento.\n\nConsulta a la administración.'
            : `💬 Puedes unirte a los espacios que sean de tu interés:\n\n${publicGroups
                .map((group) => group.publicName ?? group.name)
                .join(' | ')}\n\nParticipa a tu ritmo y solicita los enlaces a la administración.`;
        return { text, commandName: command.name };
      }
      return {
        text: this.withWarning(command.response, command.healthRelated),
        commandName: command.name,
      };
    }

    const commands = new Map(this.database.listCommands().map((command) => [command.id, command]));
    const match = this.database
      .listKeywords()
      .filter((keyword) => keyword.enabled && containsWholeTerm(request.text, keyword.term))
      .sort((left, right) => right.priority - left.priority)
      .find((keyword) => commands.get(keyword.commandId)?.enabled === true);

    if (match === undefined) return this.fallback();
    const command = commands.get(match.commandId);
    if (command === undefined) return this.fallback();
    return {
      text: this.withWarning(command.response, command.healthRelated),
      commandName: command.name,
    };
  }

  private fallback(): SelectedResponse {
    return {
      text: this.database.getSetting(
        'fallback_response',
        'No encontré una respuesta configurada. Escribe !ayuda para ver las opciones.',
      ),
      commandName: null,
    };
  }

  private withWarning(text: string, healthRelated: boolean): string {
    if (!healthRelated) return text;
    const warning = this.database.getSetting(
      'professional_warning',
      'Esta información es solamente una orientación general y no reemplaza una evaluación médica, psicológica o profesional.',
    );
    return `${text}\n\n${warning}`;
  }
}
