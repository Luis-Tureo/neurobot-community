import type { AutomaticMessageConfiguration } from '../domain/types.js';

export const AUTOMATIC_MESSAGE_TIMEZONE = 'America/Santiago' as const;

export const LEGACY_AUTOMATIC_TEMPLATES = {
  WELCOME:
    '👋 ¡Te damos la bienvenida a Comunidad Neurodivergente – Autismo y TDAH!\n\nEste es un espacio de respeto, apoyo mutuo e inclusión. Puedes participar cuando te sientas cómodo/a. Escribe !reglas para conocer nuestras normas y !ayuda para ver las opciones disponibles.',
  DAILY_RULES:
    '📌 Reglas de la Comunidad Neurodivergente – Autismo y TDAH\n\n1. Mantengamos un trato respetuoso, amable y sin burlas.\n\n2. No se permite discriminación por autismo, TDAH, discapacidad, género, nacionalidad, origen, apariencia, situación económica, religión u otra condición personal.\n\n3. No se permite xenofobia, racismo, discursos de odio, acoso, amenazas ni hostigamiento.\n\n4. No se permite compartir contenido sexual, pornográfico, erótico o explícito.\n\n5. No se permite contenido inapropiado o peligroso para menores de edad.\n\n6. No se permite material con violencia gráfica, crueldad, autolesiones ni instrucciones que puedan poner en riesgo a una persona.\n\n7. No se permite promover drogas, alcohol, armas, desafíos peligrosos ni actividades ilegales.\n\n8. No se permite pedir, publicar o difundir información privada de otras personas, como números, direcciones, fotografías o documentos, sin autorización.\n\n9. No se permiten estafas, cadenas, spam, publicidad reiterada ni enlaces sospechosos.\n\n10. Las consultas de salud reciben solamente orientación general. El grupo y el chatbot no reemplazan la atención médica, psicológica o profesional.\n\n11. Ante un conflicto, evita discutir públicamente y contacta a una persona administradora.\n\n12. Las decisiones de moderación corresponden a los administradores humanos del grupo.\n\nGracias por ayudar a mantener una comunidad segura, respetuosa e inclusiva. 💙',
  GREETING_MONDAY:
    '☀️ ¡Muy buenos días!\n\nComenzamos una nueva semana. Recuerda avanzar a tu propio ritmo, respetar tus tiempos y valorar cada pequeño logro.\n\nQue tengan una excelente semana. 💙',
  GREETING_WEEKDAY:
    '☀️ ¡Muy buenos días!\n\nEsperamos que tengan una jornada tranquila y positiva. Recuerden que cada persona tiene su propio ritmo y que pedir apoyo también está bien.\n\nQue tengan un excelente día. 💙',
  GREETING_FRIDAY:
    '☀️ ¡Muy buenos días!\n\nLlegamos al viernes. Reconozcan todo lo que pudieron avanzar durante la semana, incluso aquello que parezca pequeño.\n\nQue tengan un excelente día y un muy buen fin de semana. 💙',
  GREETING_WEEKEND:
    '☀️ ¡Muy buenos días!\n\nEsperamos que puedan descansar, compartir o dedicar tiempo a aquello que les haga bien.\n\nQue tengan un excelente día. 💙',
} as const;

export const DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION: AutomaticMessageConfiguration = {
  timezone: AUTOMATIC_MESSAGE_TIMEZONE,
  welcome: {
    enabled: false,
    batchWindowSeconds: 5,
    groupSimultaneous: true,
    reconciliationIntervalSeconds: 120,
    template:
      '¡Bienvenido/a, {name}! 👋\n\nTe damos la bienvenida a {communityName}. Este es un espacio de respeto, apoyo e inclusión.\n\nPuedes participar cuando te sientas cómodo/a. Para consultar al asistente, escribe {botAlias} seguido de tu pregunta.',
    includePublicName: true,
    enableRealMention: true,
    unknownNameFallback: 'nuevo/a integrante',
    multipleJoinMode: 'GROUPED',
    maximumGroupedNames: 5,
    sendDelaySeconds: 2,
  },
  dailyGreeting: {
    enabled: false,
    sendTime: '08:00',
    toleranceMinutes: 30,
    templates: {
      monday:
        '☀️ ¡Buenos días!\n\nComienza una nueva semana. Avanza a tu propio ritmo y valora cada pequeño logro.\n\nQue tengan una excelente semana. 💙',
      weekday:
        '☀️ ¡Buenos días!\n\nEsperamos que tengan una jornada tranquila y agradable.\n\nQue tengan un excelente día. 💙',
      friday:
        '☀️ ¡Buenos días!\n\nReconozcan todo lo que pudieron avanzar durante la semana.\n\nQue tengan un excelente día y un buen fin de semana. 💙',
      weekend:
        '☀️ ¡Buenos días!\n\nEsperamos que puedan descansar y dedicar tiempo a lo que les haga bien.\n\nQue tengan un excelente día. 💙',
    },
  },
  dailyRules: {
    enabled: false,
    sendTime: '20:00',
    toleranceMinutes: 30,
    template:
      '📌 Normas de la comunidad\n• Tratar a todos con respeto y empatía.\n• No discriminar, insultar, acosar ni realizar comentarios xenófobos.\n• No compartir datos personales, spam ni publicidad reiterada.\n• Prohibido el contenido sexual, violento, ilegal o inapropiado para menores.\n• La información del grupo no reemplaza atención profesional.\n• Ante un problema, avisa a la administración.',
  },
};

export const AUTOMATIC_TEMPLATE_KEYS = {
  welcome: 'WELCOME',
  dailyRules: 'DAILY_RULES',
  greetingMonday: 'GREETING_MONDAY',
  greetingWeekday: 'GREETING_WEEKDAY',
  greetingFriday: 'GREETING_FRIDAY',
  greetingWeekend: 'GREETING_WEEKEND',
} as const;
