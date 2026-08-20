import type { AssistantProfile, OrganizationType } from '../domain/types.js';

/**
 * Crea los datos operativos de un asistente nuevo. Los valores marcados como
 * legacy existen solo porque las bases anteriores a #30 conservan columnas
 * NOT NULL; no forman parte del prompt ni de la configuración administrativa.
 */
export function createDefaultAssistantProfile(input: {
  organizationName: string;
  botName: string;
  organizationType: OrganizationType;
  timezone: string;
}): Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'> {
  const aliasName = input.botName.replace(/\s+/gu, '');
  return {
    internalName: input.organizationName,
    organizationName: input.organizationName,
    botName: input.botName,
    activationAlias: `@${aliasName}`,
    description: `Información confirmada de ${input.organizationName}.`,
    organizationType: input.organizationType,
    industry: 'LEGACY_DEPRECATED',
    objective: 'LEGACY_DEPRECATED',
    allowedTopics: [],
    excludedTopics: [],
    tone: 'LEGACY_DEPRECATED',
    outOfScopeMessage: 'LEGACY_DEPRECATED',
    noInformationMessage:
      'No tengo información confirmada sobre eso. Puedes consultar a la administración.',
    limitMessage: 'Has alcanzado el límite de consultas por ahora. Intenta más tarde.',
    aiErrorMessage: 'El asistente inteligente no está disponible en este momento.',
    medicalMessage:
      'Puedo entregar información general, pero no diagnósticos ni indicaciones de tratamiento.',
    mentionPromptMessage: `Escribe tu pregunta después de llamar a ${input.botName}.`,
    communityGreetingMessage: 'LEGACY_DEPRECATED',
    contactInformation: '',
    businessHours: '',
    address: null,
    logoPath: null,
    primaryColor: '#176b61',
    secondaryColor: '#d8a446',
    timezone: input.timezone,
    applicationName: 'Panel del Asistente',
    headerText: input.botName,
    footerText: '',
    supportInformation: '',
  };
}
