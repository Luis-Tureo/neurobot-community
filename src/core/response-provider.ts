import type { ActivationType } from '../domain/types.js';

export type ResponseRequest = {
  text: string;
  activation: ActivationType;
  commandName?: string;
};

export type SelectedResponse = {
  text: string;
  commandName: string | null;
};

export interface ResponseProvider {
  select(request: ResponseRequest): SelectedResponse | null;
}
