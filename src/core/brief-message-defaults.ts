export const BRIEF_COMMAND_DEFAULTS = [
  {
    name: 'ayuda',
    response:
      '🤖 Comandos disponibles:\n\n!reglas | !grupos | !actividades | !contacto | !administrador\n\nLa información es general y no reemplaza atención profesional.',
    priority: 100,
  },
  {
    name: 'reglas',
    response:
      '📌 Normas de la comunidad\n• Tratar a todos con respeto y empatía.\n• No discriminar, insultar, acosar ni realizar comentarios xenófobos.\n• No compartir datos personales, spam ni publicidad reiterada.\n• Prohibido el contenido sexual, violento, ilegal o inapropiado para menores.\n• La información del grupo no reemplaza atención profesional.\n• Ante un problema, avisa a la administración.',
    priority: 90,
  },
  {
    name: 'bienvenida',
    response:
      '👋 ¡Bienvenido/a a Comunidad Neurodivergente – Autismo y TDAH!\n\nEste es un espacio de respeto, apoyo e inclusión. Participa a tu ritmo.\n\nEscribe !grupos para conocer nuestros espacios y !reglas para leer las normas.',
    priority: 80,
  },
  {
    name: 'grupos',
    response:
      '💬 Puedes unirte a los espacios que sean de tu interés:\n\nAvisos | Conversación General | Sin filtro | Gamer y hobbies | Emergencias y Crisis\n\nParticipa a tu ritmo y solicita los enlaces a la administración.',
    priority: 70,
  },
  {
    name: 'actividades',
    response:
      '📅 Las actividades vigentes se anuncian en los espacios de la comunidad.\n\nConsulta a la administración para conocer las próximas fechas.',
    priority: 60,
  },
  {
    name: 'contacto',
    response:
      'Para consultas o problemas, contacta directamente a una persona administradora del grupo.',
    priority: 50,
  },
  {
    name: 'administrador',
    response:
      'Para recibir ayuda administrativa, contacta directamente a una persona administradora del grupo.',
    priority: 40,
  },
  {
    name: 'emergencias',
    response:
      '🚨 Espacio para compartir información de orientación y apoyo.\n\nNo reemplaza servicios de emergencia ni atención profesional.',
    priority: 30,
  },
] as const;

export const BRIEF_COMMAND_DEFAULTS_BY_NAME: ReadonlyMap<
  string,
  (typeof BRIEF_COMMAND_DEFAULTS)[number]
> = new Map(BRIEF_COMMAND_DEFAULTS.map((command) => [command.name, command]));

export const LEGACY_COMMAND_RESPONSES: Record<string, string> = {
  ayuda:
    'Hola. Soy el asistente de la Comunidad Neurodivergente – Autismo y TDAH. Puedo mostrarte las reglas, información de bienvenida, actividades y formas de contacto. Escribe !reglas, !bienvenida, !actividades o !contacto. Entrego orientación general y no reemplazo la atención de profesionales.',
  reglas:
    'Mantengamos un espacio respetuoso, confidencial e inclusivo. No se permiten ataques personales, diagnósticos a otras personas ni difusión de información privada. Ante un conflicto, contacta a una persona administradora.',
  bienvenida:
    'Te damos la bienvenida a la Comunidad Neurodivergente – Autismo y TDAH. Puedes participar a tu ritmo, hacer preguntas con respeto y revisar las reglas con !reglas.',
  grupos:
    'La información actualizada sobre los grupos de la comunidad es administrada por el equipo humano. Usa !contacto para conocer el canal de consulta configurado.',
  actividades:
    'Las actividades vigentes se publican en los canales definidos por la comunidad. Una persona administradora puede editar esta respuesta desde el panel local.',
  contacto:
    'Para contactar al equipo, revisa la información fijada por la comunidad o consulta a una persona administradora. No publico números personales en el grupo.',
  administrador:
    'Si necesitas ayuda administrativa, contacta de forma respetuosa a una persona administradora del grupo. No publico sus números ni datos personales.',
};

export function messageMetrics(value: string): { characters: number; lines: number } {
  return {
    characters: value.length,
    lines: value === '' ? 0 : value.split(/\r?\n/u).length,
  };
}
