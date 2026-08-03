import type { AssistantProfile, OrganizationType } from '../domain/types.js';

export type ProfilePresetKey =
  | 'community'
  | 'store'
  | 'restaurant'
  | 'distributor'
  | 'service'
  | 'empty';

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
    objective: 'Entregar información oficial sobre la comunidad, sus normas, actividades, horarios y contacto.',
    allowedTopics: ['Presentación', 'Normas', 'Actividades', 'Horarios', 'Contacto', 'Preguntas frecuentes'],
    excludedTopics: ['Diagnósticos', 'Tratamientos', 'Datos personales', 'Acciones administrativas'],
    tone: 'Amable, claro, inclusivo y breve.',
  },
  {
    key: 'store',
    label: 'Tienda',
    organizationType: 'Tienda',
    industry: 'Comercio',
    objective: 'Informar productos, precios, stock oficial, horarios, despachos, pagos, cambios y garantías.',
    allowedTopics: ['Productos', 'Precios', 'Stock oficial', 'Horarios', 'Despachos', 'Pagos', 'Cambios', 'Garantías', 'Contacto'],
    excludedTopics: ['Confirmar compras', 'Realizar cobros', 'Prometer stock', 'Acciones administrativas'],
    tone: 'Cordial, comercial, preciso y breve.',
  },
  {
    key: 'restaurant',
    label: 'Restaurante',
    organizationType: 'Restaurante',
    industry: 'Gastronomía',
    objective: 'Informar menú, precios, horarios, dirección, despacho, pagos y opciones alimentarias oficiales.',
    allowedTopics: ['Menú', 'Precios', 'Horarios', 'Dirección', 'Despacho', 'Pagos', 'Opciones alimentarias', 'Contacto'],
    excludedTopics: ['Confirmar reservas', 'Realizar cobros', 'Garantizar disponibilidad', 'Acciones administrativas'],
    tone: 'Cálido, claro y breve.',
  },
  {
    key: 'distributor',
    label: 'Distribuidora',
    organizationType: 'Distribuidora',
    industry: 'Distribución y venta mayorista',
    objective: 'Informar catálogo, precios, venta mínima, cobertura, despachos, horarios, pagos y contacto comercial.',
    allowedTopics: ['Catálogo', 'Precios', 'Venta mínima', 'Cobertura', 'Despachos', 'Horarios', 'Pagos', 'Contacto'],
    excludedTopics: ['Confirmar pedidos', 'Realizar cobros', 'Prometer stock', 'Acciones administrativas'],
    tone: 'Profesional, preciso y breve.',
  },
  {
    key: 'service',
    label: 'Servicio',
    organizationType: 'Servicio profesional',
    industry: 'Servicios',
    objective: 'Informar servicios, alcance, valores oficiales, horarios, cobertura y contacto.',
    allowedTopics: ['Servicios', 'Alcance', 'Valores', 'Horarios', 'Cobertura', 'Contacto', 'Preguntas frecuentes'],
    excludedTopics: ['Confirmar contrataciones', 'Realizar cobros', 'Asesoría no contratada', 'Acciones administrativas'],
    tone: 'Profesional, cercano y breve.',
  },
  {
    key: 'empty',
    label: 'Perfil vacío',
    organizationType: 'Otro',
    industry: 'Por definir',
    objective: 'Entregar únicamente información oficial configurada por la administración.',
    allowedTopics: ['Información oficial'],
    excludedTopics: ['Acciones administrativas', 'Datos personales', 'Información no confirmada'],
    tone: 'Claro y breve.',
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
    organizationType: preset.organizationType,
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
    organizationType: input.organizationType,
    industry: preset.industry,
    objective: preset.objective,
    allowedTopics: [...preset.allowedTopics],
    excludedTopics: [...preset.excludedTopics],
    tone: preset.tone,
    outOfScopeMessage: outOfScopeMessage(input.preset),
    noInformationMessage: input.preset === 'community'
      ? 'No tengo información confirmada sobre eso. Puedes consultar a la administración.'
      : 'No tengo información confirmada sobre eso. Puedes consultar directamente con la administración.',
    limitMessage: 'Has alcanzado el límite de consultas por ahora. Intenta más tarde.',
    aiErrorMessage: 'El asistente inteligente no está disponible en este momento.',
    medicalMessage: input.preset === 'community'
      ? 'Puedo entregar orientación general, pero no diagnósticos ni indicaciones de tratamiento.'
      : 'Puedo entregar información general, pero no diagnósticos ni indicaciones de tratamiento.',
    mentionPromptMessage: input.preset === 'community'
      ? `Escribe tu pregunta después de llamar a ${input.botName}.`
      : `Escribe tu pregunta después de mencionar a ${input.botName}.`,
    communityGreetingMessage: input.preset === 'community'
      ? '¡Hola! 👋 Soy Neurobot, el asistente de la Comunidad Neurodivergente – Autismo y TDAH. Puedo ayudarte con las normas, los grupos disponibles, las actividades y el funcionamiento de la comunidad. Llámame escribiendo @neurobot seguido de tu pregunta. Respondo una consulta a la vez y no reemplazo la orientación de profesionales.'
      : `¡Hola! Soy ${input.botName}.`,
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

function outOfScopeMessage(preset: ProfilePresetKey): string {
  if (preset === 'store' || preset === 'distributor') {
    return 'Puedo ayudarte con nuestros productos, precios, horarios y servicios.';
  }
  if (preset === 'restaurant') return 'Puedo ayudarte con el menú, precios, horarios y ubicación.';
  if (preset === 'community') return 'Solo puedo responder consultas relacionadas con esta comunidad.';
  return 'Solo puedo responder consultas relacionadas con la información oficial de esta organización.';
}
