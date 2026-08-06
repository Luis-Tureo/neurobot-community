import type { AssistantProfile, OrganizationType } from '../domain/types.js';

export type ProfilePresetKey = 'community' | 'empty';

export type ProfilePreset = {
  key: ProfilePresetKey;
  label: string;
  organizationType: OrganizationType;
  industry: string;
  objective: string;
  allowedTopics: string[];
  excludedTopics: string[];
  tone: string;
};

export const PROFILE_PRESETS: ProfilePreset[] = [
  {
    key: 'community',
    label: 'Comunidad',
    organizationType: 'Comunidad',
    industry: 'Comunidad y apoyo informativo',
    objective:
      'Entregar información oficial sobre la comunidad, sus normas, grupos, actividades, horarios y contacto.',
    allowedTopics: [
      'Presentación',
      'Normas',
      'Grupos',
      'Actividades',
      'Horarios',
      'Contacto',
      'Seguridad',
      'Preguntas frecuentes',
    ],
    excludedTopics: [
      'Diagnósticos',
      'Tratamientos',
      'Datos personales',
      'Acciones administrativas',
    ],
    tone: 'Amable, claro, inclusivo y breve.',
  },
  {
    key: 'empty',
    label: 'Comunidad personalizada',
    organizationType: 'Comunidad',
    industry: 'Comunidad por configurar',
    objective:
      'Entregar únicamente información oficial configurada por la administración de la comunidad.',
    allowedTopics: ['Información oficial de la comunidad'],
    excludedTopics: ['Acciones administrativas', 'Datos personales', 'Información no confirmada'],
    tone: 'Amable, claro, inclusivo y breve.',
  },
];

export function applyProfilePreset(
  current: AssistantProfile,
  key: ProfilePresetKey,
): AssistantProfile {
  const preset = PROFILE_PRESETS.find((item) => item.key === key);
  if (preset === undefined) throw new Error('La plantilla seleccionada no existe.');
  return {
    ...current,
    organizationType: 'Comunidad',
    industry: preset.industry,
    objective: preset.objective,
    allowedTopics: [...preset.allowedTopics],
    excludedTopics: [...preset.excludedTopics],
    tone: preset.tone,
  };
}

export function createProfileFromPreset(input: {
  organizationName: string;
  botName: string;
  organizationType: OrganizationType;
  timezone: string;
  preset: ProfilePresetKey;
}): Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'> {
  const preset = PROFILE_PRESETS.find((item) => item.key === input.preset);
  if (preset === undefined) throw new Error('La plantilla seleccionada no existe.');
  const aliasName = input.botName.replace(/\s+/gu, '');
  return {
    internalName: input.organizationName,
    organizationName: input.organizationName,
    botName: input.botName,
    activationAlias: `@${aliasName}`,
    description: `Asistente informativo de ${input.organizationName}.`,
    organizationType: 'Comunidad',
    industry: preset.industry,
    objective: preset.objective,
    allowedTopics: [...preset.allowedTopics],
    excludedTopics: [...preset.excludedTopics],
    tone: preset.tone,
    outOfScopeMessage: 'Solo puedo responder consultas relacionadas con esta comunidad.',
    noInformationMessage:
      'No tengo información confirmada sobre eso. Puedes consultar a la administración.',
    limitMessage: 'Has alcanzado el límite de consultas por ahora. Intenta más tarde.',
    aiErrorMessage: 'El asistente inteligente no está disponible en este momento.',
    medicalMessage:
      'Puedo entregar orientación general, pero no diagnósticos ni indicaciones de tratamiento.',
    mentionPromptMessage: `Escribe tu pregunta después de llamar a ${input.botName}.`,
    communityGreetingMessage: `¡Hola! Soy ${input.botName}, el asistente informativo de ${input.organizationName}. Escríbeme usando @${aliasName} seguido de tu pregunta. Respondo una consulta a la vez.`,
    contactInformation: '',
    businessHours: '',
    address: null,
    logoPath: null,
    primaryColor: '#176b61',
    secondaryColor: '#d8a446',
    timezone: input.timezone,
    applicationName: 'Neurobot Community',
    headerText: input.botName,
    footerText: '',
    supportInformation: '',
  };
}
