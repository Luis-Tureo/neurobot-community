import type {
  DetectedGroup,
  GroupChangeEvent,
  GroupJoinEvent,
  GroupListSource,
  NativePoll,
  WelcomeParticipant,
} from '../domain/types.js';
import type { MessagingClient, MessagingClientEvents } from './messaging-client.js';
import type { InteractiveMenuPayload, SelectableMenuPayload } from './messaging-client.js';

export type SentMessage = {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  mentionIds?: string[];
};

export type SentPoll = NativePoll & { chatId: string };
export type SentMedia = { chatId: string; absolutePath: string; caption: string };

export class SimulatedMessagingClient implements MessagingClient {
  public readonly sentMessages: SentMessage[] = [];
  public readonly sentPolls: SentPoll[] = [];
  public readonly sentMedia: SentMedia[] = [];
  public readonly sentInteractiveMenus: Array<{ chatId: string; payload: InteractiveMenuPayload }> = [];
  public readonly sentSelectableMenus: Array<{ chatId: string; payload: SelectableMenuPayload }> = [];
  public interactiveSupported = false;
  public selectableMenusSupported = true;
  public initializeCalls = 0;
  public destroyCalls = 0;
  public groups: DetectedGroup[] = [];
  public failSending = false;
  public ready = true;
  public connectionState: string | null = 'CONNECTED';
  public skippedChats = 0;
  public groupListSource: GroupListSource = 'SIMULATED';
  public listGroupsFailures: unknown[] = [];
  public readonly ownIdentifiers = new Set<string>();
  public readonly welcomeParticipants = new Map<string, WelcomeParticipant>();
  private events: MessagingClientEvents | null = null;

  public setEvents(events: MessagingClientEvents): void {
    this.events = events;
  }

  public async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  public async destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.ready = false;
    this.connectionState = null;
  }

  public async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    if (this.failSending) throw new Error('Fallo simulado');
    this.sentMessages.push({
      chatId,
      text,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    });
  }

  public async sendMessageWithMentions(chatId: string, text: string, mentionIds: string[]): Promise<void> {
    if (this.failSending) throw new Error('Fallo simulado');
    this.sentMessages.push({ chatId, text, mentionIds: [...mentionIds] });
  }

  public async resolveWelcomeParticipants(participantIds: string[]): Promise<WelcomeParticipant[]> {
    return participantIds
      .map((participantId) => this.welcomeParticipants.get(participantId))
      .filter((participant): participant is WelcomeParticipant => participant !== undefined);
  }

  public async sendPoll(chatId: string, poll: NativePoll): Promise<void> {
    if (this.failSending) throw new Error('Fallo simulado');
    this.sentPolls.push({ chatId, ...poll, options: [...poll.options] });
  }

  public async sendMedia(chatId: string, absolutePath: string, caption: string): Promise<void> {
    if (this.failSending) throw new Error('Fallo simulado');
    this.sentMedia.push({ chatId, absolutePath, caption });
  }

  public async sendInteractiveMenu(
    chatId: string,
    payload: InteractiveMenuPayload,
  ): Promise<boolean> {
    if (!this.interactiveSupported) return false;
    this.sentInteractiveMenus.push({ chatId, payload });
    return true;
  }

  public async sendSelectableMenu(
    chatId: string,
    payload: SelectableMenuPayload,
  ): Promise<boolean> {
    if (!this.selectableMenusSupported) return false;
    this.sentSelectableMenus.push({ chatId, payload });
    return true;
  }

  public async listGroups(): Promise<DetectedGroup[]> {
    const failure = this.listGroupsFailures.shift();
    if (failure !== undefined) throw failure;
    return this.groups;
  }

  public getLastGroupScanSkippedCount(): number {
    return this.skippedChats;
  }

  public getLastGroupListSource(): GroupListSource | null {
    return this.groupListSource;
  }

  public async getState(): Promise<string | null> {
    return this.connectionState;
  }

  public isReady(): boolean {
    return this.ready;
  }

  public isOwnIdentifier(identifier: string): boolean {
    return this.ownIdentifiers.has(identifier.trim().toLowerCase());
  }

  public getOwnIdentifier(): string | null {
    return this.ownIdentifiers.values().next().value ?? null;
  }

  public emitState(
    state: Parameters<MessagingClientEvents['onStateChange']>[0],
    reason?: string,
  ): void {
    this.events?.onStateChange(state, reason);
  }

  public emitReady(): void {
    this.ready = true;
    this.connectionState = 'CONNECTED';
    this.events?.onReady();
  }

  public async emitGroupJoin(event: GroupJoinEvent): Promise<void> {
    await this.events?.onGroupJoin?.(event);
  }

  public async emitGroupChanged(event: GroupChangeEvent): Promise<void> {
    await this.events?.onGroupChanged?.(event);
  }

  public async emitMessage(message: Parameters<MessagingClientEvents['onMessage']>[0]): Promise<void> {
    await this.events?.onMessage(message);
  }
}
