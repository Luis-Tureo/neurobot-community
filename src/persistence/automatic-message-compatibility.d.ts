import type { AutomaticMessageConfiguration } from '../domain/types.js';

type AutomaticMessageConfigurationInput = Omit<AutomaticMessageConfiguration, 'welcome'> & {
  welcome: Omit<AutomaticMessageConfiguration['welcome'], 'scheduleTimes'> & {
    scheduleTimes?: string[];
  };
};

declare module './database.js' {
  interface AppDatabase {
    saveAutomaticMessageConfigurationForGroups(
      configuration: AutomaticMessageConfigurationInput,
      groupIds: string[],
      botId?: string,
    ): void;
  }
}

export {};
