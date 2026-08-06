import type { Logger } from 'pino';
import type { IncomingMessage } from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import {
  MessageProcessor as OriginalMessageProcessor,
  containsActivationAlias,
} from './message-processor-original.js';
import type {
  MessageProcessorOptions,
  ProcessResult,
} from './message-processor-original.js';
import { getConversationSummaryService } from './conversation-summary-registry.js';

export type { MessageProcessorOptions, ProcessResult };
export { containsActivationAlias };

type MessageProcessorRuntime = {
  database: AppDatabase;
  anonymizer: Anonymizer;
  logger: Logger;
  botId: string;
  options: MessageProcessorOptions;
};

export class MessageProcessor extends OriginalMessageProcessor {
  public override async process(message: IncomingMessage): Promise<ProcessResult> {
    const runtime = this as unknown as MessageProcessorRuntime;
    const service = getConversationSummaryService(runtime.botId);
    if (service !== null && shouldCapture(message, runtime.options.maxMessageLength)) {
      const bot = runtime.database.getBot(runtime.botId);
      if (
        bot !== null &&
        bot.enabled &&
        bot.groupsEnabled &&
        runtime.database.canBotSendToGroup(runtime.botId, message.chatId)
      ) {
        const groupHash = runtime.anonymizer.identifier(message.chatId);
        const participantHash = runtime.anonymizer.identifier(message.participantId);
        try {
          await service.captureMessage(message, groupHash, participantHash);
        } catch {
          runtime.logger.warn(
            {
              operation: 'CONVERSATION_HISTORY_CAPTURE_FAILED',
              botId: runtime.botId,
              groupHash,
              participantHash,
              errorCode: 'CONVERSATION_HISTORY_CAPTURE_FAILED',
            },
            'No fue posible guardar una copia protegida del mensaje',
          );
        }
      }
    }
    return super.process(message);
  }
}

function shouldCapture(message: IncomingMessage, maximumLength: number): boolean {
  return (
    !message.fromMe &&
    message.isGroup &&
    !message.isStatus &&
    !message.isBroadcast &&
    !message.isChannel &&
    !message.hasMedia &&
    typeof message.body === 'string' &&
    message.body.trim() !== '' &&
    message.body.length <= maximumLength
  );
}
