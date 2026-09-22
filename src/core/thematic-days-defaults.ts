export const THEMATIC_DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type ThematicDayKey = (typeof THEMATIC_DAY_KEYS)[number];

export type ThematicDaySettings = {
  key: ThematicDayKey;
  enabled: boolean;
  startTime: string;
  durationMinutes: number;
  title: string;
  description: string;
};

export const THEMATIC_DAY_WEEKDAYS: Record<
  ThematicDayKey,
  'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

export const DEFAULT_THEMATIC_DAY_SETTINGS: Record<ThematicDayKey, ThematicDaySettings> = {
  monday: {
    key: 'monday',
    enabled: false,
    startTime: '10:00',
    durationMinutes: 720,
    title: '🐾 Lunes de mascotas',
    description:
      'Comparte una foto, una anécdota o un momento divertido de tu mascota. Participa sólo si te apetece 💜',
  },
  tuesday: {
    key: 'tuesday',
    enabled: false,
    startTime: '18:00',
    durationMinutes: 300,
    title: '🎧 Martes de música',
    description:
      '¿Qué canción tienes en repeat esta semana? Comparte una canción, artista o playlist que te esté acompañando.',
  },
  wednesday: {
    key: 'wednesday',
    enabled: false,
    startTime: '18:00',
    durationMinutes: 300,
    title: '💬 Miércoles de pregunta',
    description:
      'Pregunta de la comunidad: comparte algo sobre tu semana, tus intereses o aquello que te esté haciendo bien. Participar es opcional.',
  },
  thursday: {
    key: 'thursday',
    enabled: false,
    startTime: '18:00',
    durationMinutes: 300,
    title: '🧩 Jueves de stickers',
    description:
      'Comparte tu sticker favorito, el más absurdo que tengas o uno que represente perfectamente tu semana 😂',
  },
  friday: {
    key: 'friday',
    enabled: false,
    startTime: '17:00',
    durationMinutes: 360,
    title: '😂 Viernes de memes',
    description:
      'Comparte un meme que represente tu semana, tu hiperfoco o simplemente algo que te haya hecho reír. Mantengamos el contenido acorde a las reglas.',
  },
  saturday: {
    key: 'saturday',
    enabled: false,
    startTime: '12:00',
    durationMinutes: 600,
    title: '🎨 Sábado de hobbies e hiperfocos',
    description:
      'Gaming, dibujo, programación, plantas, historia, colecciones… comparte aquello que te entusiasma últimamente.',
  },
  sunday: {
    key: 'sunday',
    enabled: false,
    startTime: '19:00',
    durationMinutes: 240,
    title: '🌱 Domingo de pequeños logros',
    description:
      '¿Qué cosa buena, curiosa o importante te pasó esta semana? Puede ser algo grande o muy pequeño. Participa sólo si te apetece.',
  },
};

export function defaultThematicDays(): ThematicDaySettings[] {
  return THEMATIC_DAY_KEYS.map((key) => ({ ...DEFAULT_THEMATIC_DAY_SETTINGS[key] }));
}
